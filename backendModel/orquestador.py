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
from pydantic import BaseModel
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
# CONEXIÓN A MONGODB (Atlas), un solo cliente para todo el proceso, creado
# al arrancar y cerrado al apagar. auth.py recibe la referencia vía
# set_db() en vez de abrir su propia conexión.
# =============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    # No se usa get_default_database(): depende de que el connection string
    # de Atlas incluya el nombre de la base en el path, y la plantilla que
    # da Atlas por defecto no lo trae, se pide explícito por env var para
    # no romper en el setup de cada uno.
    mongo_client = AsyncMongoClient(os.environ["MONGODB_URI"])
    db = mongo_client[os.environ.get("MONGODB_DB_NAME", "condorfinder")]
    auth_module.set_db(db)
    resources_module.set_db(db)
    routing_module.set_db(db)
    analyses_module.set_db(db)

    # Índices, create_index es idempotente (no rompe nada si ya existen),
    # así que se piden cada vez que arranca el proceso en vez de una
    # migración aparte. Ninguna colección tenía más que el índice por
    # defecto de _id hasta ahora, estos cubren los filtros que sí corren en
    # cada request (get_current_user por username) o con frecuencia
    # (list_pending_tasks/is_pipeline_busy, la detección de duplicados de
    # HDU7 en cada guardado).
    await db.users.create_index("username", unique=True)
    await db.analyses.create_index([("crs", 1), ("historical", 1)])
    # Zona y versión: la evolución de una zona ordena sus análisis por fecha
    # de captura, y reasignar una versión los busca por su tarea de origen.
    await db.analyses.create_index([("zoneId", 1), ("captureDate", 1)])
    await db.analyses.create_index("sourceTaskId")
    await db.zones.create_index("owner")
    # GCS_BUCKET_NAME sin setear => modo local (ver storage.py), así el
    # backend sigue corriendo 100% en WSL sin depender de ninguna cuenta de
    # GCP; solo la VM en producción lo setea de verdad.
    storage_module.set_bucket(os.environ.get("GCS_BUCKET_NAME"))
    storage_module.set_local_fallback_dir(OUTPUT_DIR)

    # Segunda conexión, síncrona, run_pipeline/run_analysis corren en
    # threading.Thread normal (no en una corutina), y el driver async no es
    # seguro de usar ahí. Misma URI/base, dos conexiones al mismo lugar.
    sync_mongo_client = MongoClient(os.environ["MONGODB_URI"])
    sync_db = sync_mongo_client[os.environ.get("MONGODB_DB_NAME", "condorfinder")]
    task_store.set_db(db, sync_db)
    await db.tasks.create_index([("status", 1), ("reviewed", 1), ("created_at", 1)])

    await auth_module.seed_admin_user(db)

    # Cualquier tarea que haya quedado "en curso" es de la vida ANTERIOR del
    # proceso, su hilo ya no existe, nada la va a volver a mover. Se marca
    # como error acá antes de aceptar tráfico, en vez de dejarla mostrando
    # progreso que nunca va a avanzar.
    await task_store.reconcile_orphaned_tasks()

    yield
    sync_mongo_client.close()
    await mongo_client.close()


app = FastAPI(lifespan=lifespan)

# localhost:8080 siempre permitido (desarrollo local), EXTRA_CORS_ORIGINS
# (coma-separado) agrega el/los orígenes del frontend desplegado sin
# reemplazar el de desarrollo. Ej: "https://condorfinder.diegogcs2003.workers.dev,https://condorfinder.cl"
_extra_origins = [o.strip() for o in os.environ.get("EXTRA_CORS_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", *_extra_origins],
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
# PUBLIC_BASE_URL: host desde el que el FRONTEND alcanza este backend, se
# usa para construir result_url/result_json_url en las respuestas. Default
# localhost:8000 no rompe nada en desarrollo local; en la VM de producción
# se setea a http://<IP_VM>:8000 vía backendModel/.env.
#
# NODEODM_HOST: host desde el que ESTE PROCESO alcanza a NodeODM. En WSL
# local, NodeODM corre en la misma máquina (localhost). En docker-compose,
# backend y nodeodm son contenedores distintos, el backend le habla a
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

# Los modelos de elevación ya NO viven en rutas fijas compartidas: cada vuelo
# guarda los suyos en FINALS_DIR junto a su ortomosaico. Ver dem_paths_for().

# Versión del algoritmo de cálculo de volumen. Cada análisis guardado queda
# sellado con este valor. Sirve para que la evolución de una zona pueda
# distinguir un cambio real en el basural de un cambio en cómo se mide:
# cuando SP2 mejore la precisión, dos análisis con distinta versión no son
# comparables como si nada hubiera cambiado. Subirlo a mano al tocar
# volumeCalc.py de forma que altere los resultados.
VOLUME_ALGORITHM_VERSION = 1

# joining/images/ es una carpeta COMPARTIDA, se reusa para cada carga nueva.
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
# Persistido en Mongo vía task_store.py (colección "tasks"), antes era un
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

    UPLOAD_DIR es una única carpeta compartida por TODO el backend, no por
    sesión ni por usuario. En local, con una sola persona probando, nunca se
    nota. Pero al desplegar en la nube para el Sprint 1, dos personas
    (compañeros de equipo, jurado) pueden pegarle al mismo backend a la vez:
    si el usuario B sube imágenes o inicia una generación mientras la tarea
    del usuario A todavía está leyendo esa carpeta, se mezclan sets de
    imágenes de zonas distintas silenciosamente. Este chequeo bloquea esa
    ventana, ver uso en /upload, /upload (DELETE) y /generate.

    "running" se incluye porque es el estado inicial de una tarea recién
    creada en /generate, antes de que su hilo en background alcance a
    marcarla "checking_overlap", sin esto, dos /generate casi simultáneos
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
    desincronizado de lo que realmente está pasando en el backend, el
    botón "Generar mapa unificado" podía verse habilitado después de un F5
    aunque el servidor siguiera ocupado con otra tarea.
    """
    return {"busy": await is_pipeline_busy()}

@app.get("/upload/{filename}")
async def get_uploaded_image(filename: str):
    """Sirve una imagen ya subida, usado para mostrar las miniaturas al
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

        # Fecha del vuelo, leída del EXIF de las fotos. Es la que ordena las
        # versiones de una zona en el tiempo, así que se captura acá, mientras
        # las imágenes originales todavía están en UPLOAD_DIR: después del
        # unificado solo queda el ortomosaico, que ya no la trae.
        #
        # Si ninguna foto la tiene se cae a la fecha de carga y se marca como
        # estimada, para que la interfaz pueda advertirlo y permitir
        # corregirla. Un None silencioso desordenaría la historia de la zona
        # sin que nadie se entere.
        fecha_captura = solapamiento.fecha_captura_set(UPLOAD_DIR)
        task_store.update_task_sync(
            task_id,
            capture_date=fecha_captura or datetime.now(timezone.utc).isoformat(),
            capture_date_estimated=fecha_captura is None,
        )

        # Punto de chequeo de cancelación, solo puede interrumpir AQUÍ, entre
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

        # Progreso real de ODM (0-100) guardado en el documento de la tarea,
        # para que /status/{task_id} lo exponga y la barra del frontend avance
        # de verdad durante la unificación en vez de quedarse en un valor fijo.
        # Se escribe solo cuando cambia en al menos un punto porcentual: el
        # sondeo es cada 10s, pero ODM puede repetir el mismo número varias
        # veces seguidas y no tiene sentido escribir en Mongo por eso.
        ultimo_reportado = [-1.0]

        def on_odm_progress(pct: float):
            pct = max(0.0, min(100.0, pct))
            if abs(pct - ultimo_reportado[0]) < 1.0:
                return
            ultimo_reportado[0] = pct
            task_store.update_task_sync(task_id, stage_progress=pct)

        task_store.update_task_sync(task_id, stage_progress=0.0)
        filename = joinOrtho.join(
            opc,
            on_task_created=on_odm_task_created,
            on_progress=on_odm_progress,
        )
        fileplace = os.path.join(FINALS_DIR, filename)

        if task_store.get_task_sync(task_id).get("cancel_requested"):
            task_store.update_task_sync(task_id, status="cancelled", message="Cancelado por el usuario")
            # El .tif ya se generó y se movió a FINALS_DIR antes de que se
            # notara la cancelación (varios MB cada uno), sin este cleanup
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
        result_thumbnail_filename = base + "_thumb.png"

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
            # este cleanup quedaban huérfanos para siempre, es la causa de
            # los archivos sueltos en detecting/output/ que no correspondían
            # a ninguna zona del listado.
            for fname in (result_filename, result_json_filename, result_thumbnail_filename):
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

        # El pipeline termina en la detección. El volumen YA NO se calcula
        # acá: se calcula cuando el trabajador entra a la vista de análisis y
        # lo pide, para que cada medición quede registrada con su propia fecha
        # y una zona tenga historia real en el tiempo. La tarea queda
        # "pendiente de análisis", que pasa de ser una excepción a ser el
        # estado normal después de generar un mapa.
        #
        # Antes esta subida a GCS esperaba a run_analysis porque el JSON no
        # tenía volumen hasta entonces. Ahora sube el JSON con las detecciones
        # crudas, y cada análisis lo vuelve a subir ya enriquecido.
        for fname, ctype in (
            (result_filename, "image/png"),
            (result_json_filename, "application/json"),
            (result_thumbnail_filename, "image/png"),
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
            result_thumbnail_filename=result_thumbnail_filename,
            detection_count=detection_count,
        )

        # El snapshot de task_images/ solo sirve para retomar la vista de
        # carga de una tarea "en progreso" (botón "Ir a Carga"), apenas el
        # pipeline llega a "done" la tarea pasa a "pendiente de análisis" en
        # el frontend, que usa "Ir a Análisis" en su lugar y ya no necesita
        # esas imágenes. Se borra acá mismo para que la vista de carga
        # vuelva a verse "nueva" desde ese momento en adelante, en vez de
        # dejar la copia huérfana hasta que el usuario elimine la zona.
        snapshot_dir = os.path.join(TASK_IMAGES_DIR, task_id)
        if os.path.isdir(snapshot_dir):
            shutil.rmtree(snapshot_dir, ignore_errors=True)

        # Retención: solo el vuelo recién generado queda medible. Los archivos
        # pesados de las generaciones anteriores (modelos de elevación y
        # ortomosaico) se liberan acá. Ver la docstring de la función para por
        # qué esto nunca deja una versión sin cifras.
        liberar_archivos_de_vuelos_previos(conservar_task_id=task_id)

        # odm_task ya no hace falta una vez terminado el pipeline, liberar el
        # handle en memoria (nunca iba a sobrevivir un reinicio de todos
        # modos, pero no hay razón para dejarlo colgado hasta entonces).
        task_store.pop_odm_task_handle(task_id)

    except joinOrtho.TaskCancelledError:
        task_store.update_task_sync(task_id, status="cancelled", message="Cancelado por el usuario")
        task_store.pop_odm_task_handle(task_id)

    except Exception as e:
        task_store.update_task_sync(task_id, status="error", message=str(e))
        task_store.pop_odm_task_handle(task_id)


class GenerateRequest(BaseModel):
    # SP1, 0 = joinOrtho.presetfast (óptimo/rápido, el único preset que se
    # usaba hasta ahora), 1 (o cualquier valor != 0) = joinOrtho.presethigh
    # (preciso/lento). Default 0 para no romper ningún caller que todavía no
    # mande este campo.
    opc: int = 0


@app.post("/generate")
async def generate_map(request: GenerateRequest = GenerateRequest()):
    """
    Inicia el pipeline join + detect en background.
    Verifica que ODM esté corriendo antes de iniciar.
    Retorna un task_id para consultar el estado.
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
        # Reemplaza taskRegistry.ts (localStorage), GET /tasks/pending usa
        # esto para ordenar la lista que ve Vista Principal.
        "created_at": datetime.now(timezone.utc),
        # true una vez que el análisis se guardó (analyses.py::mark_reviewed)
        #, deja de aparecer en GET /tasks/pending sin borrar el documento,
        # así "Analizar volumen" puede seguir recalculando sobre esta misma
        # tarea aunque el análisis ya esté guardado.
        "reviewed": False,
    })

    # UPLOAD_DIR es compartido entre todas las tareas, se sobreescribe con
    # cada carga nueva. Se guarda una copia ("foto") del set de imágenes con
    # el que ESTA tarea arrancó, para poder mostrarlo correctamente después
    # (ej. al retomar desde la Vista Principal) aunque para entonces
    # UPLOAD_DIR ya tenga las imágenes de otra carga distinta.
    snapshot_dir = os.path.join(TASK_IMAGES_DIR, task_id)
    os.makedirs(snapshot_dir, exist_ok=True)
    for fname in os.listdir(UPLOAD_DIR):
        if is_jpg(fname):
            shutil.copyfile(os.path.join(UPLOAD_DIR, fname), os.path.join(snapshot_dir, fname))

    thread = threading.Thread(target=run_pipeline, args=(task_id, request.opc), daemon=True)
    thread.start()

    return {"task_id": task_id, "status": "running"}


# =============================================================================
# ENDPOINT: CANCELAR UNA TAREA
#
# Durante "checking_overlap" o entre fases: se aplica al instante (chequeo
# de cancel_requested en run_pipeline).
#
# Durante "joining": se le pide a ODM (Docker) que cancele su propia tarea
# vía odm_task.cancel(), cancelación real, no solo dejar de avanzar.
#
# Durante "detecting" (inferencia YOLO): no hay a quién pedirle cancelar,
# es una llamada local bloqueante, solo se marca cancel_requested, pero
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
            return {"status": "ok", "message": "Cancelación solicitada, se aplica de inmediato en ODM"}
        except Exception:
            pass  # sigue como cancel_requested para el próximo punto de control

    return {"status": "ok", "message": "Cancelación solicitada"}


# =============================================================================
# ENDPOINT: CALCULAR VOLUMEN (HDU2)
# Se ejecuta separado del pipeline, requiere que el mapa ya esté generado.
# =============================================================================

def dem_paths_for(task: dict) -> tuple[str, str, str]:
    """Rutas de los modelos de elevación de ESTA tarea: dsm, dtm y ndsm.

    Se derivan del nombre del ortomosaico, que joinOrtho.join() guarda como
    "ortho_<uuid>.tif" junto a "dsm_<uuid>.tif" y "dtm_<uuid>.tif". El nDSM se
    calcula a partir de esos dos y se cachea con el mismo sufijo.

    Antes esto eran tres constantes globales apuntando a una carpeta
    compartida que cada vuelo sobrescribía. Mientras el volumen se calculaba
    dentro del pipeline no importaba, porque se usaban en el acto; ahora que
    el cálculo ocurre después, usar las compartidas significaría medir un
    vuelo con el terreno de otro.
    """
    ortho_name = os.path.basename(task.get("ortho_path") or "")
    sufijo = ortho_name[len("ortho_"):-len(".tif")] if ortho_name.startswith("ortho_") else ""
    return (
        os.path.join(FINALS_DIR, f"dsm_{sufijo}.tif"),
        os.path.join(FINALS_DIR, f"dtm_{sufijo}.tif"),
        os.path.join(FINALS_DIR, f"ndsm_{sufijo}.tif"),
    )


def liberar_archivos_de_vuelos_previos(conservar_task_id: str) -> None:
    """Borra de FINALS_DIR los archivos de los vuelos que ya no se necesitan.

    Se llama al terminar una generación. Se conservan TRES grupos:

      1. El vuelo recién generado.
      2. Los que tienen el mapa hecho pero todavía sin análisis guardado (ver
         task_store.list_unreviewed_done_sync para el porqué).
      3. Los que SÍ tienen análisis guardado, o sea toda versión que forma
         parte de la historia de alguna zona.

    El grupo 3 es nuevo. Antes se podaban justamente esos, con el argumento de
    que un vuelo ya medido y superado no necesitaba poder volver a medirse. Eso
    dejó de ser cierto cuando el borrado pasó a devolver a vigente la versión
    anterior: al eliminar la captura más nueva de una zona, la anterior
    resucitaba sin sus modelos de elevación, imposible de re-medir para
    siempre, y encima la interfaz seguía diciendo "existe una captura más
    reciente", que ya era falso.

    Con esto la poda queda casi sin trabajo, y está bien: su función ahora es
    de red de seguridad, recoger archivos de vuelos que no le pertenecen a
    nadie (por ejemplo restos de una versión borrada antes de este cambio). El
    costo es disco, y se asumió a conciencia a cambio de que cualquier versión
    guardada se pueda volver a medir siempre.

    Es best-effort: si un borrado falla, se sigue con el resto. Un archivo que
    quede sin borrar cuesta disco, pero un error acá no debe tumbar un
    pipeline que ya terminó bien.
    """
    def sufijo_de(t: dict) -> str:
        _, _, ndsm = dem_paths_for(t)
        return os.path.basename(ndsm)[len("ndsm_"):-len(".tif")]

    task = task_store.get_task_sync(conservar_task_id) or {}
    sufijo_vigente = sufijo_de(task)

    if not sufijo_vigente:
        # Sin sufijo no se puede saber cuál conservar, y borrar a ciegas se
        # llevaría también el vuelo vigente. Mejor no tocar nada: el costo es
        # disco, no datos.
        print("No se liberaron archivos: la tarea no tiene ortomosaico asociado", file=sys.stderr)
        return

    # Además del vuelo recién generado, se respetan los que tienen el mapa
    # hecho pero todavía ningún análisis guardado. Sin esto, generar un mapa
    # dejaba inservible para siempre a cualquier pendiente anterior: seguía
    # apareciendo en la lista sin poder medirse nunca, y como una versión solo
    # nace al guardarse su primer análisis, tampoco podía llegar a ser una.
    protegidos = {sufijo_vigente}
    try:
        for pendiente in task_store.list_unreviewed_done_sync():
            s = sufijo_de(pendiente)
            if s:
                protegidos.add(s)

        # Grupo 3: todo vuelo que tenga al menos un análisis guardado. Se
        # resuelve por sourceTaskId, que es lo que identifica a la versión, y
        # de ahí al sufijo de sus archivos.
        sync_db = task_store.get_sync_db()
        for source_task_id in sync_db.analyses.distinct("sourceTaskId"):
            if not source_task_id:
                continue
            t = task_store.get_task_sync(source_task_id)
            if not t:
                continue
            s = sufijo_de(t)
            if s:
                protegidos.add(s)
    except Exception as e:
        # Si no se puede saber a quién proteger, no se poda nada: el costo de
        # equivocarse acá es perder un vuelo, el de no podar es disco.
        print(f"No se liberaron archivos, no se pudo listar protegidos: {e}", file=sys.stderr)
        return

    prefijos = ("dsm_", "dtm_", "ndsm_", "ortho_")
    try:
        for nombre in os.listdir(FINALS_DIR):
            if not nombre.endswith(".tif"):
                continue
            if not nombre.startswith(prefijos):
                continue
            if any(s in nombre for s in protegidos):
                continue
            try:
                os.remove(os.path.join(FINALS_DIR, nombre))
                print(f"Liberado archivo de vuelo antiguo: {nombre}", file=sys.stderr)
            except Exception:
                pass
    except FileNotFoundError:
        pass


def run_analysis(task_id: str):
    """Calcula volumen por detección usando el nDSM del vuelo de esta tarea.

    Recalcula siempre, incluso si ya se había analizado antes: cada llamada es
    una medición nueva que el frontend guarda con su propia fecha. Es seguro
    repetirla porque volumeCalc.enrich() parte de los campos crudos de cada
    detección (bbox/polygon/class) y sobrescribe los derivados, sin acumular
    sobre un resultado anterior.
    """
    try:
        task_store.update_task_sync(task_id, analysis_status="running", analysis_message="Calculando volúmenes con datos del modelo 3D...")

        task = task_store.get_task_sync(task_id)
        detections_json = task["detections_json_path"]
        ortho_path = task["ortho_path"]
        json_name = task.get("result_json_filename", "")

        # El JSON de detecciones puede no estar en disco: storage.upload_result_file
        # borra la copia local después de subirla a GCS, para no acumular espacio
        # en la VM. Mientras el volumen se calculaba DENTRO del pipeline esto no
        # importaba, porque se enriquecía antes de subir; ahora que el cálculo
        # ocurre después, hay que traerlo de vuelta.
        #
        # En modo local (sin bucket) la descarga lee esa misma ruta, así que si
        # tampoco está ahí es una falta real y el error es correcto.
        if not os.path.exists(detections_json) and json_name:
            datos = storage_module.download_result_file(json_name)
            if datos is None:
                raise FileNotFoundError(
                    "No se encontró el archivo de detecciones de este vuelo, "
                    "ni en el disco del servidor ni en el almacenamiento."
                )
            os.makedirs(os.path.dirname(detections_json), exist_ok=True)
            with open(detections_json, "wb") as f:
                f.write(datos)

        dsm_path, dtm_path, ndsm_path = dem_paths_for(task)

        if not os.path.exists(ndsm_path):
            if os.path.exists(dsm_path) and os.path.exists(dtm_path):
                volumeCalc.compute_ndsm(dsm_path, dtm_path, ndsm_path)
            else:
                # El caso normal de que falten es que este vuelo ya no sea el
                # más reciente de su zona y sus modelos se hayan liberado. El
                # mensaje lo dice así para que el frontend lo muestre tal cual
                # en vez de un error técnico.
                raise FileNotFoundError(
                    "Los modelos de elevación de este vuelo ya no están disponibles. "
                    "Existe una captura más reciente de esta zona, así que este vuelo "
                    "solo se puede consultar, no volver a medir."
                )

        volumeCalc.enrich(detections_json, ortho_path, ndsm_path, detections_json)

        # El JSON recién enriquecido reemplaza al que se subió con las
        # detecciones crudas al terminar el pipeline. upload_result_file vuelve
        # a borrar la copia local, y el bloque de arriba la recupera si hace
        # falta analizar de nuevo.
        if json_name and os.path.exists(detections_json):
            try:
                storage_module.upload_result_file(detections_json, json_name, "application/json")
            except Exception:
                pass

        task_store.update_task_sync(
            task_id,
            analysis_status="done",
            analysis_message="Análisis de volumen completado",
            algorithm_version=VOLUME_ALGORITHM_VERSION,
        )

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
    if task.get("analysis_status") == "running":
        return {"status": "already_running", "message": "El análisis ya está en curso"}

    # Ya NO se corta con "already_done". Cada llamada es una medición nueva,
    # que el frontend guarda como un análisis aparte con su propia fecha: es
    # lo que le da historia a una zona. El atajo anterior existía porque el
    # pipeline calculaba el volumen solo y este endpoint nunca tenía trabajo
    # real que hacer.

    # Sin los modelos de elevación de este vuelo no hay nada que calcular, y
    # conviene decirlo antes de lanzar el hilo para que el frontend reciba el
    # motivo de inmediato en vez de tener que sondear un estado de error.
    dsm_path, dtm_path, ndsm_path = dem_paths_for(task)
    if not os.path.exists(ndsm_path) and not (os.path.exists(dsm_path) and os.path.exists(dtm_path)):
        return {
            "status": "unavailable",
            "message": (
                "Los modelos de elevación de este vuelo ya no están disponibles. "
                "Existe una captura más reciente de esta zona, así que este vuelo "
                "solo se puede consultar, no volver a medir."
            ),
        }

    thread = threading.Thread(target=run_analysis, args=(task_id,), daemon=True)
    thread.start()
    return {"status": "running"}


# =============================================================================
# ENDPOINT: LISTAR TAREAS PENDIENTES (reemplaza taskRegistry.ts)
# =============================================================================

@app.get("/tasks/pending")
async def list_pending_tasks():
    """Vista Principal consulta esto directo en vez de mantener su propia
    lista de task_id en localStorage, ver docstring de
    task_store.list_pending_tasks() para el motivo completo. Devuelve las
    tareas "en progreso" o "done pero todavía no guardadas como análisis"
    (una vez guardada, analyses.py marca la tarea como reviewed=True, ver
    task_store.mark_reviewed, y deja de aparecer acá, sin borrar el
    documento). "cancelled" se incluye para que el frontend la descubra,
    limpie sus archivos, y la borre, igual que hacía antes al encontrarla
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
            thumb_name = task.get("result_thumbnail_filename", "")
            if thumb_name and storage_module.result_file_exists(thumb_name):
                entry["thumbnail_url"] = f"{PUBLIC_BASE_URL}/result/{thumb_name}"
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

    # Progreso real de la etapa en curso (0-100). Hoy solo lo reporta la
    # unificación con ODM, que es la fase larga; el resto de las etapas no
    # tiene un avance medible y el frontend las trata como bloques. Se omite
    # cuando no hay dato en vez de mandar un 0 que la barra leería como
    # "recién empezando".
    stage_progress = task.get("stage_progress")
    if task["status"] == "joining" and stage_progress is not None:
        response["stage_progress"] = float(stage_progress)

    # Datos de la captura: el frontend los guarda en el análisis para poder
    # ordenar las versiones de una zona en el tiempo.
    if task.get("capture_date"):
        response["capture_date"] = task["capture_date"]
        response["capture_date_estimated"] = bool(task.get("capture_date_estimated"))
    if task.get("algorithm_version") is not None:
        response["algorithm_version"] = task["algorithm_version"]

    # Si este vuelo todavía se puede volver a medir. Es falso cuando sus
    # modelos de elevación ya se liberaron porque hay una captura más nueva de
    # la misma zona; la vista de análisis usa esto para deshabilitar el botón
    # con el motivo, en vez de dejar que el usuario lo presione y falle.
    if task["status"] == "done":
        dsm_path, dtm_path, ndsm_path = dem_paths_for(task)
        response["can_analyze"] = os.path.exists(ndsm_path) or (
            os.path.exists(dsm_path) and os.path.exists(dtm_path)
        )

    if task["status"] == "done" and task["result_filename"]:
        response["result_url"] = f"{PUBLIC_BASE_URL}/result/{task['result_filename']}"
        json_name = task.get("result_json_filename", "")
        # Importante: solo se usa el JSON propio de ESTA tarea. Antes, si no
        # existía todavía, se sustituía por "cualquier JSON disponible" en la
        # carpeta, con varias tareas corriendo/guardadas, eso terminaba
        # devolviendo las detecciones de una zona completamente distinta.
        # Si el propio no existe, se omite result_json_url (el frontend no
        # debe recibir datos que no le corresponden).
        if json_name and storage_module.result_file_exists(json_name):
            response["result_json_url"] = f"{PUBLIC_BASE_URL}/result/{json_name}"
        thumb_name = task.get("result_thumbnail_filename", "")
        if thumb_name and storage_module.result_file_exists(thumb_name):
            response["thumbnail_url"] = f"{PUBLIC_BASE_URL}/result/{thumb_name}"
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
    """Borra el documento de la tarea, llamado por el frontend al eliminar
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
    """Sirve la imagen anotada o el JSON de detecciones, vive en Google
    Cloud Storage (ver storage.py), no en disco local, para que sobreviva a
    un redeploy/pérdida de disco de la VM y sea visible para todo el equipo
    sin importar quién generó la zona. El bucket es privado; este endpoint
    (que ya exige sesión válida, como el resto de la API) sigue siendo el
    único punto de acceso, mismo control que existía con disco local."""
    content = storage_module.download_result_file(filename)
    if content is None:
        return {"status": "error", "message": "Archivo no encontrado"}
    media = "application/json" if filename.endswith(".json") else "image/png"
    return Response(content=content, media_type=media)


@app.delete("/result/{filename}")
async def delete_result(filename: str):
    """Borra un archivo de resultado (imagen o JSON) de GCS, usado por
    "Eliminar zona" en la Vista Principal para no dejar los archivos
    huérfanos cuando se borra un análisis guardado."""
    if storage_module.result_file_exists(filename):
        storage_module.delete_result_file(filename)
        return {"message": f"{filename} eliminado"}
    return {"message": f"{filename} no encontrado"}


@app.delete("/finals/{filename}")
async def delete_finals(filename: str):
    """
    Borra el ortomosaico .tif de joining/finals/, usado al eliminar una zona
    guardada desde la Vista Principal.

    Sin este endpoint, joining/finals/ nunca se limpiaba para NINGUNA zona
    (ni siquiera las guardadas y luego borradas correctamente desde la UI):
    deleteResultFile solo apuntaba a detecting/output/. Cada .tif pesa varios
    MB, y se confirmó que ya había 80 archivos (912 MB) acumulados desde
    junio, un problema real de espacio en disco de cara a un despliegue en
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
# UPLOAD_DIR es una carpeta compartida, al retomar la vista de carga de una
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
    """Borra el snapshot completo de una tarea, usado al eliminar una zona
    (en progreso, pendiente de revisión o guardada) para no dejar copias
    huérfanas en el servidor."""
    snapshot_dir = os.path.join(TASK_IMAGES_DIR, task_id)
    if os.path.isdir(snapshot_dir):
        shutil.rmtree(snapshot_dir, ignore_errors=True)
        return {"message": f"Imágenes de la tarea {task_id} eliminadas"}
    return {"message": "No había imágenes guardadas para esta tarea"}