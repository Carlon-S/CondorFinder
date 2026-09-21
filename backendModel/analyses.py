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
# CONDORFINDER, ANÁLISIS GUARDADOS (HDU4) + FUSIÓN DE DUPLICADOS (HDU7)
# Archivo: backendModel/analyses.py
#
# Reemplaza src/lib/analysisStore.ts's localStorage por persistencia real en
# Mongo, localStorage era un placeholder documentado desde el principio
# ("cuando exista backend con persistencia real, este módulo se reemplaza
# por llamadas a la API"), y quedó como un bloqueante real para la nube:
# no sincroniza entre dispositivos/navegadores del mismo trabajador, se
# pierde si se limpia el navegador, y no se comparte entre usuarios.
#
# Mismo patrón que resources.py: set_db()/get_db() inyectado desde el
# lifespan de orquestador.py, router protegido con la misma dependency de
# sesión (get_current_user), y, igual que resources.py, NO se filtra por
# owner al listar (se guarda quién lo creó, pero todavía no hay roles ni
# necesidad real de aislar datos entre cuentas; un solo criterio en todo
# el backend, no vale la pena que este módulo sea la excepción).
#
# Modelos en camelCase (no snake_case) A PROPÓSITO, mismo motivo que
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
# EXCLUSIVOS de SavedAnalysisOut, el frontend nunca los manda al guardar,
# solo el backend los calcula/actualiza.
# =============================================================================

_db: AsyncDatabase | None = None


def set_db(db: AsyncDatabase) -> None:
    global _db
    _db = db


def get_db() -> AsyncDatabase:
    if _db is None:
        raise RuntimeError("La base de datos no fue inicializada, set_db() debe llamarse en el lifespan.")
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


class ConfirmDuplicateIn(BaseModel):
    """Cuál de los candidatos eligió el trabajador.

    Ausente significa "el que el sistema puso primero", que es el
    comportamiento de siempre.
    """
    duplicateOf: str | None = None


class ReassignIn(BaseModel):
    """Destino de una versión que quedó agrupada en la zona equivocada.

    Exactamente uno de los dos: `zoneId` la mueve a una zona que YA existe,
    `name` crea una zona nueva con ese nombre. Antes solo existía la segunda
    opción, así que separar una versión mal agrupada siempre generaba una zona
    más, y no había forma de decir "en realidad pertenece a aquella".
    """
    zoneId: str | None = None
    name: str | None = None


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
    # vistas de lista/tarjeta, Optional porque los análisis guardados antes
    # de que existiera este campo no la tienen (mismo criterio que
    # orthoCenter/orthoBounds más abajo): el frontend cae de vuelta a mapUrl
    # cuando es None.
    thumbnailUrl: str | None = None
    # Blob opaco para el backend, cada detección trae bbox/geo_polygon/
    # volumen/etc., ya validados y calculados aguas arriba (volumeCalc.py);
    # acá no hace falta re-tipar cada campo, solo guardarlo y devolverlo tal
    # cual (mismo criterio que "detections: unknown" en el lado TypeScript).
    detections: list[dict[str, Any]] = []
    summary: AnalysisSummaryModel | None = None
    sourceTaskId: str | None = None
    crs: str | None = None
    # Centro geográfico real del ortomosaico (volumeCalc.py::ortho_center,
    # mismo CRS que `crs`), HDU5/rutas.tsx lo usa para ubicar el círculo de
    # la zona en el mapa de forma consistente entre distintas corridas de
    # análisis del mismo set de fotos, en vez de promediar las detecciones
    # (que varían si YOLO encuentra algo distinto entre corridas).
    orthoCenter: list[float] | None = None
    # Huella geográfica COMPLETA del ortomosaico: [left, bottom, right, top]
    # (volumeCalc.py::ortho_bounds, mismo CRS que `crs`), HDU7 compara ESTO
    # entre análisis para detectar duplicados, no las detecciones puntuales
    # (ver _find_possible_duplicates).
    orthoBounds: list[float] | None = None


class DuplicateCandidate(BaseModel):
    """Una zona con la que este análisis podría estar duplicado.

    Se manda la lista completa, no solo la mejor: cuando dos zonas superan el
    umbral, el trabajador tiene que poder elegir cuál, y no solo aceptar o
    rechazar la que el sistema eligió por él.
    """
    analysisId: str
    name: str
    zoneId: str | None = None
    # Superposición de huellas, 0 a 1. La interfaz la muestra como porcentaje
    # para que la elección no sea a ciegas.
    ratio: float


class SavedAnalysisOut(SavedAnalysisIn):
    id: str
    owner: str
    savedAt: datetime
    # HDU7, gestionados solo por el backend, ver docstring del módulo.
    possibleDuplicateOf: str | None = None
    # Todos los candidatos, de mayor a menor superposición.
    # `possibleDuplicateOf` es el primero de esta lista y se conserva porque
    # es lo que decide la herencia de zona al guardar.
    possibleDuplicates: list[DuplicateCandidate] = []
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
        possibleDuplicates=doc.get("possibleDuplicates", []),
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
# HDU7, DETECCIÓN DE POSIBLES DUPLICADOS ENTRE CARGAS DISTINTAS
#
# Distinto del fusionado "Varios tipos" del MVP (mergeOverlapping en
# analysis.tsx), que combina detecciones DENTRO de una misma imagen
# unificada, esto compara ANÁLISIS GUARDADOS distintos.
#
# Compara la huella COMPLETA del ortomosaico (orthoBounds), no las
# detecciones puntuales de basura. Motivo (encontrado probando el
# despliegue en la nube): el centro/extensión del ortomosaico, anclado por
# GPS/EXIF, varía muy poco entre corridas del mismo set de fotos (un par de
# metros, típico de GPS de dron sin RTK), pero las detecciones de YOLO
# pueden correrse esos mismos metros, y en objetos chicos (pocos m²) eso
# basta para tirar el IoU muy por debajo del umbral aunque sea literalmente
# la misma basura en el mismo lugar. Comparando la imagen completa en vez
# de la basura detectada, ese margen de error de unos metros es una
# fracción mínima del tamaño total del ortomosaico (decenas de metros),
# así que el umbral de 50% queda con margen amplio en vez de al límite.
# =============================================================================

OVERLAP_THRESHOLD = 0.5


def _polygon_iou(coords_a: list[list[float]], coords_b: list[list[float]]) -> float:
    """Intersección sobre unión, mismo criterio (y mismo umbral, 0.5) que
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


async def _find_possible_duplicates(new_doc: dict, exclude_id: ObjectId | None) -> list[dict]:
    """Todos los candidatos a duplicado, no solo el mejor.

    Antes esto devolvía un único id, el de mayor superposición, y el aviso
    preguntaba "¿es la misma zona que X?" en binario. Cuando dos zonas
    superaban el umbral, el trabajador solo veía una: si la que el sistema
    eligió no era la correcta, decir "son zonas distintas" tampoco servía,
    porque lo que quería decir era "es esta OTRA", y esa respuesta no existía.

    Devuelve la lista ordenada de mayor a menor superposición, cada una con su
    razón de superposición para que la interfaz pueda mostrarla. Vacía si
    ninguna supera el umbral.
    """
    new_crs = new_doc.get("crs")
    new_bounds = new_doc.get("orthoBounds")
    if not new_crs or not new_bounds:
        return []
    new_rect = _bounds_to_rect(new_bounds)

    query: dict = {
        "crs": new_crs,
        "historical": {"$ne": True},
        "orthoBounds": {"$ne": None},
    }
    if exclude_id is not None:
        query["_id"] = {"$ne": exclude_id}

    propio_vuelo = new_doc.get("sourceTaskId")

    candidatos = []
    for other in await get_db().analyses.find(query).to_list(length=None):
        # Otra medición del MISMO vuelo calza consigo misma con superposición
        # perfecta. No es una zona que elegir, es la misma versión, así que no
        # se ofrece como candidata.
        if propio_vuelo and other.get("sourceTaskId") == propio_vuelo:
            continue
        ratio = _polygon_iou(new_rect, _bounds_to_rect(other["orthoBounds"]))
        if ratio >= OVERLAP_THRESHOLD:
            candidatos.append({
                "analysisId": str(other["_id"]),
                "name": other.get("name", ""),
                "zoneId": other.get("zoneId"),
                "ratio": round(ratio, 4),
            })

    candidatos.sort(key=lambda c: c["ratio"], reverse=True)
    return candidatos


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
    aparecer como "pendiente de revisión" en GET /tasks/pending, pero el
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

    # Otra medición del MISMO vuelo pertenece a la misma zona por definición:
    # una versión es un vuelo, y un vuelo no puede estar repartido entre dos
    # zonas. Se resuelve por sourceTaskId y no por superposición de huellas,
    # porque acá no hay nada que estimar, es un hecho.
    #
    # Antes esto salía de rebote del cálculo de duplicados (una medición del
    # mismo vuelo calza consigo misma con superposición perfecta), pero esos
    # candidatos ya no se consideran, justamente porque no son una zona que
    # elegir. Sin esta rama, volver a medir un vuelo lo habría mandado a una
    # zona nueva.
    if doc.get("sourceTaskId"):
        hermano = await get_db().analyses.find_one(
            {"sourceTaskId": doc["sourceTaskId"], "zoneId": {"$ne": None}}
        )
        if hermano and hermano.get("zoneId"):
            return hermano["zoneId"]

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

    # AC1, solo se dispara al crear un análisis NUEVO, nunca al sobrescribir
    # uno existente (update_analysis), una sobrescritura es la misma zona
    # por definición, no hace falta volver a compararla contra las demás.
    #
    # Se compara ANTES de insertar (y no después, como antes) porque el
    # resultado ahora decide también a qué zona pertenece el análisis, y esa
    # decisión tiene que quedar escrita en el mismo documento que se inserta.
    # Si el trabajador YA declaró a qué zona pertenece esta captura (eligió
    # "modificar zona existente" antes de cargar las fotos), no hay nada que
    # adivinar ni que preguntar. La detección de duplicados existe para cubrir
    # el caso en que nadie lo dijo; correrla igual significaría preguntarle
    # "¿no será esta otra zona?" a alguien que acaba de responder esa pregunta.
    zona_declarada = bool(payload.zoneId)

    duplicate_of = None
    if not zona_declarada:
        # _find_possible_duplicates ya descarta las mediciones del mismo vuelo:
        # esas heredan la zona por otro camino y no son una zona que elegir.
        candidatos = await _find_possible_duplicates(doc, exclude_id=None)
        if candidatos:
            duplicate_of = candidatos[0]["analysisId"]
            doc["possibleDuplicateOf"] = duplicate_of
            doc["duplicateStatus"] = "pending"
            doc["possibleDuplicates"] = candidatos

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
# ZONAS, la identidad que persiste entre vuelos
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
    payload: ReassignIn | None = None,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Mueve una versión completa (todos los análisis de un mismo vuelo) a otra
    zona: a una que ya existe (`zoneId`) o a una nueva (`name`).

    Existe porque agrupar por HDU7 es una heurística: compara la huella del
    ortomosaico y puede equivocarse, y hasta ahora una confirmación errónea
    solo escondía un registro bajo "Historial". Con el modelo de zonas esa
    misma equivocación fusiona dos historias de forma permanente, así que
    tiene que haber forma de deshacerla.

    Se mueve la versión entera y no un análisis suelto: todos los análisis de
    un mismo vuelo miden el mismo terreno, no tiene sentido que queden
    repartidos entre zonas distintas.
    """
    if payload and payload.zoneId:
        # A una zona que ya existe. Se valida antes de mover: apuntar una
        # versión a una zona inexistente la dejaría invisible en todas las
        # vistas, que filtran por zonas conocidas.
        existe = await get_db().zones.find_one({"_id": _object_id(payload.zoneId)})
        if not existe:
            raise HTTPException(status_code=404, detail="La zona de destino no existe")
        destino = payload.zoneId
    elif payload and payload.name:
        zona = await get_db().zones.insert_one({
            "owner": current_user.username,
            "name": payload.name,
            "createdAt": datetime.now(timezone.utc),
        })
        destino = str(zona.inserted_id)
    else:
        raise HTTPException(
            status_code=400,
            detail="Falta la zona de destino: manda zoneId (existente) o name (nueva)",
        )

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
    # AC6 de HDU4 (sobrescribir un análisis con el mismo nombre), el
    # frontend decide CUÁNDO sobrescribir (ya sabe el id del existente),
    # este endpoint solo reemplaza el documento entero. payload no trae los
    # campos de HDU7 (SavedAnalysisIn no los incluye), así que $set no los
    # toca, un análisis ya vinculado/histórico sigue así tras sobrescribirse.
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
    """Borra un análisis y deshace las referencias que quedaban apuntándole.

    Antes esto era un delete_one pelado, y dejaba tres clases de huérfano:

    1. El análisis al que este había REEMPLAZADO seguía marcado `historical`
       con `supersededBy` apuntando a un id que ya no existía. En la práctica
       esa captura desaparecía de todos los filtros salvo "Historial", y ahí
       su "Reemplazado por:" salía en blanco: quedaba inalcanzable.
    2. El análisis que lo tenía como POSIBLE duplicado se quedaba en
       `duplicateStatus: "pending"` contra la nada. El banner no aparecía
       (loadAnalysisById devolvía null) y el registro quedaba mal para
       siempre, en silencio.
    3. Si era el último análisis de su zona, el documento de la zona quedaba
       en la colección para siempre: no existe ningún otro borrado de zonas
       en la API. Se veían como filas "0 capturas · 0 análisis" en el diálogo
       de informe, y se iban acumulando con cada borrado.
    """
    doc = await get_db().analyses.find_one_and_delete({"_id": _object_id(analysis_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Análisis no encontrado")

    # (1) Quien había sido reemplazado POR este vuelve a estar vigente. Es lo
    # esperable: si se borra la captura más nueva de una zona, la anterior pasa
    # a ser la vigente otra vez.
    #
    # Al borrar un eslabón del MEDIO de una cadena (A→B→C, se borra B), A
    # vuelve a vigente y convive con C. Las dos son capturas reales de la zona
    # y la barra de versiones las ordena igual por fecha, así que se prefiere
    # eso antes que re-enlazar A→C adivinando una intención que nadie expresó.
    await get_db().analyses.update_many(
        {"supersededBy": analysis_id},
        {"$set": {"historical": False, "supersededBy": None}},
    )

    # (2) Quien lo tenía como posible duplicado se queda sin con qué comparar:
    # se vuelve al estado inicial en vez de dejar una comparación pendiente
    # contra un registro inexistente.
    await get_db().analyses.update_many(
        {"possibleDuplicateOf": analysis_id},
        {"$set": {"possibleDuplicateOf": None, "duplicateStatus": None}},
    )

    # (3) Si era el último análisis de su zona, la zona se va con él. Una zona
    # sin ningún análisis no es nada: no tiene capturas, ni volumen, ni mapa.
    zone_id = doc.get("zoneId")
    if zone_id:
        quedan = await get_db().analyses.count_documents({"zoneId": zone_id})
        if quedan == 0:
            await get_db().zones.delete_one({"_id": _object_id(zone_id)})

    return {"message": "Análisis eliminado"}


@router.post("/{analysis_id}/confirm-duplicate", response_model=SavedAnalysisOut)
async def confirm_duplicate(
    analysis_id: str,
    payload: ConfirmDuplicateIn | None = None,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """AC3, el trabajador confirma que es la misma zona: el análisis
    ANTERIOR (possibleDuplicateOf) pasa a histórico (se oculta del listado
    principal de Vista Principal, sigue disponible bajo "Historial"), y
    este (el más reciente) queda como la versión vigente.

    Dos formas de quedar "huérfano" que hay que cubrir con más de 2
    análisis del mismo dataset (ver CLAUDE.md/HDU7):
    - Encadenado (A→B→C, B pasa a histórico): si B todavía tenía SU PROPIA
      relación pendiente hacia atrás (B→A, sin resolver), esa pregunta no
      puede quedar atrapada en un registro histórico, se hereda hacia
      este mismo análisis (el sobreviviente, C).
    - Hermanos (A→B pendiente y A→C pendiente al mismo tiempo, se confirma
      C→A): cualquier OTRO análisis que también apuntaba a A como posible
      duplicado (acá, B) queda señalando a un histórico si no se redirige
     , se re-apunta hacia el sobreviviente (C) para que la pregunta se
      pueda seguir resolviendo sobre un análisis vigente."""
    oid = _object_id(analysis_id)
    doc = await get_db().analyses.find_one({"_id": oid})
    if not doc:
        raise HTTPException(status_code=404, detail="Análisis no encontrado")
    if not doc.get("possibleDuplicateOf"):
        raise HTTPException(status_code=400, detail="Este análisis no tiene un posible duplicado pendiente")

    # El trabajador puede elegir un candidato distinto del que el sistema puso
    # primero. Cuando lo hace, este análisis estaba en la zona equivocada
    # (la heredó del mejor candidato al guardarse), así que además de marcar
    # el histórico hay que MOVER la versión a la zona del elegido. Sin eso,
    # elegir otro candidato marcaba el histórico correcto pero dejaba la
    # captura colgando de la zona que el sistema había adivinado.
    elegido = (payload.duplicateOf if payload else None) or doc["possibleDuplicateOf"]

    older_id = _object_id(elegido)
    older_doc = await get_db().analyses.find_one({"_id": older_id})
    if not older_doc:
        raise HTTPException(status_code=404, detail="La zona elegida ya no existe")

    if elegido != doc["possibleDuplicateOf"]:
        destino = older_doc.get("zoneId")
        if destino and destino != doc.get("zoneId") and doc.get("sourceTaskId"):
            await get_db().analyses.update_many(
                {"sourceTaskId": doc["sourceTaskId"]},
                {"$set": {"zoneId": destino}},
            )
            doc["zoneId"] = destino
        # A partir de acá el resto del flujo trabaja sobre el elegido.
        await get_db().analyses.update_one({"_id": oid}, {"$set": {"possibleDuplicateOf": elegido}})
        doc["possibleDuplicateOf"] = elegido

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
            # un banner de "posible duplicado" accionable, si tenía una
            # pregunta pendiente propia, ya se trasladó al sobreviviente
            # abajo (caso "encadenado").
            "possibleDuplicateOf": None,
            "duplicateStatus": None,
        }},
    )

    # Caso "hermanos", cualquier análisis DISTINTO de este que seguía
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
    """AC4, el trabajador indica que son zonas distintas: ambos registros se
    mantienen por separado y se cierra el aviso de "posible duplicado".

    Además hay que DESHACER la herencia de zona. _resolve_zone() le asigna al
    análisis nuevo la zona del candidato apenas se guarda, antes de que nadie
    responda, porque en la mayoría de los casos acierta. Si el trabajador dice
    que son distintas, ese análisis quedó colgando de una zona ajena: la
    evolución de una mostraba la historia de la otra.

    Se mueve la versión COMPLETA (todos los análisis del mismo vuelo), no solo
    este documento: todos miden el mismo terreno, no tiene sentido repartirlos.
    """
    oid = _object_id(analysis_id)
    doc = await get_db().analyses.find_one({"_id": oid})
    if not doc:
        raise HTTPException(status_code=404, detail="Análisis no encontrado")

    cambios: dict[str, Any] = {"duplicateStatus": "confirmed_different"}

    otro_id = doc.get("possibleDuplicateOf")
    if otro_id and doc.get("zoneId"):
        otro = await get_db().analyses.find_one({"_id": _object_id(otro_id)})
        # Solo si de verdad comparten zona. Si ya estaban separadas (porque el
        # frontend mandó una zona explícita, o porque alguien las reasignó a
        # mano), no hay nada que deshacer.
        if otro and otro.get("zoneId") == doc["zoneId"]:
            zona = await get_db().zones.insert_one({
                "owner": doc.get("owner", current_user.username),
                "name": doc.get("name") or "Zona sin nombre",
                "createdAt": datetime.now(timezone.utc),
            })
            nueva_zona = str(zona.inserted_id)
            if doc.get("sourceTaskId"):
                await get_db().analyses.update_many(
                    {"sourceTaskId": doc["sourceTaskId"]},
                    {"$set": {"zoneId": nueva_zona}},
                )
            cambios["zoneId"] = nueva_zona

    result = await get_db().analyses.find_one_and_update(
        {"_id": oid},
        {"$set": cambios},
        return_document=ReturnDocument.AFTER,
    )
    return _to_out(result)
