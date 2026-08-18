from typing import Any

from pymongo import ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase

# El tipo sync de pymongo (Database) no se importa acá — su ruta exacta
# depende de la versión instalada y no vale la pena arriesgar un ImportError
# por precisión de tipo en un parámetro; Any cubre el mismo propósito sin
# ese riesgo.

# =============================================================================
# CONDORFINDER — PERSISTENCIA DE TAREAS
# Archivo: backendModel/task_store.py
#
# Reemplaza el dict `tasks` en memoria de orquestador.py por una colección de
# Mongo — así el estado de una tarea (status, mensajes, resultados) sobrevive
# un reinicio de uvicorn, en vez de perderse por completo aunque los archivos
# sigan intactos en disco.
#
# Dos flavors de cada operación porque el pipeline (run_pipeline/run_analysis
# en orquestador.py) corre en threading.Thread normal, no en una corutina —
# el driver AsyncMongoClient no es seguro de usar ahí. Los endpoints
# (async def) usan las versiones async; run_pipeline/run_analysis usan las
# sync. Mismo `pymongo` ya instalado, ambos clientes (uno async, uno sync)
# se crean en el lifespan de orquestador.py apuntando a la misma base.
#
# task_id se usa directo como _id del documento — sigue siendo el mismo
# string UUID que ya genera POST /generate, no cambia nada para el frontend.
#
# odm_task (el objeto que permite cancelar un job de ODM en curso) es un
# objeto Python vivo, no serializable — nunca puede guardarse en Mongo. Se
# mantiene aparte, en un dict chico en memoria (_odm_task_handles): es la
# única pieza de una tarea que sigue sin sobrevivir un reinicio, a propósito.
# =============================================================================

_db: AsyncDatabase | None = None
_sync_db: Any | None = None
_odm_task_handles: dict[str, Any] = {}


def set_db(async_db: AsyncDatabase, sync_db: Any) -> None:
    global _db, _sync_db
    _db = async_db
    _sync_db = sync_db


def get_db() -> AsyncDatabase:
    if _db is None:
        raise RuntimeError("La base de datos no fue inicializada — set_db() debe llamarse en el lifespan.")
    return _db


def get_sync_db() -> Any:
    if _sync_db is None:
        raise RuntimeError("La base de datos no fue inicializada — set_db() debe llamarse en el lifespan.")
    return _sync_db


# =============================================================================
# odm_task — handle en memoria, aparte del documento de Mongo (ver docstring
# del módulo). Se limpia solo cuando la tarea deja de necesitarlo.
# =============================================================================

def set_odm_task_handle(task_id: str, odm_task: Any) -> None:
    _odm_task_handles[task_id] = odm_task


def get_odm_task_handle(task_id: str) -> Any | None:
    return _odm_task_handles.get(task_id)


def pop_odm_task_handle(task_id: str) -> None:
    _odm_task_handles.pop(task_id, None)


# =============================================================================
# ASYNC — para los endpoints (async def) de orquestador.py
# =============================================================================

_ACTIVE_STATUSES = ("running", "checking_overlap", "joining", "detecting")


async def get_task(task_id: str) -> dict | None:
    return await get_db().tasks.find_one({"_id": task_id})


async def create_task(task_id: str, data: dict) -> None:
    await get_db().tasks.insert_one({"_id": task_id, **data})


async def update_task(task_id: str, **fields: Any) -> None:
    await get_db().tasks.update_one({"_id": task_id}, {"$set": fields})


async def delete_task(task_id: str) -> None:
    """Borra el documento de la tarea de Mongo — usado cuando el trabajador
    elimina una zona desde Vista Principal (guardada o no), o cuando se
    descubre una tarea "cancelled" en list_pending_tasks(). NO se usa al
    guardar un análisis — ver mark_reviewed() para ese caso: la tarea de un
    análisis ya guardado se conserva a propósito, para que "Analizar
    volumen" pueda seguir recalculando sobre los mismos archivos."""
    await get_db().tasks.delete_one({"_id": task_id})


async def mark_reviewed(task_id: str) -> None:
    """Al guardar un análisis, su tarea de origen deja de necesitar
    aparecer como "pendiente de revisión" en Vista Principal — pero a
    diferencia de delete_task(), acá el documento se CONSERVA (con
    reviewed=True) en vez de borrarse: si se borrara, "Analizar volumen"
    sobre un análisis ya guardado y reabierto no tendría con qué
    recalcular (los archivos ortho/nDSM que usa volumeCalc.py se referencian
    desde ESTE documento). list_pending_tasks() excluye reviewed=True para
    que no se muestre duplicado junto a su versión ya guardada."""
    await get_db().tasks.update_one({"_id": task_id}, {"$set": {"reviewed": True}})


async def list_pending_tasks() -> list[dict]:
    """Tareas que Vista Principal debe mostrar como "en progreso" o
    "pendiente de análisis" — reemplaza taskRegistry.ts (localStorage):
    antes cada navegador llevaba su propia lista de qué task_id le
    pertenecía, y una consulta de red fallida en el momento equivocado
    (ej. un reinicio de uvicorn) la desregistraba para siempre aunque la
    tarea siguiera sana en Mongo. Ahora es una sola fuente de verdad en el
    backend — cualquier navegador/dispositivo ve las mismas tareas.

    "error" queda afuera (nunca se mostró como fila, ver loadZoneRows en
    index.tsx). "reviewed" (ver mark_reviewed) también queda afuera — ya
    tiene un análisis guardado que la representa, no debe duplicarse acá.
    "cancelled" SÍ se incluye — el frontend la descubre acá, limpia sus
    archivos, y la borra (mismo comportamiento de antes, solo que ahora la
    "lista de pendientes" vive en el backend en vez de en localStorage)."""
    cursor = get_db().tasks.find(
        {"status": {"$ne": "error"}, "reviewed": {"$ne": True}}
    ).sort("created_at", 1)
    return await cursor.to_list(length=None)


async def is_pipeline_busy() -> bool:
    """Ver is_pipeline_busy() en orquestador.py para el motivo de este chequeo
    (UPLOAD_DIR compartido entre todos los usuarios)."""
    busy_task = await get_db().tasks.find_one({"status": {"$in": list(_ACTIVE_STATUSES)}})
    return busy_task is not None


async def reconcile_orphaned_tasks() -> None:
    """Al arrancar el proceso: cualquier tarea que haya quedado en un estado
    "en curso" es de una vida ANTERIOR del proceso — su hilo de Python ya no
    existe, nada la va a volver a mover. Sin esto quedaría mostrando
    "detectando..." (o el estado que sea) para siempre, más confuso que un
    error claro."""
    await get_db().tasks.update_many(
        {"status": {"$in": list(_ACTIVE_STATUSES)}},
        {"$set": {
            "status": "error",
            "message": "El proceso se interrumpió por un reinicio del servidor. Vuelve a intentarlo.",
        }},
    )


# =============================================================================
# SYNC — para run_pipeline/run_analysis (threading.Thread) en orquestador.py
# =============================================================================

def get_task_sync(task_id: str) -> dict | None:
    return get_sync_db().tasks.find_one({"_id": task_id})


def update_task_sync(task_id: str, **fields: Any) -> dict | None:
    return get_sync_db().tasks.find_one_and_update(
        {"_id": task_id},
        {"$set": fields},
        return_document=ReturnDocument.AFTER,
    )
