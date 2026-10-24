import asyncio
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlparse

import jwt
import oidc
from rate_limit import limitar
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pwdlib import PasswordHash
from pydantic import BaseModel
from pymongo import AsyncMongoClient
from pymongo.asynchronous.database import AsyncDatabase

# =============================================================================
# CONDORFINDER — AUTENTICACIÓN
# Archivo: backendModel/auth.py
#
# La sesión es un JWT propio en una cookie httpOnly, y eso NO cambió: lo que
# cambió es cómo se emite esa cookie.
#
# **Antes**: un único usuario `admin` sembrado desde el `.env`, con su
# contraseña comparada contra un hash. Un secreto compartido entre todo el
# equipo, así que el `owner` de cada zona, análisis y recurso era la misma
# cadena para todos y el sistema no podía decir quién hizo qué.
#
# **Ahora**: la identidad la emite un proveedor externo por OpenID Connect
# (`oidc.py`) y acá se decide quién entra. Nadie escribe una contraseña en este
# sistema, así que no hay ninguna que robar, filtrar ni rotar.
#
# Este módulo tiene la decisión de NEGOCIO (quién entra) y `oidc.py` el
# protocolo. Esa separación es la que permite leer la política de acceso sin
# tener que entender PKCE.
#
# El cliente de Mongo se crea en el lifespan de orquestador.py y se inyecta
# aquí vía set_db(), en vez de que este módulo abra su propia conexión — un
# solo cliente para todo el proceso.
# =============================================================================

COOKIE_NAME = "access_token"
JWT_ALGORITHM = "HS256"
# Cookie efímera donde viven `state`, `nonce`, el verificador de PKCE y a dónde
# volver. Existe solo entre la salida hacia el proveedor y el regreso.
COOKIE_FLUJO = "oidc_flow"
_FLUJO_MAX_AGE = 600

password_hash = PasswordHash.recommended()

_db: AsyncDatabase | None = None


def set_db(db: AsyncDatabase) -> None:
    global _db
    _db = db


def get_db() -> AsyncDatabase:
    if _db is None:
        raise RuntimeError("La base de datos no fue inicializada — set_db() debe llamarse en el lifespan.")
    return _db


# =============================================================================
# MODELOS
#
# Pydantic valida el TIPO de cada campo antes de que el valor llegue a tocar
# una query de Mongo — un payload tipo {"username": {"$ne": null}} se
# rechaza aquí con 422 porque {"$ne": null} no es un str, nunca llega a
# construirse como filtro de búsqueda. Esto es lo que efectivamente bloquea
# la inyección estilo NoSQL en este endpoint, no una sanitización aparte.
# =============================================================================

class LoginRequest(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    """Quién está usando el sistema.

    `username` conserva su nombre aunque ahora lleve un correo. Ese campo
    alimenta el `owner` de cada análisis, zona y recurso en ocho lugares del
    backend más el sidebar; renombrarlo a `email` es churn mecánico con riesgo
    real y cero beneficio funcional. Queda anotado como limpieza posterior.

    `name` es el nombre para mostrar que entrega el proveedor. Opcional porque
    un usuario sembrado con contraseña (desarrollo local) no tiene ninguno.
    """
    username: str
    name: str | None = None


# =============================================================================
# CONTRASEÑAS
# =============================================================================

def hash_password(plain: str) -> str:
    return password_hash.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return password_hash.verify(plain, hashed)


# =============================================================================
# JWT
# =============================================================================

def _jwt_secret() -> str:
    secret = os.environ.get("JWT_SECRET")
    if not secret:
        raise RuntimeError("JWT_SECRET no está seteado en el entorno (ver .env.example).")
    return secret


def _jwt_expire_minutes() -> int:
    return int(os.environ.get("JWT_EXPIRE_MINUTES", "480"))


def create_access_token(username: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=_jwt_expire_minutes())
    payload = {"sub": username, "exp": expire}
    return jwt.encode(payload, _jwt_secret(), algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> str:
    """Devuelve el username (claim "sub") o lanza jwt.PyJWTError si el token
    es inválido/expiró — el caller (get_current_user) traduce eso a 401."""
    payload = jwt.decode(token, _jwt_secret(), algorithms=[JWT_ALGORITHM])
    return payload["sub"]


# =============================================================================
# DEPENDENCY: usuario actual a partir de la cookie
# =============================================================================

async def get_current_user(request: Request) -> UserOut:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="No autenticado")

    try:
        username = decode_access_token(token)
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Sesión inválida o expirada")

    # Query como diccionario tipado, nunca por concatenación de strings.
    #
    # Y se consulta en CADA request, no solo al emitir el token: es lo que hace
    # que quitar a alguien de la colección le corte la sesión en el acto, sin
    # esperar a que su JWT expire. Sin esta consulta, revocar un acceso tomaría
    # hasta las ocho horas de vida del token.
    user = await get_db().users.find_one({"username": username})
    if not user:
        raise HTTPException(status_code=401, detail="Usuario no encontrado")

    return UserOut(username=user["username"], name=user.get("name"))


# =============================================================================
# SEED: usuario admin único, para pruebas
# =============================================================================

async def seed_admin_user(db: AsyncDatabase) -> None:
    # Atado a la misma bandera que el endpoint: sin login por contraseña, un
    # usuario con contraseña sembrado es un registro que nadie puede usar y que
    # igual aparece en la colección como si fuera una cuenta válida.
    if not _password_habilitado():
        return

    admin_username = os.environ.get("SEED_ADMIN_USERNAME")
    admin_password = os.environ.get("SEED_ADMIN_PASSWORD")

    if not admin_username or not admin_password:
        print("[auth] SEED_ADMIN_USERNAME/SEED_ADMIN_PASSWORD no seteados — no se siembra ningún usuario.")
        return

    existing = await db.users.find_one({"username": admin_username})
    if existing:
        return

    await db.users.insert_one({
        "username": admin_username,
        "password_hash": hash_password(admin_password),
        "created_at": datetime.now(timezone.utc),
    })
    print(f"[auth] Usuario admin '{admin_username}' sembrado.")


# =============================================================================
# ENDPOINTS
# =============================================================================

router = APIRouter(prefix="/auth", tags=["auth"])


# COOKIE_SECURE=true en el .env de la VM (nunca en local): el frontend
# desplegado en Cloudflare Workers no pasa por el proxy same-origin del
# dev server de Vite, así que estos fetches son cross-origin de verdad —
# necesitan secure=True + samesite="none" para que el navegador reenvíe la
# cookie. En local (sin la variable), sigue en secure=False + samesite=
# "lax": ahí todo sigue siendo same-origin vía el proxy, y secure=True
# rompería el login porque el backend local es HTTP plano (los navegadores
# descartan cookies Secure seteadas fuera de una conexión HTTPS).
_COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() == "true"
_COOKIE_SAMESITE = "none" if _COOKIE_SECURE else "lax"
# COOKIE_DOMAIN (ej. ".condorfinder.cl"): sin esto, la cookie queda scoped
# exactamente al host que la setea (api.condorfinder.cl) y el navegador
# nunca la manda en un request a condorfinder.cl (dominio hermano, no el
# mismo host) — el login "funcionaba" pero el redirect a "/" nunca veía
# sesión. None por defecto (no seteás esto en local): ahí no hace falta,
# es el mismo host vía el proxy de Vite.
_COOKIE_DOMAIN = os.environ.get("COOKIE_DOMAIN")


def _set_auth_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        secure=_COOKIE_SECURE,
        samesite=_COOKIE_SAMESITE,
        domain=_COOKIE_DOMAIN,
        path="/",
        max_age=_jwt_expire_minutes() * 60,
    )


# =============================================================================
# LOGIN POR CONTRASEÑA, APAGADO POR OMISIÓN
#
# Sobrevive solo detrás de ALLOW_PASSWORD_LOGIN, que NO se define en la VM. Sin
# la variable el endpoint devuelve 404 y el secreto compartido deja de existir
# como superficie: no hay contraseña que adivinar, filtrar ni rotar, y por eso
# tampoco hace falta limitar intentos.
#
# No se borró del todo por una razón concreta: deja el proyecto levantable en la
# máquina de cualquiera del equipo sin credenciales de Azure ni de Google, y
# deja una entrada si un día el proveedor externo no responde. Es un camino
# consciente y acotado a desarrollo, no un portón olvidado.
# =============================================================================

def _password_habilitado() -> bool:
    return os.environ.get("ALLOW_PASSWORD_LOGIN", "false").lower() == "true"


@router.post(
    "/login",
    response_model=UserOut,
    dependencies=[Depends(limitar("login-password", 10, 900))],
)
async def login(credentials: LoginRequest, response: Response):
    if not _password_habilitado():
        raise HTTPException(status_code=404, detail="No encontrado")

    user = await get_db().users.find_one({"username": credentials.username})
    if not user or not user.get("password_hash") or not verify_password(
        credentials.password, user["password_hash"]
    ):
        raise HTTPException(status_code=401, detail="Usuario o contraseña incorrectos")

    token = create_access_token(user["username"])
    _set_auth_cookie(response, token)
    return UserOut(username=user["username"], name=user.get("name"))


@router.post("/logout")
async def logout(response: Response):
    # Debe llevar los mismos atributos con los que se seteó (path/samesite/
    # secure), si no el browser no la reconoce como la misma cookie y no la
    # borra -- delete_cookie() default secure=False, que no calzaba con el
    # secure=True de _set_auth_cookie en producción.
    response.delete_cookie(
        key=COOKIE_NAME, path="/", samesite=_COOKIE_SAMESITE, domain=_COOKIE_DOMAIN, secure=_COOKIE_SECURE
    )
    return {"message": "Sesión cerrada"}


@router.get("/me", response_model=UserOut)
async def me(current_user: UserOut = Depends(get_current_user)):
    return current_user


# =============================================================================
# INICIO DE SESIÓN FEDERADO
#
# Quién entra, y por qué está escrito así:
#
#   microsoft → el `tid` del token está en AUTH_MS_TENANTS
#   google    → el correo está en AUTH_EMAILS_PERMITIDOS
#
# **El cliente entra por su DIRECTORIO, no por una lista de correos.** Un
# funcionario nuevo de la municipalidad entra el día que su TI le crea la
# cuenta, y deja de entrar el día que se la cierran, sin que nadie toque este
# archivo. Una lista de direcciones no tiene esa propiedad: habría que
# mantenerla a mano y nadie se acuerda de sacar a quien se fue.
#
# Google va por lista porque ahí no hay directorio que signifique nada: aceptar
# "cualquier cuenta de Google" sería aceptar a todo el planeta. Es la puerta del
# equipo de desarrollo y por eso es nominal.
#
# AUTH_MS_TENANTS es una LISTA y una variable de entorno, no una constante, y
# eso es deliberado: permite apuntarla a otro directorio (el de la universidad,
# por ejemplo) para recorrer el flujo completo con una cuenta propia antes de
# tener una del cliente. El código que se ejecuta es el mismo; lo único que
# cambia es contra qué GUID compara.
# =============================================================================

def _lista_env(nombre: str) -> list[str]:
    return [x.strip().lower() for x in os.environ.get(nombre, "").split(",") if x.strip()]


def _app_url() -> str:
    """A dónde vuelve el navegador cuando el proveedor termina.

    En producción es el dominio del frontend, que NO es el de este backend. En
    local, sin la variable, es el dev server de Vite, que proxyea `/auth` hacia
    acá (ver vite.config.ts), así que todo queda en el mismo origen.
    """
    return os.environ.get("PUBLIC_APP_URL", "http://localhost:8080").rstrip("/")


def _redirect_uri(request: Request, proveedor: str) -> str:
    """La URI de retorno. Tiene que coincidir EXACTA con la registrada en la consola.

    Manda `PUBLIC_BASE_URL` y solo se cae al origen de la petición cuando no
    está definida, que es el caso de desarrollo local.

    No se deriva del request en la VM porque ahí sale mal: uvicorn solo hace
    caso a `X-Forwarded-Proto` cuando viene de `127.0.0.1`, y Caddy llega desde
    la red interna de compose, así que `request.base_url` dice `http` sobre un
    sitio que es `https`. El proveedor rechazaría el canje por una URI que no
    coincide, y el error llega como un `redirect_uri_mismatch` que no nombra el
    esquema. Que la variable ya exista y ya esté puesta en la VM hace que esto
    no agregue configuración nueva.
    """
    base = os.environ.get("PUBLIC_BASE_URL") or str(request.base_url)
    return f"{base.rstrip('/')}/auth/oidc/{proveedor}/callback"


def _destino_seguro(destino: str | None) -> str:
    """Normaliza a dónde volver después de entrar.

    **Solo rutas internas.** Si no empieza con una sola barra, se descarta y se
    vuelve a la raíz. Sin esta comprobación, `?redirect=https://otro-sitio` haría
    que nuestro propio login mande al usuario a un sitio ajeno justo después de
    autenticarse, que es el patrón clásico de redirección abierta usado para
    phishing. El `//` se rechaza porque el navegador lo lee como un host.
    """
    if not destino or not destino.startswith("/") or destino.startswith("//"):
        return "/"
    return destino


def _volver_con_error(motivo: str) -> RedirectResponse:
    """De vuelta al login con un mensaje, nunca a una pantalla en blanco.

    El motivo viaja en la query porque este regreso es una navegación del
    navegador, no un `fetch`: no hay cuerpo de respuesta que la vista pueda
    leer.
    """
    destino = f"{_app_url()}/login?{urlencode({'error': motivo})}"
    return RedirectResponse(destino, status_code=303)


async def _autorizar(proveedor: str, claims: dict) -> str:
    """El correo de quien entra, o lanza HTTPException si no corresponde."""
    correo = oidc.correo_de(claims)
    if not correo:
        raise HTTPException(status_code=403, detail="sin-correo")

    if proveedor == "microsoft":
        permitidos = _lista_env("AUTH_MS_TENANTS")
        tid = (claims.get("tid") or "").lower()
        if not permitidos or tid not in permitidos:
            raise HTTPException(status_code=403, detail="organizacion-no-autorizada")
        return correo

    if correo not in _lista_env("AUTH_EMAILS_PERMITIDOS"):
        raise HTTPException(status_code=403, detail="cuenta-no-autorizada")
    return correo


async def _registrar_usuario(correo: str, proveedor: str, claims: dict) -> dict:
    """Crea o actualiza al usuario, y devuelve su documento.

    El alta es automática: quien pasa la regla de acceso ya demostró pertenecer
    a la organización del cliente, así que pedirle además que un administrador
    lo dé de alta a mano sería trabajo manual que no agrega ninguna garantía.

    Se guarda el `oid` (el identificador estable que asigna el proveedor) además
    del correo, porque el correo puede cambiar cuando alguien se casa o cambia
    de apellido y el `oid` no. Hoy no se usa para buscar; está para el día que
    haya que reconciliar una identidad renombrada.
    """
    ahora = datetime.now(timezone.utc)
    await get_db().users.update_one(
        {"username": correo},
        {
            "$set": {
                "name": claims.get("name"),
                "proveedor": proveedor,
                "oid": claims.get("oid") or claims.get("sub"),
                "tid": claims.get("tid"),
                "last_login": ahora,
            },
            "$setOnInsert": {"username": correo, "created_at": ahora},
        },
        upsert=True,
    )
    return await get_db().users.find_one({"username": correo})


@router.get("/proveedores")
async def proveedores():
    """Con qué proveedores se puede entrar hoy.

    La vista de login lo consulta para no ofrecer un botón que lleve a un error:
    sin credenciales configuradas, ese proveedor simplemente no se muestra.
    """
    return {
        "proveedores": oidc.proveedores_disponibles(),
        "password": _password_habilitado(),
    }


# Es el unico punto abierto sin sesion, y cada peticion golpea al proveedor
# externo con nuestras credenciales. 20 por hora y por IP deja de sobra para
# equivocarse de cuenta varias veces seguidas.
@router.get("/oidc/{proveedor}/start", dependencies=[Depends(limitar("login", 20, 3600))])
async def oidc_start(proveedor: str, request: Request, redirect: str | None = None):
    if not oidc.configurado(proveedor):
        return _volver_con_error("proveedor-no-configurado")

    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verificador = oidc.nuevo_verificador()

    try:
        destino = await asyncio.to_thread(
            oidc.url_de_autorizacion,
            proveedor,
            _redirect_uri(request, proveedor),
            state,
            nonce,
            verificador,
        )
    except oidc.ErrorOidc as e:
        print(f"[auth] No se pudo armar la autorización de {proveedor}: {e}")
        return _volver_con_error("proveedor-no-disponible")

    respuesta = RedirectResponse(destino, status_code=303)
    # Todo el estado del flujo en una cookie efímera, en vez de en memoria del
    # proceso o en Mongo. Dos motivos: sobrevive a un reinicio del backend a
    # mitad de un inicio de sesión, y no deja basura que alguien tenga que
    # limpiar cuando una persona abandona el flujo a medias (que es lo normal).
    #
    # samesite="lax" y no "none": esta cookie solo la lee el callback, que corre
    # en el MISMO host que la emitió, y lax igual viaja en la navegación de
    # vuelta desde el proveedor porque es un GET de nivel superior. Es la opción
    # más estrecha que funciona.
    respuesta.set_cookie(
        key=COOKIE_FLUJO,
        value=json.dumps(
            {"p": proveedor, "s": state, "n": nonce, "v": verificador, "r": _destino_seguro(redirect)}
        ),
        httponly=True,
        secure=_COOKIE_SECURE,
        samesite="lax",
        path="/",
        max_age=_FLUJO_MAX_AGE,
    )
    return respuesta


@router.get("/oidc/{proveedor}/callback")
async def oidc_callback(
    proveedor: str,
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    if error:
        # El usuario canceló, o el proveedor se negó (típicamente porque la
        # organización exige aprobación de un administrador).
        print(f"[auth] {proveedor} devolvió error: {error}")
        return _volver_con_error("proveedor-rechazo")

    crudo = request.cookies.get(COOKIE_FLUJO)
    if not crudo:
        return _volver_con_error("sesion-expirada")
    try:
        flujo = json.loads(crudo)
    except ValueError:
        return _volver_con_error("sesion-expirada")

    # `state` es lo único que impide que alguien dispare un callback fabricado
    # desde otro sitio y deje una sesión ajena iniciada en este navegador (CSRF
    # de inicio de sesión). Se compara en tiempo constante por costumbre, no
    # porque acá el tiempo filtre algo útil.
    if not code or not state or not secrets.compare_digest(state, flujo.get("s", "")):
        return _volver_con_error("estado-invalido")
    if flujo.get("p") != proveedor:
        return _volver_con_error("estado-invalido")

    try:
        id_token = await asyncio.to_thread(
            oidc.canjear_codigo, proveedor, code, _redirect_uri(request, proveedor), flujo["v"]
        )
        claims = await asyncio.to_thread(oidc.verificar_id_token, proveedor, id_token, flujo["n"])
    except oidc.ErrorOidc as e:
        print(f"[auth] Falló el inicio de sesión con {proveedor}: {e}")
        return _volver_con_error("token-invalido")

    try:
        correo = await _autorizar(proveedor, claims)
    except HTTPException as e:
        return _volver_con_error(str(e.detail))

    await _registrar_usuario(correo, proveedor, claims)

    respuesta = RedirectResponse(f"{_app_url()}{_destino_seguro(flujo.get('r'))}", status_code=303)
    _set_auth_cookie(respuesta, create_access_token(correo))
    # La cookie del flujo ya cumplió: dejarla viva sería dejar un verificador de
    # PKCE usable en el navegador sin ninguna razón.
    respuesta.delete_cookie(key=COOKIE_FLUJO, path="/", samesite="lax", secure=_COOKIE_SECURE)
    return respuesta
