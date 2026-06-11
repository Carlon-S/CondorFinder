import rasterio
import os
import sys
import numpy as np
from PIL import Image, ImageDraw
from sahi import AutoDetectionModel
from sahi.predict import get_sliced_prediction
from rasterio.crs import CRS
from rasterio.warp import transform as rasterio_transform
import folium
import json
from pathlib import Path
import cv2

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "model/best.pt")
OUTPUT_PATH = os.path.join(BASE_DIR, "output")
CONF        = 0.18

CLASSES = ["construction_waste", "furniture", "metal", "plastic", "organic_waste", "tyres", "other"]

COLORS_PIL = {
    "construction_waste": (255, 0, 0),
    "furniture": (255, 165, 0),
    "metal": (128, 128, 128),
    "plastic": (0, 0, 255),
    "organic_waste": (0, 200, 0),
    "tyres": (0, 0, 0),
    "other": (128, 0, 128),
}

COLORS_MAP = {
    "construction_waste": "red",
    "furniture": "orange",
    "metal": "gray",
    "plastic": "blue",
    "organic_waste": "green",
    "tyres": "black",
    "other": "purple",
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
        device="cpu",
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

    detections = []

    for i, pred in enumerate(result.object_prediction_list):
        box = pred.bbox
        cls = CLASSES[pred.category.id]
        conf = round(float(pred.score.value), 3)

        detection = {
            "id": i,
            "class": cls,
            "confidence": conf,
            "bbox": {
                "minx": box.minx, "miny": box.miny,
                "maxx": box.maxx, "maxy": box.maxy,
            },
            "polygon": None
        }

        # Segmentation mask → polygon contour
        if pred.mask is not None:
            bool_mask = pred.mask.bool_mask.astype(np.uint8)  # (H, W)
            contours, _ = cv2.findContours(
                bool_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
            )
            if contours:
                # Keep only the largest contour (avoids tiny noise fragments)
                contour = max(contours, key=cv2.contourArea)
                detection["polygon"] = contour.reshape(-1, 2).tolist()  # [[x,y], ...]

        detections.append(detection)

    print("Guardando archivo:", os.path.abspath("detections.json"))
    JSON = os.path.join(OUTPUT_PATH, f"{FILE_NAME}.json")
    with open(JSON, "w") as f:
        json.dump({"detections": detections}, f, indent=2)

    draw = ImageDraw.Draw(image)

    for det in detections:
        cls = det["class"]
        conf = det["confidence"]
        color = COLORS_PIL.get(cls, (255, 255, 255))
        box = det["bbox"]

        if det["polygon"] is not None:
            # Draw filled polygon with transparency + outline
            flat_points = [tuple(p) for p in det["polygon"]]
            
            # Semi-transparent fill on a separate layer
            overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
            overlay_draw = ImageDraw.Draw(overlay)
            r, g, b = color
            overlay_draw.polygon(flat_points, fill=(r, g, b, 60), outline=color)
            image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
            draw = ImageDraw.Draw(image)
        else:
            draw.rectangle(
                [box["minx"], box["miny"], box["maxx"], box["maxy"]],
                outline=color, width=4
            )

    draw.text((box["minx"], box["miny"] - 15), f"{cls} {conf}", fill=color)
    """
    draw = ImageDraw.Draw(image)
    for pred in result.object_prediction_list:
        box = pred.bbox
        cls = CLASSES[pred.category.id]
        conf = round(float(pred.score.value), 3)
        color = COLORS_PIL.get(cls, (255, 255, 255))
        draw.rectangle([box.minx, box.miny, box.maxx, box.maxy], outline=color, width=4)
        draw.text((box.minx, box.miny - 15), f"{cls} {conf}", fill=color)
    """
    w, h = image.size
    scale = min(1.0, 10000 / max(w, h))
    preview = image.resize((int(w * scale), int(h * scale)))

    # Redimensionar la máscara al mismo tamaño del preview y aplicarla como alpha
    pw, ph = preview.size
    mask_pil = Image.fromarray(nodata_mask, mode="L").resize((pw, ph), Image.NEAREST)
    preview_rgba = preview.convert("RGBA")
    preview_rgba.putalpha(mask_pil)

    final = os.path.join(OUTPUT_PATH, FILE_NAME)
    final_json = os.path.join(OUTPUT_PATH, )
    preview_rgba.save(f"{final}.png")
    print(f"Archivo Final en {final}.png")
    
    return final, len(result.object_prediction_list), JSON