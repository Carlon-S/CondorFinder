import rasterio
import os
import sys
import numpy as np
import torch
from PIL import Image
from sahi import AutoDetectionModel
from sahi.predict import get_sliced_prediction
from rasterio.crs import CRS
from rasterio.warp import transform as rasterio_transform
import folium
import json
from pathlib import Path
import cv2
from dataclasses import dataclass

from detecting.waste_classes import info_por_clase_yolo

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "model/bestseg.pt")
OUTPUT_PATH = os.path.join(BASE_DIR, "output")

CLASSES = [
    "Rubble", "Construction and demolition materials", "Asphalt milling",
    "Excavation materials", "Appliances", "Electronic equipment", "Furniture",
    "Metal barrels", "Plastic packaging", "Wood", "Pallets", "Scrap", "Plastic",
    "Vehicles", "Tyres", "Paper", "Foundry", "Asbestos", "Textile", "Mixed items",
]

@dataclass(frozen=True)
class WasteInfo:
    name_es: str    # Spanish display name
    color: str      # hex color
    density: float  # kg/m³ (bulk density, used to estimate weight from volume)

# Fallback for anything not in the table
UNKNOWN = WasteInfo("Tipo de basura indefinido", "#8404b3", 200)

WASTE_MAP = {
    # YOLO class                              name_es                      color       density
    "Rubble":                         WasteInfo("Escombros",                 "#ff1100", 1400),
    "Construction and demolition materials": WasteInfo("Residuo de construcción", "#d9480f", 400),
    "Asphalt milling":                WasteInfo("Fresado asfáltico",         "#3b3b3b", 1600),
    "Excavation materials":           WasteInfo("Material de excavación",    "#8b5a2b", 1600),
    "Appliances":                     WasteInfo("Electrodomésticos",         "#17a2b8", 150),
    "Electronic equipment":           WasteInfo("Equipos electrónicos",      "#6f42c1", 150),
    "Furniture":                      WasteInfo("Muebles",                   "#ff8400", 200),
    "Metal barrels":                  WasteInfo("Barriles metálicos",        "#7c8a99", 100),
    "Plastic packaging":              WasteInfo("Envases plásticos",         "#4f7cff", 80),
    "Wood":                           WasteInfo("Madera",                    "#c49a6c", 300),
    "Pallets":                        WasteInfo("Pallets",                   "#e0b100", 150),
    "Scrap":                          WasteInfo("Chatarra",                  "#696969", 600),
    "Plastic":                        WasteInfo("Plástico",                  "#0228c2", 80),
    "Vehicles":                       WasteInfo("Vehículos",                 "#00a3a3", 150),
    "Tyres":                          WasteInfo("Neumáticos",                "#262626", 400),
    "Paper":                          WasteInfo("Papel",                     "#9acd32", 100),
    "Foundry":                        WasteInfo("Fundición",                 "#b5179e", 1200),
    "Asbestos":                       WasteInfo("Asbesto",                   "#ff006e", 400),
    "Textile":                        WasteInfo("Textil",                    "#f783ac", 100),
    "Mixed items":                    WasteInfo("Residuos mezclados",        "#8404b3", 200),
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
        device=DEVICE,
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

    # Miniatura para vistas de lista/tarjeta (Vista Principal, hover de
    # rutas.tsx) — la imagen completa pesa varios MB y es innecesaria ahí;
    # el nombre sigue la misma convención que result_filename en
    # orquestador.py (base + sufijo), así que no hace falta cambiar la
    # firma de retorno de esta función.
    thumb_max = 800
    thumb_scale = min(1.0, thumb_max / max(pw, ph))
    thumbnail = preview_rgba.resize((max(1, int(pw * thumb_scale)), max(1, int(ph * thumb_scale))))
    thumbnail.save(f"{final}_thumb.png")
    print(f"Miniatura en {final}_thumb.png")

    # Se escribe una entrada por detección. Dos sistemas de coordenadas:
    #   - `bbox`: píxeles del PNG (ya multiplicados por `scale`), porque es el
    #     espacio en que la vista dibuja los recuadros.
    #   - `polygon`: píxeles del ortomosaico completo, que es el espacio de la
    #     transformación geográfica con la que volumeCalc mide la máscara.
    # `png_scale` (arriba del JSON) es el factor que relaciona los dos espacios.
    detections_list = []
    mascaras_fuera_de_caja = 0
    for i, pred in enumerate(result.object_prediction_list):
        box = pred.bbox
        yolo_cls = CLASSES[pred.category.id]
        info = WASTE_MAP.get(yolo_cls, UNKNOWN)
        conf = round(float(pred.score.value), 3)

        polygon = None
        if pred.mask is not None:
            polygon = [
                [round(coord * scale) for coord in poly]
                for poly in pred.mask.segmentation
            ]
            print(pred)

        detections_list.append({
            "id": i,
            "class": info.name_es,
            "yolo_class": yolo_cls,                  
            "color": info.color,
            "density_kg_m3": info.density,
            "confidence": conf,
            "bbox": {
                "minx": round(box.minx * scale),
                "miny": round(box.miny * scale),
                "maxx": round(box.maxx * scale),
                "maxy": round(box.maxy * scale),
            },
            "polygon": [poly for poly in pred.mask.segmentation] if polygon is not None else None,
        })

    if mascaras_fuera_de_caja:
        print(
            f"AVISO: {mascaras_fuera_de_caja} máscaras tienen vértices fuera de su caja; "
            "puede que no estén en las coordenadas de la imagen completa"
        )

    json_path = f"{final}.json"
    with open(json_path, "w") as jf:
        json.dump({"png_scale": scale, "detections": detections_list}, jf, indent=2)
    print(f"JSON detecciones en {json_path}")

    return final, len(result.object_prediction_list), json_path
