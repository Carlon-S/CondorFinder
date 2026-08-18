import os
import sys
import uuid
import threading
import json
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from typing import List
import shutil
import requests
from pymongo import AsyncMongoClient, MongoClient

load_dotenv()

# Agrega los paths para poder importar los módulos del compañero
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

from joining import joinOrtho
from joining import Reconociemiento_solapamiento as solapamiento
from detecting import detectingOrtho
from detecting import volumeCalc
import auth as auth_module
import resources as resources_module
import routing as routing_module
import analyses as analyses_module
import task_store
import storage as storage_module


# =============================================================================
# CONEXIÓN A MONGODB (Atlas) — un solo cliente para todo el proceso, creado
# al arrancar y cerrado al apagar. auth.py recibe la referencia vía
# set_db() en vez de abrir su propia conexión.
# =============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    # No se usa get_default_database(): depende de que el connection string
    # de Atlas incluya el nombre de la base en el path, y la plantilla que
    # da Atlas por defecto no lo trae — se pide explícito por env var para
    # no romper en el setup de cada uno.
    mongo_client = AsyncMongoClient(os.environ["MONGODB_URI"])
    db = mongo_client[os.environ.get("MONGODB_DB_NAME", "condorfinder")]
    auth_module.set_db(db)
    resources_module.set_db(db)
    routing_module.set_db(db)
    analyses_module.set_db(db)
    # GCS_BUCKET_NAME sin setear => modo local (ver storage.py) — así el
    # backend sigue corriendo 100% en WSL sin depender de ninguna cuenta de
    # GCP; solo la VM en producción lo setea de verdad.
    storage_module.set_bucket(os.environ.get("GCS_BUCKET_NAME"))
    storage_module.set_local_fallback_dir(OUTPUT_DIR)

    # Segunda conexión, síncrona — run_pipeline/run_analysis corren en
    # threading.Thread normal (no en una corutina), y el driver async no es
    # seguro de usar ahí. Misma URI/base, dos conexiones al mismo lugar.
    sync_mongo_client = MongoClient(os.environ["MONGODB_URI"])
    sync_db = sync_mongo_client[os.environ.get("MONGODB_DB_NAME", "condorfinder")]
    task_store.set_db(db, sync_db)

    await auth_module.seed_admin_user(db)

    # Cualquier tarea que haya quedado "en curso" es de la vida ANTERIOR del
    # proceso — su hilo ya no existe, nada la va a volver a mover. Se marca
    # como error acá antes de aceptar tráfico, en vez de dejarla mostrando
    # progreso que nunca va a avanzar.
    await task_store.reconcile_orphaned_tasks()

    yield
    sync_mongo_client.close()
    await mongo_client.close()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_module.router)
app.include_router(resources_module.router)
app.include_router(routing_module.router)
app.include_router(analyses_module.router)

# =============================================================================
# CONFIGURACIÓN DE RED
#
# PUBLIC_BASE_URL: host desde el que el FRONTEND alcanza este backend — se
# usa para construir result_url/result_json_url en las respuestas. Default
# localhost:8000 no rompe nada en desarrollo local; en la VM de producción
# se setea a http://<IP_VM>:8000 vía backendModel/.env.
#
# NODEODM_HOST: host desde el que ESTE PROCESO alcanza a NodeODM. En WSL
# local, NodeODM corre en la misma máquina (localhost). En docker-compose,
# backend y nodeodm son contenedores distintos — el backend le habla a
# NodeODM por el nombre del servicio de compose ("nodeodm"), no localhost.
# =============================================================================

PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000")
NODEODM_HOST = os.environ.get("NODEODM_HOST", "localhost")

# =============================================================================
# DIRECTORIOS
# =============================================================================

UPLOAD_DIR  = os.path.join(BASE_DIR, "joining", "images")
FINALS_DIR  = os.path.join(BASE_DIR, "joining", "finals")
OUTPUT_DIR  = os.path.join(BASE_DIR, "detecting", "output")
DSM_PATH   = os.path.join(BASE_DIR, "joining","output","odm_dem","dsm.tif")
DTM_PATH   = os.path.join(BASE_DIR, "joining","output","odm_dem","dtm.tif")
NDSM_PATH  = os.path.join(BASE_DIR, "joining","output","odm_dem","ndsm.tif")

# joining/images/ es una carpeta COMPARTIDA — se reusa para cada carga nueva.
# Si se guarda una "foto" (snapshot) de las imágenes de cada tarea aquí, se
# puede seguir mostrando el set ORIGINAL de una tarea aunque después se haya
# subido un set distinto para otra generación.
TASK_IMAGES_DIR = os.path.join(BASE_DIR, "joining", "task_images")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(FINALS_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(TASK_IMAGES_DIR, exist_ok=True)

# =============================================================================
# ESTADO DE TAREAS
# Persistido en Mongo vía task_store.py (colección "tasks") — antes era un
# dict en memoria del proceso, que se perdía por completo en cada reinicio
# de uvicorn (incluso tareas ya terminadas). Ver task_store.py para el
# porqué de las versiones sync/async separadas.
# Estructura del documento: { "_id": task_id, "status": str, "message": str, ... }
# Estados posibles: "running", "checking_overlap", "joining", "detecting", "done", "error", "cancelled"
# =============================================================================


# =============================================================================
# UTILIDADES
# =============================================================================

def is_jpg(filename: str) -> bool:
    return filename.lower().endswith((".jpg", ".jpeg"))

def check_odm_running() -> bool:
    """Verifica que el nodo ODM de Docker esté corriendo (ver NODEODM_HOST)."""
    try:
        r = requests.get(f"http://{NODEODM_HOST}:3000/info", timeout=3)
        return r.status_code == 200
    except Exception:
        return False

async def is_pipeline_busy() -> bool:
    """
    True si alguna tarea está usando activamente UPLOAD_DIR (entre
    'checking_overlap' y 'detecting', inclusive).

    UPLOAD_DIR es una única carpeta compartida por TODO el backend — no por
    sesión ni por usuario. En local, con una sola persona probando, nunca se
    nota. Pero al desplegar en la nube para el Sprint 1, dos personas
    (compañeros de equipo, jurado) pueden pegarle al mismo backend a la vez:
    si el usuario B sube imágenes o inicia una generación mientras la tarea
    del usuario A todavía está leyendo esa carpeta, se mezclan sets de
    imágenes de zonas distintas silenciosamente. Este chequeo bloquea esa
    ventana — ver uso en /upload, /upload (DELETE) y /generate.

    "running" se incluye porque es el estado inicial de una tarea recién
    creada en /generate, antes de que su hilo en background alcance a
    marcarla "checking_overlap" — sin esto, dos /generate casi simultáneos
    podían colarse los dos antes de que el primero apareciera como "busy".
    """
    return await task_store.is_pipeline_busy()


# =============================================================================
# ENDPOINTS DE CARGA DE IMÁGENES (lógica existente, sin cambios)
# =============================================================================

@app.post("/upload")
async def upload_images(images: List[UploadFile] = File(...)):
    if await is_pipeline_busy():
        raise HTTPException(
            status_code=409,
            detail="Hay un proceso de generación en curso en el servidor. Espera a que termine antes de agregar imágenes.",
        )
    saved_files = []
    rejected_files = []
    for image in images:
        if not is_jpg(image.filename):
            rejected_files.append(image.filename)
            continue
        file_path = os.path.join(UPLOAD_DIR, image.filename)
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(image.file, buffer)
        saved_files.append(image.filename)
    return {
        "message": f"Subidas {len(saved_files)} imágenes",
        "archivos": saved_files,
        "rechazados": rejected_files,
    }

@app.get("/upload")
async def list_images():
    """Retorna la lista de archivos actualmente en images/."""
    files = [f for f in os.listdir(UPLOAD_DIR) if is_jpg(f)]
    return {"archivos": files}


@app.get("/pipeline-status")
async def pipeline_status():
    """
    Expone is_pipeline_busy() directamente, para que el frontend pueda
    consultar el estado REAL del servidor al montar /carga (o después de un
    F5) en vez de confiar en su propio estado local (uploadDone,
    uploadBlockedMessage), que se resetea en cada recarga y puede quedar
    desincronizado de lo que realmente está pasando en el backend — el
    botón "Generar mapa unificado" podía verse habilitado después de un F5
    aunque el servidor siguiera ocupado con otra tarea.
    """
    return {"busy": await is_pipeline_busy()}

@app.get("/upload/{filename}")
async def get_uploaded_image(filename: str):
    """Sirve una imagen ya subida — usado para mostrar las miniaturas al
    retomar una generación en curso desde la Vista Principal, donde el
    frontend ya no tiene los archivos originales en memoria."""
    file_path = os.path.join(UPLOAD_DIR, filename)
    if not os.path.exists(file_path):
        return {"status": "error", "message": "Archivo no encontrado"}
    return FileResponse(file_path, media_type="image/jpeg")

@app.delete("/upload/{filename}")
async def delete_image(filename: str):
    if await is_pipeline_busy():
        raise HTTPException(
            status_code=409,
            detail="Hay un proceso de generación en curso en el servidor. Espera a que termine antes de modificar las imágenes.",
        )
    file_path = os.path.join(UPLOAD_DIR, filename)
    if os.path.exists(file_path):
        os.remove(file_path)
        return {"message": f"Imagen {filename} eliminada"}
    return {"message": f"Imagen {filename} no encontrada"}

@app.delete("/upload")
async def delete_all_images():
    if await is_pipeline_busy():
        raise HTTPException(
            status_code=409,
            detail="Hay un proceso de generación en curso en el servidor. Espera a que termine antes de modificar las imágenes.",
        )
    deleted = []
    for fname in os.listdir(UPLOAD_DIR):
        if is_jpg(fname):
            os.remove(os.path.join(UPLOAD_DIR, fname))
            deleted.append(fname)
    return {"message": f"Eliminadas {len(deleted)} imágenes", "archivos": deleted}


# =============================================================================
# ENDPOINT: INICIAR GENERACIÓN DEL MAPA
# Responde inmediatamente con un task_id.
# El proceso real (join + detect) corre en un hilo separado.
# =============================================================================

def run_pipeline(task_id: str, opc: int):
    """Ejecuta join() y detect() en un hilo separado."""
    try:
        task_store.update_task_sync(task_id, status="checking_overlap", message="Verificando solapamiento entre imágenes...")

        resultado = solapamiento.verificar_set_vuelo(
            UPLOAD_DIR,
            fov_horizontal=82.1,
            altitud_vuelo=50,
            umbral_min_solape=60
        )

        if not resultado["aprobado"]:
            task_store.update_task_sync(
                task_id,
                status="error",
                message=resultado["mensaje"],
                overlap_detail=resultado["detalle"],
                overlap_total=resultado["total_pares"],
            )
            return

        # Punto de chequeo de cancelación — solo puede interrumpir AQUÍ, entre
        # fases. Una vez que empieza joinOrtho.join() (llamada bloqueante a
        # ODM) o detectingOrtho.detect() (inferencia YOLO), no hay forma de
        # interrumpirla a mitad de camino: la cancelación recién se aplica
        # cuando esa llamada termina y el pipeline vuelve a pasar por aquí.
        if task_store.get_task_sync(task_id).get("cancel_requested"):
            task_store.update_task_sync(task_id, status="cancelled", message="Cancelado por el usuario")
            return

        task_store.update_task_sync(task_id, status="joining", message="Unificando imágenes con ODM...")

        def on_odm_task_created(odm_task):
            task_store.set_odm_task_handle(task_id, odm_task)
            # Si ya se había pedido cancelar antes de que ODM alcanzara
            # a crear su propia tarea, cancélala altiro.
            if task_store.get_task_sync(task_id).get("cancel_requested"):
                try:
                    odm_task.cancel()
                except Exception:
                    pass

        filename = joinOrtho.join(opc, on_task_created=on_odm_task_created)
        fileplace = os.path.join(FINALS_DIR, filename)

        if task_store.get_task_sync(task_id).get("cancel_requested"):
            task_store.update_task_sync(task_id, status="cancelled", message="Cancelado por el usuario")
            # El .tif ya se generó y se movió a FINALS_DIR antes de que se
            # notara la cancelación (varios MB cada uno) — sin este cleanup
            # quedaba huérfano ahí para siempre, ya que esta tarea nunca va
            # a llegar a "done" ni a guardarse.
            if os.path.exists(fileplace):
                try:
                    os.remove(fileplace)
                except Exception:
                    pass
            return

        task_store.update_task_sync(task_id, status="detecting", message="Detectando basura con YOLOv8...")

        final, detection_count, DETECTIONS_JSON = detectingOrtho.detect(fileplace)
        FORCE_NO_DETECTIONS = False  # Cambiar a True para demo sin basura
        if FORCE_NO_DETECTIONS:
            detection_count = 0
            with open(DETECTIONS_JSON, "w") as _f:
                json.dump({"detections": []}, _f)
        base = os.path.basename(final)
        result_filename = base + ".png"
        result_json_filename = base + ".json"

        task_store.update_task_sync(task_id, detections_json_path=DETECTIONS_JSON, ortho_path=fileplace)

        # Faltaba este chequeo: si se pidió cancelar DURANTE "detecting" (no
        # se puede interrumpir YOLO a mitad de camino), antes se ignoraba
        # silenciosamente y la tarea terminaba marcada "done" como si nada.
        if task_store.get_task_sync(task_id).get("cancel_requested"):
            task_store.update_task_sync(task_id, status="cancelled", message="Cancelado por el usuario")
            # detect() ya escribió el PNG anotado y el JSON de detecciones en
            # OUTPUT_DIR antes de que se notara la cancelación. El frontend
            # nunca llega a conocer estos nombres (result_filename solo se
            # expone en /status cuando el estado es "done"), así que sin
            # este cleanup quedaban huérfanos para siempre — es la causa de
            # los archivos sueltos en detecting/output/ que no correspondían
            # a ninguna zona del listado.
            for fname in (result_filename, result_json_filename):
                fpath = os.path.join(OUTPUT_DIR, fname)
                if os.path.exists(fpath):
                    try:
                        os.remove(fpath)
                    except Exception:
                        pass
            if os.path.exists(fileplace):
                try:
                    os.remove(fileplace)
                except Exception:
                    pass
            return

        if os.path.exists(DSM_PATH) and os.path.exists(DTM_PATH):
            if not os.path.exists(NDSM_PATH):
                volumeCalc.compute_ndsm(DSM_PATH, DTM_PATH, NDSM_PATH)

        # Análisis de volumen automático — corre en este mismo hilo antes de marcar done
        run_analysis(task_id)

        # Recién ACÁ el PNG/JSON en OUTPUT_DIR quedan en su versión final
        # (run_analysis ya los enriqueció con volumen/área/peso) — subirlos
        # antes de esto guardaría en GCS una versión sin esos datos. En modo
        # local (sin GCS_BUCKET_NAME) esto no hace nada — los archivos ya
        # están en su lugar final, igual que antes de storage.py.
        for fname, ctype in (
            (result_filename, "image/png"),
            (result_json_filename, "application/json"),
        ):
            fpath = os.path.join(OUTPUT_DIR, fname)
            if os.path.exists(fpath):
                storage_module.upload_result_file(fpath, fname, ctype)

        task_store.update_task_sync(
            task_id,
            status="done",
            message="Proceso completado",
            result_filename=result_filename,
            result_json_filename=result_json_filename,
            detection_count=detection_count,
        )

        # El snapshot de task_images/ solo sirve para retomar la vista de
        # carga de una tarea "en progreso" (botón "Ir a Carga") — apenas el
        # pipeline llega a "done" la tarea pasa a "pendiente de análisis" en
        # el frontend, que usa "Ir a Análisis" en su lugar y ya no necesita
        # esas imágenes. Se borra acá mismo para que la vista de carga
        # vuelva a verse "nueva" desde ese momento en adelante, en vez de
        # dejar la copia huérfana hasta que el usuario elimine la zona.
        snapshot_dir = os.path.join(TASK_IMAGES_DIR, task_id)
        if os.path.isdir(snapshot_dir):
            shutil.rmtree(snapshot_dir, ignore_errors=True)

        # odm_task ya no hace falta una vez terminado el pipeline — liberar el
        # handle en memoria (nunca iba a sobrevivir un reinicio de todos
        # modos, pero no hay razón para dejarlo colgado hasta entonces).
        task_store.pop_odm_task_handle(task_id)

    except joinOrtho.TaskCancelledError:
        task_store.update_task_sync(task_id, status="cancelled", message="Cancelado por el usuario")
        task_store.pop_odm_task_handle(task_id)

    except Exception as e:
        task_store.update_task_sync(task_id, status="error", message=str(e))
        task_store.pop_odm_task_handle(task_id)


@app.post("/generate")
async def generate_map():
    """
    Inicia el pipeline join + detect en background.
    Verifica que ODM esté corriendo antes de iniciar.
    Retorna un task_id para consultar el estado.
    Preset fijo: 0 (rápido).
    """
    if not check_odm_running():
        return {
            "status": "error",
            "message": "El nodo ODM no está corriendo. Inicia Docker con: docker run -ti -p 3000:3000 opendronemap/nodeodm"
        }

    if await is_pipeline_busy():
        return {
            "status": "error",
            "message": "Ya hay un proceso de generación en curso en el servidor. Espera a que termine antes de iniciar uno nuevo.",
        }

    task_id = str(uuid.uuid4())
    await task_store.create_task(task_id, {
        "status": "running",
        "message": "Iniciando pipeline...",
        "result_filename": None,
        "detections_json_path": None,
        "ortho_path": None,
        "analysis_status": None,
        "analysis_message": None,
        "cancel_requested": False,
        # Reemplaza taskRegistry.ts (localStorage) — GET /tasks/pending usa
        # esto para ordenar la lista que ve Vista Principal.
        "created_at": datetime.now(timezone.utc),
        # true una vez que el análisis se guardó (analyses.py::mark_reviewed)
        # — deja de aparecer en GET /tasks/pending sin borrar el documento,
        # así "Analizar volumen" puede seguir recalculando sobre esta misma
        # tarea aunque el análisis ya esté guardado.
        "reviewed": False,
    })

    # UPLOAD_DIR es compartido entre todas las tareas — se sobreescribe con
    # cada carga nueva. Se guarda una copia ("foto") del set de imágenes con
    # el que ESTA tarea arrancó, para poder mostrarlo correctamente después
    # (ej. al retomar desde la Vista Principal) aunque para entonces
    # UPLOAD_DIR ya tenga las imágenes de otra carga distinta.
    snapshot_dir = os.path.join(TASK_IMAGES_DIR, task_id)
    os.makedirs(snapshot_dir, exist_ok=True)
    for fname in os.listdir(UPLOAD_DIR):
        if is_jpg(fname):
            shutil.copyfile(os.path.join(UPLOAD_DIR, fname), os.path.join(snapshot_dir, fname))

    thread = threading.Thread(target=run_pipeline, args=(task_id, 0), daemon=True)
    thread.start()

    return {"task_id": task_id, "status": "running"}


# =============================================================================
# ENDPOINT: CANCELAR UNA TAREA
#
# Durante "checking_overlap" o entre fases: se aplica al instante (chequeo
# de cancel_requested en run_pipeline).
#
# Durante "joining": se le pide a ODM (Docker) que cancele su propia tarea
# vía odm_task.cancel() — cancelación real, no solo dejar de avanzar.
#
# Durante "detecting" (inferencia YOLO): no hay a quién pedirle cancelar,
# es una llamada local bloqueante — solo se marca cancel_requested, pero
# no se aplica hasta que esa llamada termine sola.
# =============================================================================

@app.post("/cancel/{task_id}")
async def cancel_task(task_id: str):
    task = await task_store.get_task(task_id)
    if not task:
        return {"status": "error", "message": "Tarea no encontrada"}
    if task["status"] in ("done", "error", "cancelled"):
        return {"status": "error", "message": "La tarea ya terminó, no se puede cancelar"}

    await task_store.update_task(task_id, cancel_requested=True)

    odm_task = task_store.get_odm_task_handle(task_id)
    if odm_task is not None:
        try:
            odm_task.cancel()
            return {"status": "ok", "message": "Cancelación solicitada — se aplica de inmediato en ODM"}
        except Exception:
            pass  # sigue como cancel_requested para el próximo punto de control

    return {"status": "ok", "message": "Cancelación solicitada"}


# =============================================================================
# ENDPOINT: CALCULAR VOLUMEN (HDU2)
# Se ejecuta separado del pipeline — requiere que el mapa ya esté generado.
# =============================================================================

def run_analysis(task_id: str):
    """Calcula volumen por detección usando el nDSM generado por ODM."""
    try:
        task_store.update_task_sync(task_id, analysis_status="running", analysis_message="Calculando volúmenes con datos del modelo 3D...")

        task = task_store.get_task_sync(task_id)
        detections_json = task["detections_json_path"]
        ortho_path = task["ortho_path"]

        if not os.path.exists(NDSM_PATH):
            if os.path.exists(DSM_PATH) and os.path.exists(DTM_PATH):
                volumeCalc.compute_ndsm(DSM_PATH, DTM_PATH, NDSM_PATH)
            else:
                raise FileNotFoundError(
                    "Archivos DEM no disponibles (dsm.tif / dtm.tif). "
                    "Verifica que ODM generó los modelos de elevación."
                )

        volumeCalc.enrich(detections_json, ortho_path, NDSM_PATH, detections_json)

        task_store.update_task_sync(task_id, analysis_status="done", analysis_message="Análisis de volumen completado")

    except Exception as e:
        task_store.update_task_sync(task_id, analysis_status="error", analysis_message=str(e))


@app.post("/analyze/{task_id}")
async def start_analysis(task_id: str):
    """Inicia el cálculo de volumen en background para una tarea ya completada."""
    task = await task_store.get_task(task_id)
    if not task:
        return {"status": "error", "message": "Tarea no encontrada"}
    if task["status"] != "done":
        return {"status": "error", "message": "El mapa aún no está generado"}
    if task.get("analysis_status") == "done":
        return {"status": "already_done", "message": "El análisis ya fue calculado durante la generación del mapa"}
    if task.get("analysis_status") == "running":
        return {"status": "already_running", "message": "El análisis ya está en curso"}

    thread = threading.Thread(target=run_analysis, args=(task_id,), daemon=True)
    thread.start()
    return {"status": "running"}


# =============================================================================
# ENDPOINT: LISTAR TAREAS PENDIENTES (reemplaza taskRegistry.ts)
# =============================================================================

@app.get("/tasks/pending")
async def list_pending_tasks():
    """Vista Principal consulta esto directo en vez de mantener su propia
    lista de task_id en localStorage — ver docstring de
    task_store.list_pending_tasks() para el motivo completo. Devuelve las
    tareas "en progreso" o "done pero todavía no guardadas como análisis"
    (una vez guardada, analyses.py marca la tarea como reviewed=True — ver
    task_store.mark_reviewed — y deja de aparecer acá, sin borrar el
    documento). "cancelled" se incluye para que el frontend la descubra,
    limpie sus archivos, y la borre — igual que hacía antes al encontrarla
    en su registro local."""
    tasks = await task_store.list_pending_tasks()
    result = []
    for task in tasks:
        entry = {
            "task_id": task["_id"],
            "status": task["status"],
            "message": task["message"],
            "created_at": task.get("created_at"),
        }
        if task["status"] == "done" and task.get("result_filename"):
            entry["result_url"] = f"{PUBLIC_BASE_URL}/result/{task['result_filename']}"
            json_name = task.get("result_json_filename", "")
            if json_name and storage_module.result_file_exists(json_name):
                entry["result_json_url"] = f"{PUBLIC_BASE_URL}/result/{json_name}"
            entry["detection_count"] = task.get("detection_count", 0)
        result.append(entry)
    return result


# =============================================================================
# ENDPOINT: CONSULTAR ESTADO DE UNA TAREA
# =============================================================================

@app.get("/status/{task_id}")
async def get_status(task_id: str):
    """
    El frontend consulta este endpoint cada N segundos.
    Cuando status = "done", result_url contiene la URL de la imagen anotada.
    """
    task = await task_store.get_task(task_id)
    if not task:
        return {"status": "error", "message": "Tarea no encontrada"}

    response = {
        "status": task["status"],
        "message": task["message"],
    }

    if task["status"] == "done" and task["result_filename"]:
        response["result_url"] = f"{PUBLIC_BASE_URL}/result/{task['result_filename']}"
        json_name = task.get("result_json_filename", "")
        # Importante: solo se usa el JSON propio de ESTA tarea. Antes, si no
        # existía todavía, se sustituía por "cualquier JSON disponible" en la
        # carpeta — con varias tareas corriendo/guardadas, eso terminaba
        # devolviendo las detecciones de una zona completamente distinta.
        # Si el propio no existe, se omite result_json_url (el frontend no
        # debe recibir datos que no le corresponden).
        if json_name and storage_module.result_file_exists(json_name):
            response["result_json_url"] = f"{PUBLIC_BASE_URL}/result/{json_name}"
        response["detection_count"] = task.get("detection_count", 0)

    if task["status"] == "error" and task.get("overlap_detail") is not None:
        response["overlap_detail"] = task["overlap_detail"]
        response["overlap_total"] = task.get("overlap_total", 0)

    if task.get("analysis_status") is not None:
        response["analysis_status"] = task["analysis_status"]
        response["analysis_message"] = task.get("analysis_message", "")

    return response


@app.delete("/status/{task_id}")
async def delete_status(task_id: str):
    """Borra el documento de la tarea — llamado por el frontend al eliminar
    una zona (guardada o no) desde Vista Principal, junto con la limpieza de
    archivos que ya hacía (deleteResultFile/deleteFinalsFile/deleteTaskImages).
    Antes esto no hacía falta: `tasks` vivía en memoria y se perdía solo al
    reiniciar uvicorn. Ahora que persiste en Mongo, sin este endpoint una
    zona "eliminada" dejaba su tarea huérfana en la colección para siempre."""
    await task_store.delete_task(task_id)
    return {"message": "Tarea eliminada"}


# =============================================================================
# ENDPOINT: SERVIR LA IMAGEN RESULTADO
# =============================================================================

@app.get("/result/{filename}")
async def get_result(filename: str):
    """Sirve la imagen anotada o el JSON de detecciones — vive en Google
    Cloud Storage (ver storage.py), no en disco local, para que sobreviva a
    un redeploy/pérdida de disco de la VM y sea visible para todo el equipo
    sin importar quién generó la zona. El bucket es privado; este endpoint
    (que ya exige sesión válida, como el resto de la API) sigue siendo el
    único punto de acceso — mismo control que existía con disco local."""
    content = storage_module.download_result_file(filename)
    if content is None:
        return {"status": "error", "message": "Archivo no encontrado"}
    media = "application/json" if filename.endswith(".json") else "image/png"
    return Response(content=content, media_type=media)


@app.delete("/result/{filename}")
async def delete_result(filename: str):
    """Borra un archivo de resultado (imagen o JSON) de GCS — usado por
    "Eliminar zona" en la Vista Principal para no dejar los archivos
    huérfanos cuando se borra un análisis guardado."""
    if storage_module.result_file_exists(filename):
        storage_module.delete_result_file(filename)
        return {"message": f"{filename} eliminado"}
    return {"message": f"{filename} no encontrado"}


@app.delete("/finals/{filename}")
async def delete_finals(filename: str):
    """
    Borra el ortomosaico .tif de joining/finals/ — usado al eliminar una zona
    guardada desde la Vista Principal.

    Sin este endpoint, joining/finals/ nunca se limpiaba para NINGUNA zona
    (ni siquiera las guardadas y luego borradas correctamente desde la UI):
    deleteResultFile solo apuntaba a detecting/output/. Cada .tif pesa varios
    MB, y se confirmó que ya había 80 archivos (912 MB) acumulados desde
    junio — un problema real de espacio en disco de cara a un despliegue en
    la nube con disco limitado.
    """
    file_path = os.path.join(FINALS_DIR, filename)
    if os.path.exists(file_path):
        os.remove(file_path)
        return {"message": f"{filename} eliminado"}
    return {"message": f"{filename} no encontrado"}


# =============================================================================
# ENDPOINT: IMÁGENES DE UNA TAREA (snapshot)
#
# UPLOAD_DIR es una carpeta compartida — al retomar la vista de carga de una
# tarea antigua, listar UPLOAD_DIR mostraría las imágenes de la carga MÁS
# RECIENTE, no las de la tarea que se está retomando. Estos endpoints sirven
# la copia ("foto") tomada en /generate al momento de crear cada tarea.
# =============================================================================

@app.get("/task-images/{task_id}")
async def list_task_images(task_id: str):
    """Retorna los nombres de archivo con los que ESTA tarea arrancó."""
    snapshot_dir = os.path.join(TASK_IMAGES_DIR, task_id)
    if not os.path.isdir(snapshot_dir):
        return {"archivos": []}
    return {"archivos": [f for f in os.listdir(snapshot_dir) if is_jpg(f)]}


@app.get("/task-images/{task_id}/{filename}")
async def get_task_image(task_id: str, filename: str):
    """Sirve una imagen del snapshot de una tarea puntual."""
    file_path = os.path.join(TASK_IMAGES_DIR, task_id, filename)
    if not os.path.exists(file_path):
        return {"status": "error", "message": "Archivo no encontrado"}
    return FileResponse(file_path, media_type="image/jpeg")


@app.delete("/task-images/{task_id}")
async def delete_task_images(task_id: str):
    """Borra el snapshot completo de una tarea — usado al eliminar una zona
    (en progreso, pendiente de revisión o guardada) para no dejar copias
    huérfanas en el servidor."""
    snapshot_dir = os.path.join(TASK_IMAGES_DIR, task_id)
    if os.path.isdir(snapshot_dir):
        shutil.rmtree(snapshot_dir, ignore_errors=True)
        return {"message": f"Imágenes de la tarea {task_id} eliminadas"}
    return {"message": "No había imágenes guardadas para esta tarea"}