from bson import ObjectId
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from pymongo.asynchronous.database import AsyncDatabase

import auth as auth_module

# =============================================================================
# CONDORFINDER — GENERACIÓN DE RUTA ÓPTIMA (HDU5)
# Archivo: backendModel/routing.py
#
# Base de POST /routes/generate: recibe el payload que ya arma el frontend
# (src/lib/routePlan.ts), resuelve la capacidad REAL de los puntos
# activos Y los basurales reales de los análisis elegidos contra Mongo (el
# frontend solo manda IDs — nunca los datos en sí — el backend es la única
# fuente de verdad para ambos), y arma la respuesta con la forma exacta que
# el frontend espera. El algoritmo de optimización en sí — el que decide el
# ORDEN de las paradas — queda marcado como TODO más abajo; es lo único que
# falta llenar para que HDU5/AC2 quede completo de punta a punta.
#
# Mismo patrón que resources.py: set_db()/get_db() inyectado desde el
# lifespan de orquestador.py, router protegido con la misma dependency de
# sesión (get_current_user) que ya usa el resto del backend.
#
# Los modelos de acá abajo usan nombres de campo en camelCase (no el
# snake_case habitual en Python) A PROPÓSITO: src/lib/routePlan.ts interpreta
# la respuesta tal cual llega, sin traducir nombres — cambiarlos acá
# rompería el contrato que se encuentra en el frontend para los demas criterios (AC1/AC3/AC4/AC5/AC6).
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
    # El frontend manda IDs de análisis ya guardados (Mongo), no los datos
    # de cada zona — mismo criterio que activePointIds: nunca se confía en
    # volumen/polígono que mande el navegador, se resuelve acá abajo contra
    # la fuente real (colección `analyses`).
    analysisIds: list[str]
    activePointIds: list[str]
    availableHours: float
    priorityWasteType: str | None = None


class ResolvedWasteZone(BaseModel):
    """Un basural real, resuelto desde un análisis guardado — una entrada
    por detección con geo_polygon válido. geoPolygon queda en su CRS
    proyectado ORIGINAL (UTM, metros — ej. "EPSG:32719"), no reproyectado a
    WGS84: esa conversión es solo para dibujar en Leaflet (ver
    src/lib/projection.ts); para calcular distancias reales entre paradas,
    trabajar directo en metros es lo correcto, no grados."""
    id: str
    analysisId: str
    name: str
    wasteClass: str
    volumeM3: float | None
    geoPolygon: list[list[float]]
    crs: str


class RoutePlanStopOut(BaseModel):
    order: int
    lat: float
    lng: float
    label: str


class RoutePlanRouteOut(BaseModel):
    stops: list[RoutePlanStopOut]
    totalDistanceKm: float | None = None
    totalDurationHours: float | None = None


class RoutePlanSuccessOut(BaseModel):
    status: str = "success"
    route: RoutePlanRouteOut


class RoutePlanInfeasibleOut(BaseModel):
    status: str = "infeasible"
    message: str


# =============================================================================
# PUENTE DE ENTRADA — capacidad real de los puntos activos
# =============================================================================

async def _load_active_points(point_ids: list[str]) -> list[dict]:
    """Trae de Mongo los puntos de `point_ids`, filtrando además
    por `active: True` server-side — no basta con que el frontend ya haya
    filtrado antes de mandar los IDs, porque esa lista pudo quedar vieja
    (un punto se pudo haber desactivado después). IDs con formato inválido
    se descartan en vez de tirar un 500.

    Cada doc trae, tal como los guarda resources.py: name, lat, lng,
    tolvas: [{capacity_m3}], trucks: [{capacity_m3}], retroexcavadoras_count,
    personal_count — todo lo que el algoritmo real va a necesitar.
    """
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


def _total_capacity_m3(points: list[dict]) -> float:
    """Capacidad total (tolvas + camiones) sumada entre todos los puntos
    activos — dato base que el algoritmo real va a necesitar para saber
    si una ruta es factible o no."""
    total = 0.0
    for p in points:
        total += sum(t.get("capacity_m3", 0) for t in p.get("tolvas", []))
        total += sum(t.get("capacity_m3", 0) for t in p.get("trucks", []))
    return total


# =============================================================================
# PUENTE DE ENTRADA — basurales reales de los análisis guardados elegidos
# =============================================================================

async def _load_waste_zones(analysis_ids: list[str]) -> list[ResolvedWasteZone]:
    """Trae de Mongo (colección `analyses`, ver analyses.py) los análisis de
    `analysis_ids` y expande cada una de sus detecciones con geo_polygon
    válido en una zona candidata para la ruta. Análisis sin `crs` (guardados
    antes de HDU5) o detecciones sin geo_polygon se omiten en silencio —
    mismo criterio que ya aplica el frontend al cargarlos en /rutas."""
    valid_ids: list[ObjectId] = []
    for aid in analysis_ids:
        try:
            valid_ids.append(ObjectId(aid))
        except Exception:
            continue
    if not valid_ids:
        return []

    docs = await get_db().analyses.find({"_id": {"$in": valid_ids}}).to_list(length=None)

    zones: list[ResolvedWasteZone] = []
    for doc in docs:
        crs = doc.get("crs")
        if not crs:
            continue
        analysis_id = str(doc["_id"])
        for det in doc.get("detections", []):
            geo_polygon = det.get("geo_polygon")
            if not geo_polygon or len(geo_polygon) < 3:
                continue
            zones.append(ResolvedWasteZone(
                id=f"{analysis_id}-{det.get('id')}",
                analysisId=analysis_id,
                name=doc.get("name", ""),
                wasteClass=det.get("class") or "Tipo de basura indefinido",
                volumeM3=det.get("volume_m3"),
                geoPolygon=geo_polygon,
                crs=crs,
            ))
    return zones


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
        return RoutePlanInfeasibleOut(
            message="No hay puntos activos disponibles para generar la ruta.",
        )

    waste_zones = await _load_waste_zones(payload.analysisIds)

    if not waste_zones:
        return RoutePlanInfeasibleOut(
            message="No hay zonas de basura cargadas para generar la ruta.",
        )

    total_capacity_m3 = _total_capacity_m3(active_points)  # noqa: F841 — para el algoritmo real

    # ─────────────────────────────────────────────────────────────────────
    # TODO(HDU5/AC2): acá va el algoritmo real de optimización de ruta.
    # Ya está resuelto y disponible en este punto:
    #   - waste_zones            → cada basural real, resuelto desde Mongo
    #                              (nunca se confía en lo que mande el
    #                              navegador). geoPolygon en su CRS UTM
    #                              proyectado original (metros) — no en
    #                              WGS84, que es solo para dibujar en
    #                              Leaflet. wasteClass y volumeM3 incluidos.
    #   - payload.availableHours / payload.priorityWasteType.
    #   - active_points          → docs completos de Mongo: lat/lng,
    #                              tolvas/trucks con su capacity_m3 real.
    #   - total_capacity_m3      → capacidad total ya sumada.
    #
    # Mientras no exista, se devuelve "infeasible" siempre — no se inventa
    # una ruta falsa. El frontend ya maneja este camino correctamente
    # (HDU5/AC6, verificado).
    # ─────────────────────────────────────────────────────────────────────
    return RoutePlanInfeasibleOut(
        message="El algoritmo de generación de ruta todavía no está implementado.",
    )
