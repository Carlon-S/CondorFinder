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

from detecting.waste_classes import info_por_clase_yolo

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Modelo de detección. Hay dos en `model/`:
#   - `bestseg.pt`: modelo de segmentación, 20 clases. Entrega caja y máscara.
#     Son los pesos nuevos (versión liviana, 04-11-2026), que reemplazaron a los
#     anteriores con el mismo nombre.
#   - `best.pt`: modelo de cajas, 7 clases. No entrega máscara, así que el
#     volumen se mide sobre el rectángulo de la caja.
# El que se usa lo decide la variable de entorno DETECTION_MODEL ("bestseg" o
# "best"); sin definirla se usa `bestseg.pt`. Cualquier otro valor cae en el
# mismo.
MODELOS = {"bestseg": "model/bestseg.pt", "best": "model/best.pt"}
MODELO = os.environ.get("DETECTION_MODEL", "bestseg")
MODEL_PATH = os.path.join(BASE_DIR, MODELOS.get(MODELO, MODELOS["bestseg"]))
OUTPUT_PATH = os.path.join(BASE_DIR, "output")

# Confianza mínima para aceptar una detección.
CONF = 0.18

# Dispositivo de inferencia: GPU si torch la ve, CPU en caso contrario.
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# Holgura en píxeles al comprobar que una máscara cae dentro de su caja.
MARGEN_MASCARA_PX = 3


def _anillos_de(pred, decimales: int = 1):
    """Anillos de la máscara de una detección, en píxeles del ortomosaico.

    SAHI entrega `pred.mask.segmentation` como una lista de anillos, cada uno
    plano: [x1, y1, x2, y2, ...]. Una detección puede tener varios anillos
    cuando su máscara está partida en varias piezas. Devuelve `None` si la
    detección no trae máscara o la máscara no tiene ningún anillo."""
    if pred.mask is None:
        return None
    anillos = [
        [round(float(coord), decimales) for coord in anillo]
        for anillo in pred.mask.segmentation
        if len(anillo) >= 6  # menos de 3 vértices no encierra una superficie
    ]
    return anillos or None


def _mascara_dentro_de_caja(anillos, box) -> bool:
    """Si todos los vértices de la máscara caen dentro de su caja (con margen).

    Las dos geometrías salen de la misma predicción, así que deben coincidir. Si
    no lo hacen, la máscara no está en las coordenadas de la imagen completa."""
    for anillo in anillos:
        xs = anillo[0::2]
        ys = anillo[1::2]
        if (
            min(xs) < box.minx - MARGEN_MASCARA_PX
            or max(xs) > box.maxx + MARGEN_MASCARA_PX
            or min(ys) < box.miny - MARGEN_MASCARA_PX
            or max(ys) > box.maxy + MARGEN_MASCARA_PX
        ):
            return False
    return True


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
        # Nombre interno que el modelo da a la clase (p. ej. "Rubble").
        yolo_cls = pred.category.name
        # Nombre en español, color y densidad de esa clase.
        info = info_por_clase_yolo(yolo_cls)
        conf = round(float(pred.score.value), 3)

        anillos = _anillos_de(pred)
        if anillos is not None and not _mascara_dentro_de_caja(anillos, box):
            mascaras_fuera_de_caja += 1

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
            "polygon": anillos,
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
