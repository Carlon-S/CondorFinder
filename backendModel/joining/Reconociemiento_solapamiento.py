import os
import glob
import math
from exif import Image
from geopy.distance import geodesic


def obtener_datos_exif(ruta_imagen):
    """Extrae coordenadas y altitud de los metadatos EXIF de la imagen."""
    with open(ruta_imagen, 'rb') as img_file:
        img = Image(img_file)

    try:
        lat = img.gps_latitude
        lon = img.gps_longitude
        lat_ref = img.gps_latitude_ref
        lon_ref = img.gps_longitude_ref

        lat_dec = lat[0] + lat[1] / 60 + lat[2] / 3600
        if lat_ref == 'S':
            lat_dec = -lat_dec

        lon_dec = lon[0] + lon[1] / 60 + lon[2] / 3600
        if lon_ref == 'W':
            lon_dec = -lon_dec

        altitud = img.get('gps_altitude', 50.0)

        return (lat_dec, lon_dec), altitud
    except AttributeError:
        return None, None


def verificar_set_vuelo(ruta_carpeta, fov_horizontal=82.1, altitud_vuelo=50, umbral_min_solape=60):
    """
    Verifica si el conjunto de imágenes cumple el margen mínimo de solapamiento.

    Retorna un diccionario con:
        - aprobado      (bool): True si ningún par supera el umbral mínimo
        - alertas       (int): cantidad de pares con solapamiento insuficiente
        - total_pares   (int): pares evaluados con GPS válido
        - pares_sin_gps (int): pares saltados por falta de datos GPS
        - detalle       (list): lista de dicts con los pares problemáticos
    """
    imagenes = sorted(
        glob.glob(os.path.join(ruta_carpeta, '*.jpg')) +
        glob.glob(os.path.join(ruta_carpeta, '*.jpeg')) +
        glob.glob(os.path.join(ruta_carpeta, '*.JPG')) +
        glob.glob(os.path.join(ruta_carpeta, '*.JPEG'))
    )

    if len(imagenes) < 2:
        return {
            "aprobado": False,
            "alertas": 0,
            "total_pares": 0,
            "pares_sin_gps": 0,
            "detalle": [],
            "mensaje": "Se necesitan al menos 2 imágenes para verificar el solapamiento."
        }

    alertas = 0
    total_pares = 0
    pares_sin_gps = 0
    detalle = []

    for i in range(len(imagenes) - 1):
        coords1, alt1 = obtener_datos_exif(imagenes[i])
        coords2, alt2 = obtener_datos_exif(imagenes[i + 1])

        nom1 = os.path.basename(imagenes[i])
        nom2 = os.path.basename(imagenes[i + 1])

        if not coords1 or not coords2:
            pares_sin_gps += 1
            continue

        total_pares += 1

        distancia_avanzada = geodesic(coords1, coords2).meters
        ancho_huella_real = 2 * 50 * math.tan(math.radians(fov_horizontal / 2))
        solape_real = (1 - (distancia_avanzada / ancho_huella_real)) * 100

        if solape_real < umbral_min_solape:
            alertas += 1
            detalle.append({
                "imagen_1": nom1,
                "imagen_2": nom2,
                "solape": round(solape_real, 1),
                "distancia_m": round(distancia_avanzada, 1),
            })

    # Si todos los pares fueron saltados por falta de GPS, no se pudo verificar nada
    if total_pares == 0 and pares_sin_gps > 0:
        return {
            "aprobado": False,
            "alertas": 0,
            "total_pares": 0,
            "pares_sin_gps": pares_sin_gps,
            "detalle": [],
            "mensaje": "Ninguna imagen contiene datos GPS. No es posible verificar el solapamiento."
        }

    return {
        "aprobado": alertas == 0,
        "alertas": alertas,
        "total_pares": total_pares,
        "pares_sin_gps": pares_sin_gps,
        "detalle": detalle,
        "mensaje": (
            "Solapamiento aprobado en todos los pares evaluados."
            if alertas == 0
            else f"Solapamiento insuficiente en {alertas} par(es) de imágenes."
        )
    }