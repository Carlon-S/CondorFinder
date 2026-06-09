
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

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "model/best.pt")
OUTPUT_PATH = os.path.join(BASE_DIR, "output")
CONF        = 0.15

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

    ORTHO_PATH =  file_name

    FILE_NAME = os.path.splitext(os.path.basename(file_name))[0]

    with rasterio.open(ORTHO_PATH) as src:
        geo_transform = src.transform
        src_crs = src.crs
        img_array = src.read([1, 2, 3])

    model = AutoDetectionModel.from_pretrained(
        model_type="yolov8",
        model_path=MODEL_PATH,
        confidence_threshold=CONF,
        device="cpu",  # cambiar a "cuda" para usar gpu Nvidia, aunque este paso no es muy lento
    )

    img_array = np.moveaxis(img_array, 0, -1)
    image = Image.fromarray(img_array.astype(np.uint8))
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


    draw = ImageDraw.Draw(image)
    for pred in result.object_prediction_list:
        box = pred.bbox
        cls = CLASSES[pred.category.id]
        conf = round(float(pred.score.value), 3)
        color = COLORS_PIL.get(cls, (255, 255, 255))
        draw.rectangle([box.minx, box.miny, box.maxx, box.maxy], outline=color, width=4)
        draw.text((box.minx, box.miny - 15), f"{cls} {conf}", fill=color)

    w, h = image.size
    scale = min(1.0, 10000 / max(w, h))
    preview = image.resize((int(w * scale), int(h * scale)))
    final = os.path.join(OUTPUT_PATH, FILE_NAME)
    preview.save(f"{final}.jpg", quality=90)
    print(f"Archivo Final en {final}.jpg")

    """

    ///
    Este es un ejemplo vive-codeado de usar un mapa para generar una salida. No me gusto mucho, pero pueden verlo de ejemplo. Descomenta la seccion de abajo, y genera un ejemplo en un archivo html.
    ///
    WGS84    = CRS.from_epsg(4326)
    features = []

    print("Sample coordinates:")
    for i, pred in enumerate(result.object_prediction_list):
        box   = pred.bbox
        cx_px = (box.minx + box.maxx) / 2
        cy_px = (box.miny + box.maxy) / 2

        # Pixel → UTM
        utm_x, utm_y = rasterio.transform.xy(geo_transform, cy_px, cx_px)

        # UTM → WGS84
        lon, lat = rasterio_transform(src_crs, WGS84, [utm_x], [utm_y])
        lon, lat = float(lon[0]), float(lat[0])

        cls  = CLASSES[pred.category.id]
        conf = round(float(pred.score.value), 3)

        if i < 5:
            print(f"  {cls}: lat={lat:.6f}, lon={lon:.6f}")

        features.append({
            "type": "Feature",
            "geometry":   {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"class": cls, "confidence": conf},
        })

    with open("detections.geojson", "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)
    print("Saved detections.geojson")

    if features:
        center_lat = np.mean([f["geometry"]["coordinates"][1] for f in features])
        center_lon = np.mean([f["geometry"]["coordinates"][0] for f in features])

        m = folium.Map(location=[center_lat, center_lon], zoom_start=17)

        for f in features:
            lon, lat = f["geometry"]["coordinates"]
            cls      = f["properties"]["class"]
            conf     = f["properties"]["confidence"]
            folium.CircleMarker(
                location=[lat, lon],
                radius=6,
                color=COLORS_MAP.get(cls, "white"),
                fill=True,
                fill_opacity=0.8,
                popup=f"{cls} ({conf})",
            ).add_to(m)

        m.save("detections_map.html")
        print("Saved detections_map.html — open it in your browser!")
    else:
        print("No detections found, map not generated.")"""
    