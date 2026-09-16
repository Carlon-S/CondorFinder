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


class ZoneOut(BaseModel):
    """Una zona geográfica seguida en el tiempo.

    La zona es la que tiene nombre y persiste; lo que va cambiando son sus
    versiones (cada vuelo) y, dentro de cada versión, sus análisis (cada
    medición de volumen). Antes el nombre vivía en cada análisis guardado, lo
    que hacía imposible hablar de "la misma zona" sin recorrer la cadena de
    duplicados de HDU7 a mano.
    """
    id: str
    owner: str
    name: str
    createdAt: datetime


class ZoneIn(BaseModel):
    name: str


class SavedAnalysisIn(BaseModel):
    name: str
    mapUrl: str
    # Zona a la que pertenece este análisis. Si no viene, el backend la
    # resuelve: hereda la de la zona que HDU7 haya reconocido por huella del
    # ortomosaico, o crea una nueva. Ver _resolve_zone().
    zoneId: str | None = None
    # Fecha en que se CAPTURARON las fotos (EXIF), no en que se guardó el
    # análisis. Es la que ordena las versiones de una zona en el tiempo: dos
    # vuelos se comparan por cuándo se voló el terreno, no por cuándo alguien
    # se sentó a medirlos.
    captureDate: datetime | None = None
    # True cuando ninguna foto traía fecha y se cayó a la de carga. La
    # interfaz lo advierte y permite corregirla, porque un EXIF malo
    # desordenaría la historia de la zona sin que nadie lo note.
    captureDateEstimated: bool = False
    # Momento en que se subió el set. Solo se usa para desempatar dos
    # versiones con la misma fecha de captura.
    uploadedAt: datetime | None = None
    # Con qué versión del algoritmo se calculó este volumen. Sin este sello,
    # cuando SP2 mejore la precisión, un salto entre dos análisis sería
    # indistinguible de un cambio real en el basural.
    algorithmVersion: int | None = None
    # Miniatura liviana (orquestador.py::result_thumbnail_filename) para
    # vistas de lista/tarjeta — Optional porque los análisis guardados antes
    # de que existiera este campo no la tienen (mismo criterio que
    # orthoCenter/orthoBounds más abajo): el frontend cae de vuelta a mapUrl
    # cuando es None.
    thumbnailUrl: str | None = None
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
    # Huella geográfica COMPLETA del ortomosaico: [left, bottom, right, top]
    # (volumeCalc.py::ortho_bounds, mismo CRS que `crs`) — HDU7 compara ESTO
    # entre análisis para detectar duplicados, no las detecciones puntuales
    # (ver _find_possible_duplicate).
    orthoBounds: list[float] | None = None


class SavedAnalysisOut(SavedAnalysisIn):
    id: str
    owner: str
    savedAt: datetime
    # HDU7 — gestionados solo por el backend, ver docstring del módulo.
    possibleDuplicateOf: str | None = None
    duplicateStatus: str | None = None
    historical: bool = False
    supersededBy: str | None = None
    # Qué cambió respecto al análisis anterior de la MISMA versión:
    # "primero", "seleccion", "algoritmo" o "sin-cambios". Lo calcula el
    # backend al guardar. Sirve para que la evolución y el informe agrupen los
    # análisis que repiten la misma cifra en vez de dibujar una línea plana
    # que parece un error. Ver _describe_change().
    changeKind: str | None = None


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
        thumbnailUrl=doc.get("thumbnailUrl"),
        detections=doc.get("detections", []),
        summary=doc.get("summary"),
        sourceTaskId=doc.get("sourceTaskId"),
        crs=doc.get("crs"),
        orthoCenter=doc.get("orthoCenter"),
        orthoBounds=doc.get("orthoBounds"),
        possibleDuplicateOf=doc.get("possibleDuplicateOf"),
        duplicateStatus=doc.get("duplicateStatus"),
        historical=doc.get("historical", False),
        supersededBy=doc.get("supersededBy"),
        zoneId=doc.get("zoneId"),
        captureDate=doc.get("captureDate"),
        captureDateEstimated=doc.get("captureDateEstimated", False),
        uploadedAt=doc.get("uploadedAt"),
        algorithmVersion=doc.get("algorithmVersion"),
        changeKind=doc.get("changeKind"),
    )


# =============================================================================
# HDU7 — DETECCIÓN DE POSIBLES DUPLICADOS ENTRE CARGAS DISTINTAS
#
# Distinto del fusionado "Varios tipos" del MVP (mergeOverlapping en
# analysis.tsx), que combina detecciones DENTRO de una misma imagen
# unificada — esto compara ANÁLISIS GUARDADOS distintos.
#
# Compara la huella COMPLETA del ortomosaico (orthoBounds), no las
# detecciones puntuales de basura. Motivo (encontrado probando el
# despliegue en la nube): el centro/extensión del ortomosaico, anclado por
# GPS/EXIF, varía muy poco entre corridas del mismo set de fotos (un par de
# metros, típico de GPS de dron sin RTK) — pero las detecciones de YOLO
# pueden correrse esos mismos metros, y en objetos chicos (pocos m²) eso
# basta para tirar el IoU muy por debajo del umbral aunque sea literalmente
# la misma basura en el mismo lugar. Comparando la imagen completa en vez
# de la basura detectada, ese margen de error de unos metros es una
# fracción mínima del tamaño total del ortomosaico (decenas de metros),
# así que el umbral de 50% queda con margen amplio en vez de al límite.
# =============================================================================

OVERLAP_THRESHOLD = 0.5


def _polygon_iou(coords_a: list[list[float]], coords_b: list[list[float]]) -> float:
    """Intersección sobre unión — mismo criterio (y mismo umbral, 0.5) que
    ya usa mergeOverlapping() en analysis.tsx para el fusionado intra-imagen,
    solo que acá corre en el backend sobre geometría real (metros), no
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


def _bounds_to_rect(bounds: list[float]) -> list[list[float]]:
    """[left, bottom, right, top] -> los 4 vértices del rectángulo, en el
    mismo formato [[x,y], ...] que espera _polygon_iou."""
    left, bottom, right, top = bounds
    return [[left, bottom], [right, bottom], [right, top], [left, top]]


async def _find_possible_duplicate(new_doc: dict, exclude_id: ObjectId) -> tuple[str, float] | None:
    """AC1 — compara la huella del ortomosaico (orthoBounds) del análisis
    recién guardado contra la de todos los análisis guardados anteriormente
    (mismo crs — no se reproyecta entre zonas UTM distintas, ver "Fuera de
    alcance" del plan), excluyendo históricos (ya reemplazados) y el propio
    documento. Devuelve el mejor candidato (mayor IoU) si supera
    OVERLAP_THRESHOLD, o None. Análisis guardados antes de que existiera
    orthoBounds no tienen con qué compararse — se excluyen (no hay forma de
    inferir su huella real retroactivamente)."""
    new_crs = new_doc.get("crs")
    new_bounds = new_doc.get("orthoBounds")
    if not new_crs or not new_bounds:
        return None
    new_rect = _bounds_to_rect(new_bounds)

    candidates = await get_db().analyses.find({
        "_id": {"$ne": exclude_id},
        "crs": new_crs,
        "historical": {"$ne": True},
        "orthoBounds": {"$ne": None},
    }).to_list(length=None)

    best_id: str | None = None
    best_ratio = 0.0
    for other in candidates:
        other_rect = _bounds_to_rect(other["orthoBounds"])
        ratio = _polygon_iou(new_rect, other_rect)
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


def _enabled_ids(detections: list[dict]) -> set:
    """Ids de las detecciones marcadas como activas.

    Una detección sin la marca cuenta como activa: así se comportan los
    análisis guardados antes de que existiera, y es el mismo criterio de
    compatibilidad que ya usan thumbnailUrl y orthoCenter.
    """
    return {d.get("id") for d in detections if d.get("enabled", True)}


def _describe_change(nuevo: dict, anterior: dict | None) -> str:
    """Qué cambió entre este análisis y el anterior de la misma versión.

    Sobre un mismo vuelo, el volumen solo puede moverse por dos motivos: que
    el trabajador haya cambiado qué detecciones deja activas, o que haya
    cambiado el algoritmo de cálculo (SP2). Si no pasó ninguno de los dos, el
    resultado es idéntico por construcción, y conviene decirlo en vez de
    dibujar un punto más en el gráfico de evolución que parezca un dato nuevo.
    """
    if anterior is None:
        return "primero"
    if nuevo.get("algorithmVersion") != anterior.get("algorithmVersion"):
        return "algoritmo"
    if _enabled_ids(nuevo.get("detections", [])) != _enabled_ids(anterior.get("detections", [])):
        return "seleccion"
    return "sin-cambios"


async def _resolve_zone(doc: dict, owner: str, duplicate_of: str | None) -> str:
    """Devuelve el zoneId que le corresponde a este análisis.

    Tres caminos, en orden:
      1. El frontend lo mandó explícito (por ejemplo al analizar de nuevo una
         versión que ya pertenece a una zona conocida).
      2. HDU7 reconoció el terreno como una zona ya vista: se hereda la suya.
         Es el mismo cálculo de superposición de huella que ya existía, solo
         cambia que ahora también agrupa, no solo advierte.
      3. No se parece a nada: nace una zona nueva, con el nombre que el
         trabajador le puso al análisis.
    """
    if doc.get("zoneId"):
        return doc["zoneId"]

    if duplicate_of:
        otro = await get_db().analyses.find_one({"_id": _object_id(duplicate_of)})
        if otro and otro.get("zoneId"):
            return otro["zoneId"]

    zona = await get_db().zones.insert_one({
        "owner": owner,
        "name": doc.get("name") or "Zona sin nombre",
        "createdAt": datetime.now(timezone.utc),
    })
    return str(zona.inserted_id)


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

    # AC1 — solo se dispara al crear un análisis NUEVO, nunca al sobrescribir
    # uno existente (update_analysis) — una sobrescritura es la misma zona
    # por definición, no hace falta volver a compararla contra las demás.
    #
    # Se compara ANTES de insertar (y no después, como antes) porque el
    # resultado ahora decide también a qué zona pertenece el análisis, y esa
    # decisión tiene que quedar escrita en el mismo documento que se inserta.
    match = await _find_possible_duplicate(doc, exclude_id=None)
    duplicate_of = None
    if match:
        duplicate_of, _ratio = match
        # Un análisis nuevo del MISMO vuelo calza consigo mismo con
        # superposición perfecta, porque comparten ortomosaico. Eso no es un
        # duplicado de zona, es otra medición de la misma versión: sirve para
        # heredar la zona, pero no debe levantar el aviso de "¿es la misma
        # zona?" cada vez que alguien vuelve a medir.
        otro = await get_db().analyses.find_one({"_id": _object_id(duplicate_of)})
        mismo_vuelo = bool(
            doc.get("sourceTaskId")
            and otro
            and otro.get("sourceTaskId") == doc["sourceTaskId"]
        )
        if not mismo_vuelo:
            doc["possibleDuplicateOf"] = duplicate_of
            doc["duplicateStatus"] = "pending"

    doc["zoneId"] = await _resolve_zone(doc, current_user.username, duplicate_of)

    # Análisis anterior de ESTA MISMA versión, para saber qué cambió. La
    # versión es la tarea de origen: un vuelo, un mapa unificado.
    anterior = None
    if doc.get("sourceTaskId"):
        anterior = await get_db().analyses.find_one(
            {"sourceTaskId": doc["sourceTaskId"]},
            sort=[("savedAt", -1)],
        )
    doc["changeKind"] = _describe_change(doc, anterior)

    result = await get_db().analyses.insert_one(doc)
    doc["_id"] = result.inserted_id
    await _release_source_task(payload.sourceTaskId)

    return _to_out(doc)


@router.get("", response_model=list[SavedAnalysisOut])
async def list_analyses(
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    docs = await get_db().analyses.find().to_list(length=None)
    return [_to_out(d) for d in docs]


# =============================================================================
# ZONAS — la identidad que persiste entre vuelos
# Van en este mismo router (prefijo /analyses) y no en uno aparte porque una
# zona no existe sin análisis: se crea al guardar el primero y se consulta
# siempre junto a ellos, igual que HDU7 vive acá y no en su propio módulo.
# =============================================================================

@router.get("/zones/all", response_model=list[ZoneOut])
async def list_zones(
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """La ruta es /zones/all y no /zones porque /{analysis_id} ya captura
    cualquier segmento suelto: sin el segundo tramo, FastAPI resolvería
    /analyses/zones como "el análisis con id 'zones'"."""
    docs = await get_db().zones.find().to_list(length=None)
    return [
        ZoneOut(
            id=str(d["_id"]),
            owner=d["owner"],
            name=d["name"],
            createdAt=d["createdAt"],
        )
        for d in docs
    ]


@router.put("/zones/{zone_id}", response_model=ZoneOut)
async def rename_zone(
    zone_id: str,
    payload: ZoneIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    doc = await get_db().zones.find_one_and_update(
        {"_id": _object_id(zone_id)},
        {"$set": {"name": payload.name}},
        return_document=ReturnDocument.AFTER,
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Zona no encontrada")
    return ZoneOut(id=str(doc["_id"]), owner=doc["owner"], name=doc["name"], createdAt=doc["createdAt"])


@router.post("/versions/{source_task_id}/reassign")
async def reassign_version(
    source_task_id: str,
    payload: ZoneIn | None = None,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Mueve una versión completa (todos los análisis de un mismo vuelo) a otra
    zona, o la separa en una zona propia si se manda un nombre.

    Existe porque agrupar por HDU7 es una heurística: compara la huella del
    ortomosaico y puede equivocarse, y hasta ahora una confirmación errónea
    solo escondía un registro bajo "Historial". Con el modelo de zonas esa
    misma equivocación fusiona dos historias de forma permanente, así que
    tiene que haber forma de deshacerla.

    Se mueve la versión entera y no un análisis suelto: todos los análisis de
    un mismo vuelo miden el mismo terreno, no tiene sentido que queden
    repartidos entre zonas distintas.
    """
    if payload and payload.name:
        zona = await get_db().zones.insert_one({
            "owner": current_user.username,
            "name": payload.name,
            "createdAt": datetime.now(timezone.utc),
        })
        destino = str(zona.inserted_id)
    else:
        raise HTTPException(status_code=400, detail="Falta el nombre de la zona de destino")

    result = await get_db().analyses.update_many(
        {"sourceTaskId": source_task_id},
        {"$set": {"zoneId": destino}},
    )
    return {"status": "ok", "zoneId": destino, "movidos": result.modified_count}


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
    este (el más reciente) queda como la versión vigente.

    Dos formas de quedar "huérfano" que hay que cubrir con más de 2
    análisis del mismo dataset (ver CLAUDE.md/HDU7):
    - Encadenado (A→B→C, B pasa a histórico): si B todavía tenía SU PROPIA
      relación pendiente hacia atrás (B→A, sin resolver), esa pregunta no
      puede quedar atrapada en un registro histórico — se hereda hacia
      este mismo análisis (el sobreviviente, C).
    - Hermanos (A→B pendiente y A→C pendiente al mismo tiempo, se confirma
      C→A): cualquier OTRO análisis que también apuntaba a A como posible
      duplicado (acá, B) queda señalando a un histórico si no se redirige
      — se re-apunta hacia el sobreviviente (C) para que la pregunta se
      pueda seguir resolviendo sobre un análisis vigente."""
    oid = _object_id(analysis_id)
    doc = await get_db().analyses.find_one({"_id": oid})
    if not doc:
        raise HTTPException(status_code=404, detail="Análisis no encontrado")
    if not doc.get("possibleDuplicateOf"):
        raise HTTPException(status_code=400, detail="Este análisis no tiene un posible duplicado pendiente")

    older_id = _object_id(doc["possibleDuplicateOf"])
    older_doc = await get_db().analyses.find_one({"_id": older_id})

    inherited_pending = (
        older_doc is not None
        and older_doc.get("duplicateStatus") == "pending"
        and older_doc.get("possibleDuplicateOf")
        and older_doc["possibleDuplicateOf"] != analysis_id
    )

    await get_db().analyses.update_one(
        {"_id": older_id},
        {"$set": {
            "historical": True,
            "supersededBy": analysis_id,
            # Se limpia acá: un análisis histórico no debe seguir mostrando
            # un banner de "posible duplicado" accionable — si tenía una
            # pregunta pendiente propia, ya se trasladó al sobreviviente
            # abajo (caso "encadenado").
            "possibleDuplicateOf": None,
            "duplicateStatus": None,
        }},
    )

    # Caso "hermanos" — cualquier análisis DISTINTO de este que seguía
    # esperando resolver si era la misma zona que older_doc, se redirige
    # hacia el sobreviviente en vez de quedar apuntando a un histórico.
    await get_db().analyses.update_many(
        {
            "possibleDuplicateOf": str(older_id),
            "duplicateStatus": "pending",
            "_id": {"$ne": oid},
        },
        {"$set": {"possibleDuplicateOf": analysis_id}},
    )

    new_fields = (
        {"possibleDuplicateOf": older_doc["possibleDuplicateOf"], "duplicateStatus": "pending"}
        if inherited_pending
        else {"duplicateStatus": "confirmed_same"}
    )
    result = await get_db().analyses.find_one_and_update(
        {"_id": oid},
        {"$set": new_fields},
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
