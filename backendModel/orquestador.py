from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from typing import List
import shutil
import os

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "joining/images")
os.makedirs(UPLOAD_DIR, exist_ok=True)

def is_jpg(filename: str) -> bool:
    return filename.lower().endswith((".jpg", ".jpeg"))

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