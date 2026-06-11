import os
import sys
import uuid
import threading
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from typing import List
import shutil
import requests

# Agrega los paths para poder importar los módulos del compañero
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

from joining import joinOrtho
from joining import Reconociemiento_solapamiento as solapamiento
from detecting import detectingOrtho
from detecting import volumeCalc

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =============================================================================
# DIRECTORIOS
# =============================================================================

UPLOAD_DIR  = os.path.join(BASE_DIR, "joining", "images")
FINALS_DIR  = os.path.join(BASE_DIR, "joining", "finals")
OUTPUT_DIR  = os.path.join(BASE_DIR, "detecting", "output")
DSM_PATH   = os.path.join(BASE_DIR, "joining","output","odm_dem","dsm.tif")
DTM_PATH   = os.path.join(BASE_DIR, "joining","output","odm_dem","dtm.tif")
NDSM_PATH  = os.path.join(BASE_DIR, "joining","output","odm_dem","ndsm.tif")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(FINALS_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# =============================================================================
# ESTADO DE TAREAS EN MEMORIA
# Estructura: { task_id: { "status": str, "message": str, "result_url": str } }
# Estados posibles: "running", "done", "error"
# =============================================================================

tasks: dict[str, dict] = {}


# =============================================================================
# UTILIDADES
# =============================================================================

def is_jpg(filename: str) -> bool:
    return filename.lower().endswith((".jpg", ".jpeg"))

def check_odm_running() -> bool:
    """Verifica que el nodo ODM de Docker esté corriendo en localhost:3000."""
    try:
        r = requests.get("http://localhost:3000/info", timeout=3)
        return r.status_code == 200
    except Exception:
        return False


# =============================================================================
# ENDPOINTS DE CARGA DE IMÁGENES (lógica existente, sin cambios)
# =============================================================================

@app.post("/upload")
async def upload_images(images: List[UploadFile] = File(...)):
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

@app.delete("/upload/{filename}")
async def delete_image(filename: str):
    file_path = os.path.join(UPLOAD_DIR, filename)
    if os.path.exists(file_path):
        os.remove(file_path)
        return {"message": f"Imagen {filename} eliminada"}
    return {"message": f"Imagen {filename} no encontrada"}

@app.delete("/upload")
async def delete_all_images():
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
        tasks[task_id]["status"] = "checking_overlap"
        tasks[task_id]["message"] = "Verificando solapamiento entre imágenes..."

        resultado = solapamiento.verificar_set_vuelo(
            UPLOAD_DIR,
            fov_horizontal=82.1,
            altitud_vuelo=50,
            umbral_min_solape=60
        )

        if not resultado["aprobado"]:
            tasks[task_id]["status"] = "error"
            tasks[task_id]["message"] = resultado["mensaje"]
            tasks[task_id]["overlap_detail"] = resultado["detalle"]
            tasks[task_id]["overlap_total"] = resultado["total_pares"]
            return
        
        tasks[task_id]["status"] = "joining"
        tasks[task_id]["message"] = "Unificando imágenes con ODM..."

        filename = joinOrtho.join(opc)
        fileplace = os.path.join(FINALS_DIR, filename)

        tasks[task_id]["status"] = "detecting"
        tasks[task_id]["message"] = "Detectando basura con YOLOv8..."

        final, detection_count, DETECTIONS_JSON = detectingOrtho.detect(fileplace)
        #detection_count = 0  # Esto fuerza que se pueda comprobar el caso en que no se detecte basura.
        base = os.path.basename(final)
        result_filename = base + ".png"
        result_json_filename = base + ".json"

        ENRICHED_JSON = os.path.join(BASE_DIR, f"{DETECTIONS_JSON}")

        if not os.path.exists(NDSM_PATH):
            volumeCalc.compute_ndsm(DSM_PATH, DTM_PATH, NDSM_PATH)

        volumeCalc.enrich(
            DETECTIONS_JSON,
            fileplace,
            NDSM_PATH,
            ENRICHED_JSON,
        )


        tasks[task_id]["status"] = "done"
        tasks[task_id]["message"] = "Proceso completado"
        tasks[task_id]["result_filename"] = result_filename
        tasks[task_id]["result_json_filename"] = result_json_filename
        tasks[task_id]["detection_count"] = detection_count

    except Exception as e:
        tasks[task_id]["status"] = "error"
        tasks[task_id]["message"] = str(e)


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
            "message": "El nodo ODM no está corriendo. Inicia Docker con: docker run -ti -p 3000:3000 webodm/nodeodm"
        }

    task_id = str(uuid.uuid4())
    tasks[task_id] = {
        "status": "running",
        "message": "Iniciando pipeline...",
        "result_filename": None,
    }

    thread = threading.Thread(target=run_pipeline, args=(task_id, 0), daemon=True)
    thread.start()

    return {"task_id": task_id, "status": "running"}


# =============================================================================
# ENDPOINT: CONSULTAR ESTADO DE UNA TAREA
# =============================================================================

@app.get("/status/{task_id}")
async def get_status(task_id: str):
    """
    El frontend consulta este endpoint cada N segundos.
    Cuando status = "done", result_url contiene la URL de la imagen anotada.
    """
    task = tasks.get(task_id)
    if not task:
        return {"status": "error", "message": "Tarea no encontrada"}

    response = {
        "status": task["status"],
        "message": task["message"],
    }

    if task["status"] == "done" and task["result_filename"]:
        response["result_url"] = f"http://localhost:8000/result/{task['result_filename']}"
        json_name = task.get("result_json_filename", "")
        # Si el JSON del run no existe aún (compañero en progreso), usar cualquier JSON disponible
        if json_name and not os.path.exists(os.path.join(OUTPUT_DIR, json_name)):
            available = sorted(f for f in os.listdir(OUTPUT_DIR) if f.endswith(".json"))
            if available:
                json_name = available[-1]
        if json_name and os.path.exists(os.path.join(OUTPUT_DIR, json_name)):
            response["result_json_url"] = f"http://localhost:8000/result/{json_name}"
        response["detection_count"] = task.get("detection_count", 0)

    if task["status"] == "error" and task.get("overlap_detail") is not None:
        response["overlap_detail"] = task["overlap_detail"]
        response["overlap_total"] = task.get("overlap_total", 0)

    return response


# =============================================================================
# ENDPOINT: SERVIR LA IMAGEN RESULTADO
# =============================================================================

@app.get("/result/{filename}")
async def get_result(filename: str):
    """Sirve la imagen anotada o el JSON de detecciones generados por detectingOrtho."""
    file_path = os.path.join(OUTPUT_DIR, filename)
    if not os.path.exists(file_path):
        return {"status": "error", "message": "Archivo no encontrado"}
    media = "application/json" if filename.endswith(".json") else "image/png"
    return FileResponse(file_path, media_type=media)