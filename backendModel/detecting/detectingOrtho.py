import rasterio
import os
import sys
import numpy as np
from PIL import Image
from sahi import AutoDetectionModel
from sahi.predict import get_sliced_prediction
from rasterio.crs import CRS
from rasterio.warp import transform as rasterio_transform
import folium
import json
from pathlib import Path

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "model/best.pt")
OUTPUT_PATH = os.path.join(BASE_DIR, "output")
CONF        = 0.15

CLASSES = ["Residuo de construcción", "Muebles", "Metal", "Plástico", "Residuo orgánico", "Neumáticos", "Tipo de basura indefinido"]

COLORS_MAP = {
    "Residuo de construcción": "red",
    "Muebles":                 "orange",
    "Metal":                   "gray",
    "Plástico":                "blue",
    "Residuo orgánico":        "green",
    "Neumáticos":              "black",
    "Tipo de basura indefinido": "purple",
}

def detect(file_name: str):
    print("Ejecutando deteccion")

    ORTHO_PATH = file_name
    FILE_NAME = os.path.splitext(os.path.basename(file_name))[0]

    with rasterio.open(ORTHO_PATH) as src:
        geo_transform = src.transform
        src_crs = src.crs
        band_count = src.count
        img_array = src.read([1, 2, 3])
        nodata_mask = src.dataset_mask()  # shape (H, W): 255=válido, 0=sin datos

    model = AutoDetectionModel.from_pretrained(
        model_type="yolov8",
        model_path=MODEL_PATH,
        confidence_threshold=CONF,
        device="cuda",
    )

    # SAHI y YOLOv8 solo aceptan RGB — la transparencia se aplica al final
    img_array = np.moveaxis(img_array, 0, -1).astype(np.uint8)
    image = Image.fromarray(img_array, mode="RGB")
    print(f"Tamaño orthomosaico: {image.size}")

    result = get_sliced_prediction(
        image,
        model,
        slice_height=640,
        slice_width=640,
        overlap_height_ratio=0.2,
        overlap_width_ratio=0.2,
    )
    print(f"Encontradas {len(result.object_prediction_list)} detecciones")

    w, h = image.size
    scale = min(1.0, 10000 / max(w, h))
    preview = image.resize((int(w * scale), int(h * scale)))

    # Redimensionar la máscara al mismo tamaño del preview y aplicarla como alpha
    pw, ph = preview.size
    mask_pil = Image.fromarray(nodata_mask, mode="L").resize((pw, ph), Image.NEAREST)
    preview_rgba = preview.convert("RGBA")
    preview_rgba.putalpha(mask_pil)

    final = os.path.join(OUTPUT_PATH, FILE_NAME)
    preview_rgba.save(f"{final}.png")
    print(f"Archivo Final en {final}.png")

    # Guardar detecciones en JSON con coordenadas escaladas al espacio del PNG
    detections_list = []
    for i, pred in enumerate(result.object_prediction_list):
        box = pred.bbox
        cls = CLASSES[pred.category.id]
        conf = round(float(pred.score.value), 3)
        detections_list.append({
            "id": i,
            "class": cls,
            "confidence": conf,
            "bbox": {
                "minx": round(box.minx * scale),
                "miny": round(box.miny * scale),
                "maxx": round(box.maxx * scale),
                "maxy": round(box.maxy * scale),
            },
            "polygon": None,
        })

    json_path = f"{final}.json"
    with open(json_path, "w") as jf:
        json.dump({"detections": detections_list}, jf, indent=2)
    print(f"JSON detecciones en {json_path}")

    return final, len(result.object_prediction_list), json_path