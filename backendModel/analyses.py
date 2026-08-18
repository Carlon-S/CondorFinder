from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from pymongo import ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase
from shapely.geometry import Polygon

import auth as auth_module
import task_store

# =============================================================================
# CONDORFINDER — ANÁLISIS GUARDADOS (HDU4) + FUSIÓN DE DUPLICADOS (HDU7)
# Archivo: backendModel/analyses.py
#
# Reemplaza src/lib/analysisStore.ts's localStorage por persistencia real en
# Mongo — localStorage era un placeholder documentado desde el principio
# ("cuando exista backend con persistencia real, este módulo se reemplaza
# por llamadas a la API"), y quedó como un bloqueante real para la nube:
# no sincroniza entre dispositivos/navegadores del mismo trabajador, se
# pierde si se limpia el navegador, y no se comparte entre usuarios.
#
# Mismo patrón que resources.py: set_db()/get_db() inyectado desde el
# lifespan de orquestador.py, router protegido con la misma dependency de
# sesión (get_current_user), y — igual que resources.py — NO se filtra por
# owner al listar (se guarda quién lo creó, pero todavía no hay roles ni
# necesidad real de aislar datos entre cuentas; un solo criterio en todo
# el backend, no vale la pena que este módulo sea la excepción).
#
# Modelos en camelCase (no snake_case) A PROPÓSITO — mismo motivo que
# routing.py: src/lib/analysisStore.ts ya definía SavedAnalysisRecord con
# esos nombres de campo antes de que este archivo existiera, y los tres
# consumidores (analysis.tsx, index.tsx, rutas.tsx) leen esa forma tal
# cual llega, sin traducir nombres.
#
# HDU7 (fusión de duplicados entre cargas de la misma zona) vive en el
# mismo archivo: el cálculo de superposición (shapely, ya dependencia del
# proyecto vía volumeCalc.py) y los campos de vínculo son parte natural del
# ciclo de vida de un análisis guardado, no ameritan un módulo aparte.
# possibleDuplicateOf/duplicateStatus/historical/supersededBy son
# EXCLUSIVOS de SavedAnalysisOut — el frontend nunca los manda al guardar,
# solo el backend los calcula/actualiza.
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
# MODELOS
# =============================================================================

class AnalysisSummaryModel(BaseModel):
    totalVolumeM3: float
    totalWeightKg: float
    totalAreaM2: float


class SavedAnalysisIn(BaseModel):
    name: str
    mapUrl: str
    # Blob opaco para el backend — cada detección trae bbox/geo_polygon/
    # volumen/etc., ya validados y calculados aguas arriba (volumeCalc.py);
    # acá no hace falta re-tipar cada campo, solo guardarlo y devolverlo tal
    # cual (mismo criterio que "detections: unknown" en el lado TypeScript).
    detections: list[dict[str, Any]] = []
    summary: AnalysisSummaryModel | None = None
    sourceTaskId: str | None = None
    crs: str | None = None
    # Centro geográfico real del ortomosaico (volumeCalc.py::ortho_center,
    # mismo CRS que `crs`) — HDU5/rutas.tsx lo usa para ubicar el círculo de
    # la zona en el mapa de forma consistente entre distintas corridas de
    # análisis del mismo set de fotos, en vez de promediar las detecciones
    # (que varían si YOLO encuentra algo distinto entre corridas).
    orthoCenter: list[float] | None = None


class SavedAnalysisOut(SavedAnalysisIn):
    id: str
    owner: str
    savedAt: datetime
    # HDU7 — gestionados solo por el backend, ver docstring del módulo.
    possibleDuplicateOf: str | None = None
    duplicateStatus: str | None = None
    historical: bool = False
    supersededBy: str | None = None


def _object_id(analysis_id: str) -> ObjectId:
    try:
        return ObjectId(analysis_id)
    except InvalidId:
        raise HTTPException(status_code=404, detail="Análisis no encontrado")


def _to_out(doc: dict) -> SavedAnalysisOut:
    return SavedAnalysisOut(
        id=str(doc["_id"]),
        owner=doc["owner"],
        savedAt=doc["savedAt"],
        name=doc["name"],
        mapUrl=doc["mapUrl"],
        detections=doc.get("detections", []),
        summary=doc.get("summary"),
        sourceTaskId=doc.get("sourceTaskId"),
        crs=doc.get("crs"),
        orthoCenter=doc.get("orthoCenter"),
        possibleDuplicateOf=doc.get("possibleDuplicateOf"),
        duplicateStatus=doc.get("duplicateStatus"),
        historical=doc.get("historical", False),
        supersededBy=doc.get("supersededBy"),
    )


# =============================================================================
# HDU7 — DETECCIÓN DE POSIBLES DUPLICADOS ENTRE CARGAS DISTINTAS
#
# Distinto del fusionado "Varios tipos" del MVP (mergeOverlapping en
# analysis.tsx), que combina detecciones DENTRO de una misma imagen
# unificada — esto compara detecciones entre ANÁLISIS GUARDADOS distintos,
# usando sus geo_polygon reales (UTM, metros).
# =============================================================================

OVERLAP_THRESHOLD = 0.5


def _polygon_iou(coords_a: list[list[float]], coords_b: list[list[float]]) -> float:
    """Intersección sobre unión — mismo criterio (y mismo umbral, 0.5) que
    ya usa mergeOverlapping() en analysis.tsx para el fusionado intra-imagen,
    solo que acá corre en el backend sobre geo_polygon real (metros), no
    sobre bbox en píxeles."""
    try:
        poly_a = Polygon(coords_a)
        poly_b = Polygon(coords_b)
        if not poly_a.is_valid:
            poly_a = poly_a.buffer(0)
        if not poly_b.is_valid:
            poly_b = poly_b.buffer(0)
        union_area = poly_a.union(poly_b).area
        if union_area == 0:
            return 0.0
        return poly_a.intersection(poly_b).area / union_area
    except Exception:
        return 0.0


async def _find_possible_duplicate(new_doc: dict, exclude_id: ObjectId) -> tuple[str, float] | None:
    """AC1 — compara los geo_polygon del análisis recién guardado contra
    todos los análisis guardados anteriormente (mismo crs — no se
    reproyecta entre zonas UTM distintas, ver "Fuera de alcance" del plan),
    excluyendo históricos (ya reemplazados) y el propio documento. Devuelve
    el mejor candidato (mayor IoU) si supera OVERLAP_THRESHOLD, o None."""
    new_crs = new_doc.get("crs")
    new_detections = new_doc.get("detections", [])
    if not new_crs or not new_detections:
        return None

    candidates = await get_db().analyses.find({
        "_id": {"$ne": exclude_id},
        "crs": new_crs,
        "historical": {"$ne": True},
    }).to_list(length=None)

    best_id: str | None = None
    best_ratio = 0.0
    for other in candidates:
        for new_det in new_detections:
            new_poly = new_det.get("geo_polygon")
            if not new_poly or len(new_poly) < 3:
                continue
            for other_det in other.get("detections", []):
                other_poly = other_det.get("geo_polygon")
                if not other_poly or len(other_poly) < 3:
                    continue
                ratio = _polygon_iou(new_poly, other_poly)
                if ratio > best_ratio:
                    best_ratio = ratio
                    best_id = str(other["_id"])

    if best_id and best_ratio >= OVERLAP_THRESHOLD:
        return best_id, best_ratio
    return None


# =============================================================================
# ENDPOINTS
# =============================================================================

router = APIRouter(prefix="/analyses", tags=["analyses"])


async def _release_source_task(source_task_id: str | None) -> None:
    """Al guardar un análisis, su tarea de origen deja de necesitar
    aparecer como "pendiente de revisión" en GET /tasks/pending — pero el
    documento se CONSERVA (no se borra) para que "Analizar volumen" pueda
    seguir recalculando sobre esta misma tarea después, aunque el análisis
    ya esté guardado (ver task_store.mark_reviewed). Best-effort: si falla,
    no debe tumbar el guardado real del análisis, que ya se completó."""
    if not source_task_id:
        return
    try:
        await task_store.mark_reviewed(source_task_id)
    except Exception:
        pass


@router.post("", response_model=SavedAnalysisOut)
async def create_analysis(
    payload: SavedAnalysisIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    doc = {
        **payload.model_dump(),
        "owner": current_user.username,
        "savedAt": datetime.now(timezone.utc),
        "possibleDuplicateOf": None,
        "duplicateStatus": None,
        "historical": False,
        "supersededBy": None,
    }
    result = await get_db().analyses.insert_one(doc)
    doc["_id"] = result.inserted_id
    await _release_source_task(payload.sourceTaskId)

    # AC1 — solo se dispara al crear un análisis NUEVO, nunca al sobrescribir
    # uno existente (update_analysis) — una sobrescritura es la misma zona
    # por definición, no hace falta volver a compararla contra las demás.
    match = await _find_possible_duplicate(doc, exclude_id=result.inserted_id)
    if match:
        other_id, _ratio = match
        await get_db().analyses.update_one(
            {"_id": result.inserted_id},
            {"$set": {"possibleDuplicateOf": other_id, "duplicateStatus": "pending"}},
        )
        doc["possibleDuplicateOf"] = other_id
        doc["duplicateStatus"] = "pending"

    return _to_out(doc)


@router.get("", response_model=list[SavedAnalysisOut])
async def list_analyses(
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    docs = await get_db().analyses.find().to_list(length=None)
    return [_to_out(d) for d in docs]


@router.get("/{analysis_id}", response_model=SavedAnalysisOut)
async def get_analysis(
    analysis_id: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    doc = await get_db().analyses.find_one({"_id": _object_id(analysis_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Análisis no encontrado")
    return _to_out(doc)


@router.put("/{analysis_id}", response_model=SavedAnalysisOut)
async def update_analysis(
    analysis_id: str,
    payload: SavedAnalysisIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    # AC6 de HDU4 (sobrescribir un análisis con el mismo nombre) — el
    # frontend decide CUÁNDO sobrescribir (ya sabe el id del existente),
    # este endpoint solo reemplaza el documento entero. payload no trae los
    # campos de HDU7 (SavedAnalysisIn no los incluye), así que $set no los
    # toca — un análisis ya vinculado/histórico sigue así tras sobrescribirse.
    oid = _object_id(analysis_id)
    result = await get_db().analyses.find_one_and_update(
        {"_id": oid},
        {"$set": payload.model_dump()},
        return_document=ReturnDocument.AFTER,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Análisis no encontrado")
    await _release_source_task(payload.sourceTaskId)
    return _to_out(result)


@router.delete("/{analysis_id}")
async def delete_analysis(
    analysis_id: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    result = await get_db().analyses.delete_one({"_id": _object_id(analysis_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Análisis no encontrado")
    return {"message": "Análisis eliminado"}


@router.post("/{analysis_id}/confirm-duplicate", response_model=SavedAnalysisOut)
async def confirm_duplicate(
    analysis_id: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """AC3 — el trabajador confirma que es la misma zona: el análisis
    ANTERIOR (possibleDuplicateOf) pasa a histórico (se oculta del listado
    principal de Vista Principal, sigue disponible bajo "Historial"), y
    este (el más reciente) queda como la versión vigente."""
    oid = _object_id(analysis_id)
    doc = await get_db().analyses.find_one({"_id": oid})
    if not doc:
        raise HTTPException(status_code=404, detail="Análisis no encontrado")
    if not doc.get("possibleDuplicateOf"):
        raise HTTPException(status_code=400, detail="Este análisis no tiene un posible duplicado pendiente")

    older_id = _object_id(doc["possibleDuplicateOf"])
    await get_db().analyses.update_one(
        {"_id": older_id},
        {"$set": {"historical": True, "supersededBy": analysis_id}},
    )
    result = await get_db().analyses.find_one_and_update(
        {"_id": oid},
        {"$set": {"duplicateStatus": "confirmed_same"}},
        return_document=ReturnDocument.AFTER,
    )
    return _to_out(result)


@router.post("/{analysis_id}/reject-duplicate", response_model=SavedAnalysisOut)
async def reject_duplicate(
    analysis_id: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """AC4 — el trabajador indica que son zonas distintas: ambos registros
    se mantienen por separado tal cual estaban, solo se cierra el aviso de
    "posible duplicado" para que no se vuelva a mostrar."""
    oid = _object_id(analysis_id)
    result = await get_db().analyses.find_one_and_update(
        {"_id": oid},
        {"$set": {"duplicateStatus": "confirmed_different"}},
        return_document=ReturnDocument.AFTER,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Análisis no encontrado")
    return _to_out(result)
