"""
CONDORFINDER, LÍMITE DE PETICIONES
Archivo: backendModel/rate_limit.py

Un tope de peticiones por ventana de tiempo, para los endpoints donde una
repetición descontrolada cuesta algo real.

**Dónde importa y por qué.** No es protección contra fuerza bruta de
contraseñas: desde el inicio de sesión federado no hay contraseña que adivinar.
Importa en otras tres cosas:

- **`/routes/generate` cuesta dinero.** Cada generación es una llamada a la
  Routes API de Google, y la garantía de costo es una cuota diaria de 160
  solicitudes. Un bucle accidental en el navegador la quema en un minuto y deja
  al sistema calculando a flujo libre el resto del día.
- **`/generate` y `/upload` cuestan la máquina.** Son el pipeline de
  fotogrametría, que ocupa la VM entera por decenas de minutos.
- **Los endpoints de inicio de sesión** son el único punto abierto sin sesión, y
  repetirlos golpea al proveedor externo con nuestras credenciales.

**Ventana deslizante en memoria, a propósito.** Se guardan las marcas de tiempo
de las peticiones recientes por clave y se descartan las que ya salieron de la
ventana. Dos consecuencias que hay que conocer antes de confiar en esto:

- **Es por proceso.** Hoy el backend corre en un solo contenedor, así que el
  conteo es exacto. El día que haya dos réplicas, cada una contará por su lado y
  el tope real será el doble. Ahí esto se muda a Mongo o a Redis.
- **Se reinicia con el proceso.** Un `docker compose up` deja los contadores en
  cero. Para lo que protege (costo y uso de máquina) es aceptable; para un
  control de seguridad serio no lo sería.

La alternativa era sumar `slowapi` o similar, y no se hizo: son cuarenta líneas
contra una dependencia nueva, y una dependencia que intercepta cada petición es
algo que hay que mantener actualizado para siempre.
"""

import time
from collections import defaultdict

from fastapi import HTTPException, Request

# clave -> marcas de tiempo dentro de la ventana
_marcas: dict[str, list[float]] = defaultdict(list)
# Se purga el diccionario completo de vez en cuando: sin esto, cada IP que pasó
# una vez por el sistema deja su entrada viva para siempre y la memoria crece
# sin techo.
_ultima_purga = 0.0
_INTERVALO_PURGA = 300


def _clave(request: Request, nombre: str) -> str:
    """Quién es, para efectos del conteo.

    Se prefiere la sesión sobre la IP: una municipalidad entera puede salir por
    una sola IP, y contar por IP le aplicaría a veinte funcionarios el tope de
    uno. La cookie identifica a la persona aunque compartan la salida a
    internet.

    Sin sesión (los endpoints de login), se cae a la IP, que es lo único que
    hay. `X-Forwarded-For` primero porque el backend vive detrás de Caddy y de
    Cloudflare: sin leerla, todas las peticiones parecerían venir del proxy y
    compartirían un solo contador.
    """
    sesion = request.cookies.get("access_token")
    if sesion:
        # El token completo es largo; su cola alcanza para distinguir sesiones y
        # evita dejar credenciales enteras dando vueltas en una estructura en
        # memoria.
        return f"{nombre}:s:{sesion[-32:]}"
    reenviada = request.headers.get("x-forwarded-for", "")
    ip = reenviada.split(",")[0].strip() if reenviada else (request.client.host if request.client else "?")
    return f"{nombre}:ip:{ip}"


def _purgar(ahora: float) -> None:
    global _ultima_purga
    if ahora - _ultima_purga < _INTERVALO_PURGA:
        return
    _ultima_purga = ahora
    for clave in [k for k, v in _marcas.items() if not v or ahora - v[-1] > 3600]:
        _marcas.pop(clave, None)


def limitar(nombre: str, maximo: int, ventana_segundos: int):
    """Una dependencia de FastAPI que corta cuando se pasa del tope.

    Se usa como `dependencies=[Depends(limitar("rutas", 20, 3600))]`, o sea
    antes de que el handler corra: la idea es no gastar la llamada cara, así que
    el corte tiene que ocurrir antes de hacerla.

    Devuelve 429 con `Retry-After`, que es el código que corresponde y lo que
    un cliente bien educado sabe leer para esperar en vez de reintentar.
    """

    async def dependencia(request: Request) -> None:
        ahora = time.time()
        _purgar(ahora)
        clave = _clave(request, nombre)

        recientes = [t for t in _marcas[clave] if ahora - t < ventana_segundos]
        if len(recientes) >= maximo:
            espera = int(ventana_segundos - (ahora - recientes[0])) + 1
            _marcas[clave] = recientes
            raise HTTPException(
                status_code=429,
                detail=f"Demasiadas peticiones. Intenta de nuevo en {espera} segundos.",
                headers={"Retry-After": str(espera)},
            )

        recientes.append(ahora)
        _marcas[clave] = recientes

    return dependencia
