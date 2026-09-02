import asyncio
import itertools
import re
from math import asin, cos, radians, sin, sqrt

from bson import ObjectId
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from pymongo.asynchronous.database import AsyncDatabase
from pyproj import Transformer

import auth as auth_module
import osrm_client

# =============================================================================
# CONDORFINDER — GENERACIÓN DE RUTA ÓPTIMA (HDU5)
# Archivo: backendModel/routing.py
#
# POST /routes/generate resuelve la capacidad REAL de los puntos activos y
# los basurales reales de los análisis elegidos contra Mongo (el frontend
# solo manda IDs — nunca los datos en sí), arma la ruta real (OSRM, ver
# osrm_client.py) y devuelve la respuesta con la forma exacta que
# src/lib/routePlan.ts espera.
#
# Decisiones de modelo, ya conversadas y cerradas con el equipo antes de
# implementar (no re-litigar sin volver a hablarlo):
#   - Capacidad de la ruta = SOLO camiones (`trucks[].capacity_m3`) de los
#     puntos activos. Las tolvas quedan fijas en el punto (acopio local, no
#     son una unidad de transporte) — no participan del cálculo de
#     capacidad ni de la ruta. `retroexcavadoras_count`/`personal_count`
#     tampoco son una restricción hoy (sin AC que lo pida explícitamente).
#   - Un stop de ruta = un ANÁLISIS cargado (no una detección individual):
#     la ubicación es `orthoCenter` (huella real del ortomosaico, estable
#     entre corridas — mismo criterio que ya usa /rutas.tsx para el círculo
#     de zona) y el volumen es la suma de `volume_m3` de todas sus
#     detecciones. Visitar cada detección por separado no tiene sentido
#     operacional: son puntos casi superpuestos dentro de la misma zona.
#   - Si ningún punto activo por sí solo cubre el volumen total, se prueba
#     con combinaciones de 2+ puntos (mochila por tamaño creciente) y se
#     reparte cada zona al punto más cercano dentro del grupo elegido
#     (con rebalanceo si algún punto queda sobrecargado) — cada punto
#     resultante arma su PROPIA ida+vuelta independiente (una cuadrilla por
#     patio, no una ruta fusionada entre depósitos distintos).
#   - Ida a velocidad normal, vuelta más lenta (camiones cargados) —
#     _RETURN_SPEED_FACTOR abajo. El tiempo total del plan (para el chequeo
#     contra availableHours y lo que se muestra) asume que las
#     sub-rutas de distintos puntos corren en PARALELO (cuadrillas
#     distintas saliendo a la vez), así que se usa el máximo entre
#     sub-rutas, no la suma.
#
# `priorityWasteType` queda en el contrato (AC1 lo pide en la confirmación)
# pero no cambia el orden de paradas hoy: el algoritmo visita TODAS las
# zonas cargadas siempre (no hay modo "parcial" que priorizar entre ellas)
# — se deja reservado para cuando eso exista.
#
# Los modelos de acá abajo usan nombres de campo en camelCase (no el
# snake_case habitual en Python) A PROPÓSITO: src/lib/routePlan.ts interpreta
# la respuesta tal cual llega, sin traducir nombres.
# =============================================================================

_db: AsyncDatabase | None = None


def set_db(db: AsyncDatabase) -> None:
    global _db
    _db = db


def get_db() -> AsyncDatabase:
    if _db is None:
        raise RuntimeError("La base de datos no fue inicializada — set_db() debe llamarse en el lifespan.")
    return _db


# =============================================================================
# MODELOS — mismo shape que src/lib/routePlan.ts
# =============================================================================

class RoutePlanRequestIn(BaseModel):
    analysisIds: list[str]
    activePointIds: list[str]
    availableHours: float
    priorityWasteType: str | None = None


class RoutePlanStopOut(BaseModel):
    order: int
    lat: float
    lng: float
    label: str


class RouteSegmentOut(BaseModel):
    """Un resumen por sub-ruta/punto de origen usado — mismo índice que
    outboundPaths[i]/returnPaths[i] abajo, para que el frontend pueda
    mostrar la ventana flotante de cada tramo (estilo Google Maps: camiones
    usados, tiempo, distancia, velocidad — la velocidad la calcula el
    frontend como distancia/tiempo, no hace falta mandarla aparte)."""
    originName: str
    trucksUsed: int
    outboundDistanceKm: float
    outboundDurationHours: float
    returnDistanceKm: float
    returnDurationHours: float


class RoutePlanRouteOut(BaseModel):
    stops: list[RoutePlanStopOut]
    totalDistanceKm: float | None = None
    totalDurationHours: float | None = None
    # Un trazo (lista de [lat, lng]) por sub-ruta/punto de origen usado —
    # casi siempre uno solo. Separados en ida/vuelta para que el frontend
    # los pinte con estilos distintos (ver GeoMapImpl.tsx).
    outboundPaths: list[list[list[float]]] = []
    returnPaths: list[list[list[float]]] = []
    segments: list[RouteSegmentOut] = []


class RoutePlanSuccessOut(BaseModel):
    status: str = "success"
    route: RoutePlanRouteOut


class RoutePlanInfeasibleOut(BaseModel):
    status: str = "infeasible"
    message: str


# =============================================================================
# REPROYECCIÓN UTM → WGS84 (orthoCenter viene en el CRS proyectado del
# ortomosaico, ej. "EPSG:32719" — OSRM y los puntos de HDU6 necesitan
# WGS84). Mismo patrón de reconocimiento de zona UTM que
# src/lib/projection.ts (326xx = norte, 327xx = sur), replicado acá porque
# esta conversión corre en el backend (para llamar a OSRM), no en Leaflet.
# =============================================================================

_UTM_CRS_PATTERN = re.compile(r"^EPSG:(326|327)(\d{2})$")
_transformer_cache: dict[str, Transformer] = {}


def _utm_to_wgs84(x: float, y: float, crs: str) -> tuple[float, float] | None:
    crs_norm = crs.strip().upper()
    if not _UTM_CRS_PATTERN.match(crs_norm):
        return None
    if crs_norm not in _transformer_cache:
        _transformer_cache[crs_norm] = Transformer.from_crs(crs_norm, "EPSG:4326", always_xy=True)
    lng, lat = _transformer_cache[crs_norm].transform(x, y)
    return (lat, lng)


def _format_number(value: float) -> str:
    """"1.0" -> "1", "1.5" -> "1.5", "20.0" -> "20" — para cualquier número
    (horas, m³) que se muestre en un mensaje de texto al usuario. `:g`
    recorta ceros decimales sobrantes sin redondear de forma rara los casos
    con decimales reales. Los campos numéricos de la respuesta JSON
    (totalDistanceKm/totalDurationHours) NO pasan por acá — son datos, el
    frontend decide cómo formatearlos para mostrar."""
    return f"{round(value, 2):g}"


def _haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distancia en línea recta (metros) — SOLO para heurísticas baratas
    (ordenar candidatos, repartir zonas entre puntos) antes de pedirle a
    OSRM la distancia real por calles del resultado final. Nunca se le
    muestra esto al usuario como si fuera la distancia real de la ruta."""
    lat1, lng1 = a
    lat2, lng2 = b
    r = 6371000.0
    p1, p2 = radians(lat1), radians(lat2)
    dphi = radians(lat2 - lat1)
    dlambda = radians(lng2 - lng1)
    h = sin(dphi / 2) ** 2 + cos(p1) * cos(p2) * sin(dlambda / 2) ** 2
    return 2 * r * asin(sqrt(h))


# =============================================================================
# PUENTE DE ENTRADA — puntos activos (capacidad real de camiones)
# =============================================================================

async def _load_active_points(point_ids: list[str]) -> list[dict]:
    """Trae de Mongo los puntos de `point_ids`, filtrando además por
    `active: True` server-side (la lista del frontend pudo quedar vieja).
    IDs con formato inválido se descartan en vez de tirar un 500."""
    valid_ids: list[ObjectId] = []
    for pid in point_ids:
        try:
            valid_ids.append(ObjectId(pid))
        except Exception:
            continue
    if not valid_ids:
        return []
    return await get_db().resource_points.find(
        {"_id": {"$in": valid_ids}, "active": True}
    ).to_list(length=None)


def _point_truck_capacity(point: dict) -> float:
    return sum(t.get("capacity_m3", 0) for t in point.get("trucks", []))


def _min_trucks_used(point: dict, assigned_volume: float) -> int:
    """Cantidad MÍNIMA de camiones de `point` que hacen falta para cubrir
    `assigned_volume` — heurística voraz (los más grandes primero), no una
    combinación óptima exacta, pero es lo que se muestra en la ventana
    flotante de la ruta ("camiones usados") y no hace falta más precisión
    que esa para ese propósito. Con al menos un camión y una parada, el
    mínimo es 1 aunque el volumen asignado sea 0 (igual hay que despachar
    un camión para hacer el viaje)."""
    caps = sorted((t.get("capacity_m3", 0) for t in point.get("trucks", [])), reverse=True)
    if not caps:
        return 0
    if assigned_volume <= 0:
        return 1
    total = 0.0
    count = 0
    for c in caps:
        count += 1
        total += c
        if total >= assigned_volume:
            break
    return count


# =============================================================================
# PUENTE DE ENTRADA — basurales reales de los análisis guardados elegidos
# =============================================================================

async def _load_route_stops(analysis_ids: list[str]) -> list[dict]:
    """Un stop por ANÁLISIS cargado (no por detección) — ubicación =
    orthoCenter reproyectado a WGS84, volumen = suma de volume_m3 de todas
    sus detecciones. Análisis sin crs/orthoCenter, o cuyo CRS no se puede
    reproyectar, se omiten (no hay forma de ubicarlos en una ruta real)."""
    valid_ids: list[ObjectId] = []
    for aid in analysis_ids:
        try:
            valid_ids.append(ObjectId(aid))
        except Exception:
            continue
    if not valid_ids:
        return []

    docs = await get_db().analyses.find({"_id": {"$in": valid_ids}}).to_list(length=None)

    stops: list[dict] = []
    for doc in docs:
        crs = doc.get("crs")
        center = doc.get("orthoCenter")
        if not crs or not center or len(center) != 2:
            continue
        latlng = _utm_to_wgs84(center[0], center[1], crs)
        if latlng is None:
            continue
        lat, lng = latlng
        total_volume = sum((d.get("volume_m3") or 0) for d in doc.get("detections", []))
        stops.append({
            "analysisId": str(doc["_id"]),
            "name": doc.get("name") or "Zona sin nombre",
            "lat": lat,
            "lng": lng,
            "volumeM3": total_volume,
        })
    return stops


# =============================================================================
# SELECCIÓN DE ORIGEN(ES) — "mochila" de puntos por capacidad de camiones
# =============================================================================

def _select_origin_group(points: list[dict], total_volume: float) -> list[dict] | None:
    """Elige el subconjunto MÁS CHICO de puntos activos (ya ordenados por
    cercanía a las zonas, ver caller) cuya capacidad de camiones cubre
    `total_volume`. Prueba tamaños crecientes (1, 2, 3, ...) — con la
    cantidad de puntos que maneja este proyecto (unos pocos), fuerza bruta
    sobre itertools.combinations es instantánea."""
    candidates = [p for p in points if _point_truck_capacity(p) > 0]
    if not candidates:
        return None
    for size in range(1, len(candidates) + 1):
        for combo in itertools.combinations(candidates, size):
            if sum(_point_truck_capacity(p) for p in combo) >= total_volume:
                return list(combo)
    return None


def _split_stops_by_nearest(points: list[dict], stops: list[dict]) -> dict[str, list[dict]]:
    """Reparte cada zona al punto más cercano (línea recta) dentro del
    grupo elegido, con un rebalanceo simple: si un punto queda con más
    volumen asignado del que sus camiones soportan, mueve su zona más
    lejana al siguiente punto con margen — hasta que todos calcen o no
    quede movimiento posible (caller trata cada sub-grupo restante por su
    cuenta, _build_subroute vuelve a fallar si de verdad no alcanza)."""
    assignment: dict[str, list[dict]] = {str(p["_id"]): [] for p in points}
    for s in stops:
        nearest = min(points, key=lambda p: _haversine((p["lat"], p["lng"]), (s["lat"], s["lng"])))
        assignment[str(nearest["_id"])].append(s)

    capacity = {str(p["_id"]): _point_truck_capacity(p) for p in points}

    def volume_of(pid: str) -> float:
        return sum(s["volumeM3"] for s in assignment[pid])

    changed = True
    while changed:
        changed = False
        for p in points:
            pid = str(p["_id"])
            if volume_of(pid) <= capacity[pid]:
                continue
            overloaded_stops = sorted(
                assignment[pid],
                key=lambda s: -_haversine((p["lat"], p["lng"]), (s["lat"], s["lng"])),
            )
            for s in overloaded_stops:
                for other in sorted(points, key=lambda o: _haversine((o["lat"], o["lng"]), (s["lat"], s["lng"]))):
                    oid = str(other["_id"])
                    if oid == pid or volume_of(oid) + s["volumeM3"] > capacity[oid]:
                        continue
                    assignment[pid].remove(s)
                    assignment[oid].append(s)
                    changed = True
                    break
                if changed:
                    break
            if changed:
                break
    return assignment


# =============================================================================
# ORDEN DE PARADAS (TSP acotado) + GEOMETRÍA REAL POR SUB-RUTA
# =============================================================================

_RETURN_SPEED_FACTOR = 0.85  # camiones cargados de vuelta ≈ 85% de la velocidad de ida
_MAX_STOPS_BRUTE_FORCE = 8  # 8! = 40320 permutaciones, instantáneo


async def _best_stop_order(
    origin: tuple[float, float], stop_coords: list[tuple[float, float]]
) -> tuple[list[int], float, float] | None:
    """Evalúa todas las permutaciones de `stop_coords` (fuerza bruta hasta
    _MAX_STOPS_BRUTE_FORCE, vecino-más-cercano por encima de eso) usando la
    matriz real de OSRM, y devuelve (orden de índices 1-based sobre
    stop_coords, tiempo_ida_segundos, tiempo_vuelta_segundos) del mejor
    resultado. None si OSRM no responde."""
    all_points = [origin] + stop_coords
    matrix = await asyncio.to_thread(osrm_client.table_matrix, all_points)
    if matrix is None:
        return None
    durations = matrix["durations"]

    n = len(stop_coords)
    indices = list(range(1, n + 1))

    def orders_to_try():
        if n <= _MAX_STOPS_BRUTE_FORCE:
            yield from itertools.permutations(indices)
            return
        # Vecino más cercano — heurística, no óptimo exacto, pero evita una
        # explosión combinatoria si algún día hay muchas zonas en una ruta.
        remaining = set(indices)
        order: list[int] = []
        current = 0
        while remaining:
            nxt = min(remaining, key=lambda i: durations[current][i])
            order.append(nxt)
            remaining.remove(nxt)
            current = nxt
        yield tuple(order)

    best_order: tuple[int, ...] | None = None
    best_total = None
    best_ida = best_vuelta = 0.0
    for order in orders_to_try():
        ida = 0.0
        prev = 0
        for idx in order:
            ida += durations[prev][idx]
            prev = idx
        vuelta = durations[prev][0] / _RETURN_SPEED_FACTOR
        total = ida + vuelta
        if best_total is None or total < best_total:
            best_total, best_order, best_ida, best_vuelta = total, order, ida, vuelta

    assert best_order is not None
    return list(best_order), best_ida, best_vuelta


async def _build_subroute(point: dict, point_stops: list[dict], available_hours: float) -> dict | None:
    """Arma la ida+vuelta completa desde `point` por `point_stops` — orden
    óptimo, geometría real (calles) de cada tramo, y chequeo de
    availableHours. None si OSRM falla o si ni el mejor orden posible
    respeta el tiempo disponible (infeasible para este punto)."""
    origin = (point["lat"], point["lng"])
    stop_coords = [(s["lat"], s["lng"]) for s in point_stops]

    order_result = await _best_stop_order(origin, stop_coords)
    if order_result is None:
        return None
    order, ida_seconds, vuelta_seconds = order_result

    total_hours = (ida_seconds + vuelta_seconds) / 3600
    if total_hours > available_hours:
        return None

    ordered_stops = [point_stops[i - 1] for i in order]

    outbound_coords = [origin] + [(s["lat"], s["lng"]) for s in ordered_stops]
    return_coords = [(ordered_stops[-1]["lat"], ordered_stops[-1]["lng"]), origin]
    outbound_geo, return_geo = await asyncio.gather(
        asyncio.to_thread(osrm_client.route_geometry, outbound_coords),
        asyncio.to_thread(osrm_client.route_geometry, return_coords),
    )
    if outbound_geo is None or return_geo is None:
        return None

    # Duraciones "reales" (de la geometría final que se va a dibujar, no
    # del estimado de la matriz que solo se usó para elegir el orden) — la
    # vuelta se ajusta con el mismo _RETURN_SPEED_FACTOR que ya se aplicó
    # para decidir factibilidad, para no mostrarle al usuario un número "a
    # velocidad normal" que contradiga por qué la vuelta se dibuja más
    # lenta que la ida.
    outbound_hours = outbound_geo["durationHours"]
    return_hours = return_geo["durationHours"] / _RETURN_SPEED_FACTOR

    return {
        "originName": point.get("name", ""),
        "trucksUsed": _min_trucks_used(point, sum(s["volumeM3"] for s in point_stops)),
        "stops": ordered_stops,
        "outboundPath": outbound_geo["path"],
        "returnPath": return_geo["path"],
        "outboundDistanceKm": outbound_geo["distanceKm"],
        "outboundDurationHours": outbound_hours,
        "returnDistanceKm": return_geo["distanceKm"],
        "returnDurationHours": return_hours,
        "distanceKm": outbound_geo["distanceKm"] + return_geo["distanceKm"],
        "durationHours": outbound_hours + return_hours,
    }


# =============================================================================
# ENDPOINT
# =============================================================================

router = APIRouter(prefix="/routes", tags=["routes"])


@router.post("/generate")
async def generate_route(
    payload: RoutePlanRequestIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    active_points = await _load_active_points(payload.activePointIds)
    if not active_points:
        return RoutePlanInfeasibleOut(message="No hay puntos activos disponibles para generar la ruta.")

    stops = await _load_route_stops(payload.analysisIds)
    if not stops:
        return RoutePlanInfeasibleOut(message="No hay zonas de basura ubicables para generar la ruta.")

    total_volume = sum(s["volumeM3"] for s in stops)
    centroid = (
        sum(s["lat"] for s in stops) / len(stops),
        sum(s["lng"] for s in stops) / len(stops),
    )
    points_by_proximity = sorted(active_points, key=lambda p: _haversine((p["lat"], p["lng"]), centroid))

    origin_group = _select_origin_group(points_by_proximity, total_volume)
    if origin_group is None:
        return RoutePlanInfeasibleOut(
            message=(
                f"Ningún conjunto de puntos activos tiene camiones suficientes para cubrir "
                f"los {_format_number(total_volume)} m³ requeridos por las zonas cargadas."
            )
        )

    if len(origin_group) == 1:
        stops_by_point = {str(origin_group[0]["_id"]): stops}
    else:
        stops_by_point = _split_stops_by_nearest(origin_group, stops)

    sub_routes: list[dict] = []
    for point in origin_group:
        point_stops = stops_by_point.get(str(point["_id"]), [])
        if not point_stops:
            continue
        # _split_stops_by_nearest es una heurística (reparte por cercanía y
        # rebalancea moviendo zonas de a una) — puede terminar sin lograr
        # calzar un punto individual dentro de su propia capacidad de
        # camiones aunque la capacidad COMBINADA del grupo sí alcance. Se
        # revalida acá antes de construir la sub-ruta, en vez de confiar en
        # que el reparto siempre calza perfecto.
        assigned_volume = sum(s["volumeM3"] for s in point_stops)
        if assigned_volume > _point_truck_capacity(point):
            return RoutePlanInfeasibleOut(
                message=(
                    f'El reparto de zonas entre los puntos elegidos no logró calzar dentro de la '
                    f'capacidad de camiones de "{point.get("name", "un punto")}" '
                    f'({_format_number(assigned_volume)} m³ asignados, {_format_number(_point_truck_capacity(point))} m³ '
                    f'de capacidad) — intenta generar la ruta con menos zonas cargadas a la vez.'
                )
            )
        result = await _build_subroute(point, point_stops, payload.availableHours)
        if result is None:
            return RoutePlanInfeasibleOut(
                message=(
                    f'No se encontró una ruta desde "{point.get("name", "un punto")}" que respete '
                    f"las {_format_number(payload.availableHours)} horas disponibles (ida + vuelta), o el "
                    f"servicio de ruteo no respondió."
                )
            )
        sub_routes.append(result)

    if not sub_routes:
        return RoutePlanInfeasibleOut(message="No fue posible asignar las zonas cargadas a ningún punto activo.")

    out_stops: list[RoutePlanStopOut] = []
    outbound_paths: list[list[list[float]]] = []
    return_paths: list[list[list[float]]] = []
    segments: list[RouteSegmentOut] = []
    order = 1
    total_distance = 0.0
    max_duration = 0.0  # sub-rutas de puntos distintos corren en paralelo (cuadrillas separadas)
    for sub in sub_routes:
        for s in sub["stops"]:
            out_stops.append(RoutePlanStopOut(order=order, lat=s["lat"], lng=s["lng"], label=s["name"]))
            order += 1
        outbound_paths.append(sub["outboundPath"])
        return_paths.append(sub["returnPath"])
        segments.append(RouteSegmentOut(
            originName=sub["originName"],
            trucksUsed=sub["trucksUsed"],
            outboundDistanceKm=round(sub["outboundDistanceKm"], 2),
            outboundDurationHours=round(sub["outboundDurationHours"], 2),
            returnDistanceKm=round(sub["returnDistanceKm"], 2),
            returnDurationHours=round(sub["returnDurationHours"], 2),
        ))
        total_distance += sub["distanceKm"]
        max_duration = max(max_duration, sub["durationHours"])

    return RoutePlanSuccessOut(
        route=RoutePlanRouteOut(
            stops=out_stops,
            totalDistanceKm=round(total_distance, 2),
            totalDurationHours=round(max_duration, 2),
            outboundPaths=outbound_paths,
            returnPaths=return_paths,
            segments=segments,
        )
    )
