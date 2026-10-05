import asyncio
import os

import google_routes_client
import osrm_client

# =============================================================================
# CONDORFINDER - PROVEEDOR DE GEOMETRÍA DE RUTA (HDU5.1 / AC5)
# Archivo: backendModel/routes_provider.py
#
# Una sola función para pedir los TRES tramos de un recorrido ya decidido, y
# cada proveedor resuelve con las peticiones que necesite. routing.py pregunta
# por tramos; cuántas llamadas HTTP cuesta eso no es asunto suyo.
#
# Antes esa decisión vivía en _build_subroute, que hacía tres
# `route_geometry()` en paralelo. Eso está bien para OSRM (gratis, sin SLA) y
# está mal para Google (se cobra por llamada y `computeRoutes` devuelve los
# tres tramos en una sola petición). Con el proveedor acá, el que sabe cuántas
# llamadas hacen falta es el que sabe cuánto cuesta cada una.
#
# ROUTES_PROVIDER sin definir deja todo en OSRM, que es el estado por omisión.
# Eso es lo que permite apagar AC5 editando el .env sin tocar código, y que el
# sistema siga corriendo en la máquina de cualquiera del equipo sin clave.
#
# La MATRIZ se queda siempre en OSRM (ver _best_stop_order en routing.py):
# `Compute Route Matrix` se cobra por elemento y crece al cuadrado, así que con
# cinco zonas son 49 elementos, o sea 102 generaciones gratis al mes contra
# 5.000. El orden de paradas se sigue eligiendo a flujo libre, que es gratis y
# que el AC5 no pide: el criterio habla de "los tiempos estimados de cada
# tramo", y esos son los que acá pasan a venir con tráfico.
# =============================================================================


def _proveedor() -> str:
    return (os.getenv("ROUTES_PROVIDER") or "osrm").strip().lower()


def con_trafico() -> bool:
    """True si los tiempos del plan van a venir con tráfico. La vista lo usa
    para decirlo en pantalla: el AC5 pide que el ajuste ocurra "sin requerir que
    el trabajador lo indique", y eso solo es comprobable si el trabajador ve que
    está pasando."""
    return _proveedor() == "google" and google_routes_client.disponible()


async def _tramos_osrm(
    origin: tuple[float, float],
    stops: list[tuple[float, float]],
    disposal: tuple[float, float],
) -> dict | None:
    """Tres llamadas en paralelo, que es lo que el sistema hacía hasta ahora.
    En paralelo y no en serie porque son independientes: la latencia es la de
    una sola, no la suma de tres."""
    ultima = stops[-1]
    outbound, descarga, regreso = await asyncio.gather(
        asyncio.to_thread(osrm_client.route_geometry, [origin, *stops]),
        asyncio.to_thread(osrm_client.route_geometry, [ultima, disposal]),
        asyncio.to_thread(osrm_client.route_geometry, [disposal, origin]),
    )
    if outbound is None or descarga is None or regreso is None:
        return None
    return {"outbound": outbound, "disposal": descarga, "return": regreso}


async def route_tramos(
    origin: tuple[float, float],
    stops: list[tuple[float, float]],
    disposal: tuple[float, float],
) -> dict | None:
    """Los tres tramos de `origen -> stops (EN ORDEN) -> relleno -> origen`.

    {"outbound": t, "disposal": t, "return": t}, cada `t` con
    path/distanceKm/durationHours. None si no se pudo calcular el recorrido.

    Se llama con el orden YA elegido, una sola vez por sub-ruta aceptada: todas
    las salidas por restricción de _build_subroute ocurren antes, así que el
    bucle de relajación itera sin gastar ni una llamada."""
    if not stops:
        return None

    if con_trafico():
        tramos = await asyncio.to_thread(
            google_routes_client.route_tramos, origin, stops, disposal
        )
        if tramos is not None:
            return tramos
        # Google no respondió (clave mala, cuota agotada, servicio caído). Se
        # cae a OSRM en vez de reintentar: el plan sale con tiempos a flujo
        # libre, que es peor que con tráfico pero infinitamente mejor que dejar
        # a la municipalidad sin poder planificar. Y no se reintenta contra
        # Google porque un reintento automático es el mecanismo por el que el
        # consumo se dispara justo cuando el servicio del otro lado está lento.

    return await _tramos_osrm(origin, stops, disposal)
