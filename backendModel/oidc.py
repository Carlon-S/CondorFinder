"""
CONDORFINDER, PROTOCOLO OPENID CONNECT
Archivo: backendModel/oidc.py

La mecánica del protocolo contra un emisor externo: armar la URL de
autorización, canjear el código por un `id_token` y verificar ese token.

**Un solo flujo para los dos proveedores.** Microsoft Entra ID y Google hablan
el mismo OpenID Connect, así que lo único que cambia entre ellos es de dónde se
descubren los endpoints, qué credenciales se usan y cómo se valida el emisor.
Escribirlo dos veces habría significado dos lugares donde equivocarse con la
verificación de firma, que es justo la parte que no se puede equivocar.

Vive aparte de `auth.py` a propósito, mismo criterio que separa
`google_routes_client.py` de `routes_provider.py`: acá está el protocolo y allá
la decisión de QUIÉN entra, que es del negocio y cambia por otras razones.

Síncrono con `requests` (ya es dependencia) y el llamador lo envuelve en
`asyncio.to_thread()`, igual que `osrm_client.py`, para no bloquear el bucle de
eventos de FastAPI.
"""

import base64
import hashlib
import os
import secrets
import time
from urllib.parse import urlencode

import jwt
import requests

_TIMEOUT = 10

# =============================================================================
# PROVEEDORES
#
# `issuer_esperado` es None en Microsoft porque su emisor NO es fijo: depende
# del directorio que firmó el token (`https://login.microsoftonline.com/{tid}/v2.0`).
# Esa validación se hace aparte, contra el `tid` del propio token, en
# `verificar_id_token`. Google sí tiene uno fijo.
# =============================================================================

PROVEEDORES: dict[str, dict] = {
    "microsoft": {
        "descubrimiento": "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
        "env_client_id": "MS_CLIENT_ID",
        "env_client_secret": "MS_CLIENT_SECRET",
        "scopes": "openid profile email",
        "issuer_esperado": None,
        "etiqueta": "Microsoft",
    },
    "google": {
        "descubrimiento": "https://accounts.google.com/.well-known/openid-configuration",
        "env_client_id": "GOOGLE_OIDC_CLIENT_ID",
        "env_client_secret": "GOOGLE_OIDC_CLIENT_SECRET",
        "scopes": "openid profile email",
        "issuer_esperado": "https://accounts.google.com",
        "etiqueta": "Google",
    },
}


class ErrorOidc(Exception):
    """Algo salió mal hablando con el emisor o validando lo que devolvió.

    Una sola excepción y no una por caso: el llamador no puede hacer nada
    distinto según el motivo, y el usuario tampoco. Lo que cambia por caso es el
    mensaje, que viaja adentro y termina en el log del servidor.
    """


def client_id(proveedor: str) -> str | None:
    return os.environ.get(PROVEEDORES[proveedor]["env_client_id"]) or None


def _client_secret(proveedor: str) -> str | None:
    return os.environ.get(PROVEEDORES[proveedor]["env_client_secret"]) or None


def configurado(proveedor: str) -> bool:
    """Si este proveedor tiene sus dos credenciales.

    **Las dos juntas**, mismo criterio que `ROUTES_PROVIDER`/`GOOGLE_ROUTES_API_KEY`
    y que las dos variables del mapa: un `.env` a medio llenar no deja el inicio
    de sesión en un estado que nadie quiso, simplemente no ofrece ese botón.
    """
    return proveedor in PROVEEDORES and bool(client_id(proveedor)) and bool(_client_secret(proveedor))


def proveedores_disponibles() -> list[str]:
    return [p for p in PROVEEDORES if configurado(p)]


# =============================================================================
# DESCUBRIMIENTO
#
# El documento de descubrimiento cambia muy de vez en cuando, así que se guarda
# en memoria por una hora. Sin caché, cada inicio de sesión costaría dos
# peticiones extra (el documento y el juego de claves) antes de la primera útil.
# =============================================================================

_cache_descubrimiento: dict[str, tuple[float, dict]] = {}
_cache_jwks: dict[str, jwt.PyJWKClient] = {}
_TTL_DESCUBRIMIENTO = 3600


def _descubrir(proveedor: str) -> dict:
    guardado = _cache_descubrimiento.get(proveedor)
    if guardado and time.time() - guardado[0] < _TTL_DESCUBRIMIENTO:
        return guardado[1]
    try:
        resp = requests.get(PROVEEDORES[proveedor]["descubrimiento"], timeout=_TIMEOUT)
        resp.raise_for_status()
        doc = resp.json()
    except Exception as e:
        raise ErrorOidc(f"No se pudo contactar a {PROVEEDORES[proveedor]['etiqueta']}: {e}")
    _cache_descubrimiento[proveedor] = (time.time(), doc)
    return doc


def _jwks(proveedor: str) -> jwt.PyJWKClient:
    """Cliente del juego de claves públicas del emisor.

    `PyJWKClient` cachea las claves por su cuenta y las vuelve a pedir cuando
    aparece un `kid` desconocido, que es exactamente lo que hace falta: los
    emisores rotan sus claves sin avisar y un caché rígido rompería el inicio de
    sesión el día de la rotación.
    """
    if proveedor not in _cache_jwks:
        _cache_jwks[proveedor] = jwt.PyJWKClient(_descubrir(proveedor)["jwks_uri"])
    return _cache_jwks[proveedor]


# =============================================================================
# PKCE
# =============================================================================

def nuevo_verificador() -> str:
    """El secreto de un solo uso de PKCE.

    Protege contra que alguien que intercepte el código de autorización lo pueda
    canjear: sin el verificador original, el emisor rechaza el canje. El
    estándar lo pide incluso para clientes con secreto, y acá cubre un caso
    concreto: el código viaja en la barra de direcciones y queda en el historial
    del navegador.
    """
    return secrets.token_urlsafe(64)


def desafio_de(verificador: str) -> str:
    digest = hashlib.sha256(verificador.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


# =============================================================================
# FLUJO
# =============================================================================

def url_de_autorizacion(
    proveedor: str,
    redirect_uri: str,
    state: str,
    nonce: str,
    verificador: str,
) -> str:
    doc = _descubrir(proveedor)
    params = {
        "client_id": client_id(proveedor),
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "response_mode": "query",
        "scope": PROVEEDORES[proveedor]["scopes"],
        "state": state,
        "nonce": nonce,
        "code_challenge": desafio_de(verificador),
        "code_challenge_method": "S256",
        # Siempre el selector de cuenta, nunca el inicio de sesión silencioso.
        #
        # Sin esto, el proveedor reutiliza la sesión que ya exista en el
        # navegador y devuelve un token sin preguntar nada. En un computador
        # compartido de la municipalidad eso significa que el segundo
        # funcionario del día entra como el primero, sin enterarse.
        #
        # También vuelve legible el rechazo: con una cuenta de otro directorio
        # ya iniciada, todo el flujo ocurría en redirecciones automáticas y el
        # resultado se veía como un rechazo instantáneo sin motivo aparente.
        "prompt": "select_account",
    }
    return f"{doc['authorization_endpoint']}?{urlencode(params)}"


def canjear_codigo(proveedor: str, codigo: str, redirect_uri: str, verificador: str) -> str:
    """El `id_token` a cambio del código. Devuelve el token crudo, sin verificar.

    El `access_token` que viene en la misma respuesta **se descarta a
    propósito**: este sistema necesita saber QUIÉN es la persona, no actuar en
    su nombre contra ninguna API del proveedor. Guardarlo sería guardar una
    credencial que nadie usa, o sea superficie de ataque a cambio de nada.
    """
    doc = _descubrir(proveedor)
    try:
        resp = requests.post(
            doc["token_endpoint"],
            data={
                "client_id": client_id(proveedor),
                "client_secret": _client_secret(proveedor),
                "code": codigo,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
                "code_verifier": verificador,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=_TIMEOUT,
        )
    except Exception as e:
        raise ErrorOidc(f"No se pudo canjear el código con {PROVEEDORES[proveedor]['etiqueta']}: {e}")

    if resp.status_code != 200:
        # El cuerpo del error trae el motivo real (`invalid_grant`, una
        # redirect_uri que no coincide, un secreto vencido). Va al log del
        # servidor y nunca a la pantalla: son detalles de configuración nuestra,
        # no algo que el usuario pueda resolver.
        raise ErrorOidc(f"El proveedor rechazó el canje ({resp.status_code}): {resp.text[:300]}")

    id_token = resp.json().get("id_token")
    if not id_token:
        raise ErrorOidc("La respuesta del proveedor no trae id_token.")
    return id_token


def verificar_id_token(proveedor: str, id_token: str, nonce_esperado: str) -> dict:
    """Los claims del token, ya verificados. Lanza `ErrorOidc` si algo no cierra.

    **Nada de lo que trae el token se cree antes de este paso.** Un `id_token`
    es texto que llegó por la red: sin verificar la firma, cualquiera podría
    fabricar uno que diga venir de la municipalidad.

    Cuatro comprobaciones, y cada una tapa un ataque distinto:

    - **Firma** contra la clave pública del emisor: que lo haya emitido quien
      dice.
    - **`aud`** igual a nuestro client id: que lo hayan emitido PARA nosotros.
      Sin esto, un token legítimo emitido para otra aplicación del mismo
      proveedor serviría para entrar acá.
    - **`iss`**: que venga del directorio que corresponde. En Microsoft el
      emisor depende del `tid`, así que se arma con el `tid` del propio token y
      se compara contra la plantilla del documento de descubrimiento. Aceptar
      cualquier `iss` dejaría entrar tokens de cualquier organización del mundo.
    - **`nonce`** igual al que mandamos: que sea la respuesta a ESTE inicio de
      sesión y no uno capturado antes.

    `exp` lo verifica PyJWT por omisión.
    """
    esperado = client_id(proveedor)
    try:
        clave = _jwks(proveedor).get_signing_key_from_jwt(id_token)
        claims = jwt.decode(
            id_token,
            clave.key,
            algorithms=["RS256"],
            audience=esperado,
            # El emisor se valida abajo a mano: en Microsoft no es un valor fijo
            # y PyJWT solo sabe compararlo por igualdad.
            options={"verify_iss": False},
        )
    except jwt.PyJWTError as e:
        raise ErrorOidc(f"El token del proveedor no es válido: {e}")

    plantilla = PROVEEDORES[proveedor]["issuer_esperado"]
    if plantilla is None:
        tid = claims.get("tid")
        if not tid:
            raise ErrorOidc("El token no trae el directorio que lo emitió (tid).")
        plantilla = _descubrir(proveedor)["issuer"].replace("{tenantid}", tid)
    if claims.get("iss") != plantilla:
        raise ErrorOidc("El token viene de un emisor que no corresponde.")

    if claims.get("nonce") != nonce_esperado:
        raise ErrorOidc("El token no corresponde a este inicio de sesión.")

    return claims


def correo_de(claims: dict) -> str | None:
    """El correo de la persona, con el respaldo que hace falta.

    `email` es un claim opcional: Entra lo manda solo si la cuenta tiene correo
    configurado y la app pidió el claim. Para cuentas de trabajo
    `preferred_username` es el UPN, que en la práctica es la dirección
    institucional, así que sirve de respaldo. Sin ninguno de los dos no hay con
    qué identificar a la persona y el inicio de sesión no puede continuar.
    """
    correo = claims.get("email") or claims.get("preferred_username")
    return correo.strip().lower() if isinstance(correo, str) and correo.strip() else None
