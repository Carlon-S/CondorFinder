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


def trafico_configurado() -> bool:
    """Si el sistema va a INTENTAR calcular con tráfico. Mira solo la
    configuración, así que no dice nada sobre si Google respondió.

    **No es lo que la vista debe mostrar.** Para eso está la bandera `trafico`
    que devuelve `route_tramos()`, que sí sabe qué pasó. Esta función existe
    para decidir a quién preguntarle, y nada más."""
    return _proveedor() == "google" and google_routes_client.disponible()


def unir_tramos(tramos: list[dict]) -> dict:
    """Varios saltos consecutivos en un solo tramo.

    El mapa pinta la ida de un viaje como un trazo continuo aunque sean N
    saltos (uno por parada), así que se concatenan las geometrías y se suman las
    cifras. El primer punto de cada salto repite el último del anterior y se
    descarta, para no dejar vértices duplicados en la línea.

    Vive acá y no en el cliente de Google porque ahora la usan los dos
    proveedores por igual: los dos devuelven un tramo por salto y es `routing.py`
    el que decide qué saltos forman la ida de cada viaje."""
    path: list[list[float]] = []
    for t in tramos:
        # El corte del primer vértice depende de si YA hay trazo acumulado, no
        # de la posición del tramo en la lista: un salto nulo al principio deja
        # el acumulado vacío, y ahí cortarle el primer punto al siguiente
        # perdería el vértice donde empieza el recorrido.
        path.extend(t["path"] if not path else t["path"][1:])
    return {
        "path": path,
        "distanceKm": sum(t["distanceKm"] for t in tramos),
        "durationHours": sum(t["durationHours"] for t in tramos),
    }


async def _saltos_osrm(waypoints: list[tuple[float, float]]) -> dict | None:
    """Un tramo por salto, en UNA sola llamada a OSRM.

    Antes eran tres en paralelo (ida, descarga, regreso), porque la respuesta
    tenía esa forma. Con el recorrido como una secuencia única de waypoints
    alcanza una: `route_geometry` ya devuelve `legs`, un leg por salto, y era
    justamente el dato que la línea de tiempo necesitaba. Menos llamadas y
    menos código que el anterior."""
    ruta = await asyncio.to_thread(osrm_client.route_geometry, list(waypoints))
    if ruta is None:
        return None
    legs = ruta.get("legs") or []
    if len(legs) != len(waypoints) - 1:
        return None
    return {"legs": legs}


async def route_saltos(waypoints: list[tuple[float, float]]) -> dict | None:
    """Un tramo por SALTO del recorrido completo.

    `waypoints` es la secuencia entera, de la base a la base, con el relleno
    repetido una vez por viaje:

        base, z1, z2, relleno, z3, relleno, base

    Devuelve `{"legs": [t, ...], "trafico": bool}` con `len(waypoints) - 1`
    tramos, cada uno con path/distanceKm/durationHours. None si no se pudo
    calcular el recorrido.

    **Agrupar los saltos en viajes NO es asunto de este módulo**: acá solo se
    sabe pedir geometría, y quién sabe dónde cae cada descarga es `routing.py`,
    que es el que decidió el reparto. Antes esta función devolvía tres tramos
    fijos y por lo tanto solo podía expresar un viaje.

    **`trafico` dice lo que PASÓ, no lo que se configuró.** Es False cuando el
    recorrido salió de OSRM, incluso con Google configurado: si la clave falla y
    se usa el respaldo, el plan no tiene tiempos con tráfico y la vista no puede
    decir que sí. Afirmar el ajuste sin haberlo hecho es peor que no ofrecerlo,
    porque la cuadrilla coordinaría horas de llegada creyendo que consideran el
    taco.

    Se llama con el orden YA elegido, una sola vez por sub-ruta aceptada: todas
    las salidas por restricción de _build_subroute ocurren antes, así que el
    bucle de relajación itera sin gastar ni una llamada."""
    if len(waypoints) < 3:
        return None

    if trafico_configurado():
        tramos = await asyncio.to_thread(google_routes_client.route_saltos, list(waypoints))
        if tramos is not None:
            tramos["trafico"] = True
            return tramos
        # Google no respondió (clave mala, cuota agotada, servicio caído). Se
        # cae a OSRM en vez de reintentar: el plan sale con tiempos a flujo
        # libre, que es peor que con tráfico pero infinitamente mejor que dejar
        # a la municipalidad sin poder planificar. Y no se reintenta contra
        # Google porque un reintento automático es el mecanismo por el que el
        # consumo se dispara justo cuando el servicio del otro lado está lento.

    return await _saltos_osrm(waypoints)
