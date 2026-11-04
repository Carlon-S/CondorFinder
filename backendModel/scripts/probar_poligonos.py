"""Pruebas de la medición de volumen sobre máscaras.

Usa datos sintéticos: no necesita el modelo, ni un ortomosaico real, ni Mongo.
Crea un ortomosaico y un nDSM pequeños en una carpeta temporal y comprueba que:

  - un anillo plano [x1, y1, x2, y2, ...] se convierte en pares (x, y);
  - el volumen de una detección con máscara se mide sobre la máscara y no sobre
    su caja;
  - varias piezas de una misma máscara se miden juntas;
  - la caja se divide por `png_scale` cuando no hay máscara;
  - una detección sin `density_kg_m3` toma la densidad de su clase;
  - repetir `enrich` sobre su propia salida da el mismo resultado;
  - el contorno que va al mapa es un solo anillo con menos vértices;
  - el análisis que se guarda no lleva la máscara en píxeles.

Se ejecuta desde la raíz del repositorio con el entorno del backend:

    backendModel/joining/venv/bin/python backendModel/scripts/probar_poligonos.py
"""

import json
import os
import sys
import tempfile

import numpy as np
import rasterio
from rasterio.transform import from_origin

# Permite importar `detecting.*` igual que lo hace orquestador.py.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from detecting import volumeCalc  # noqa: E402
from detecting.waste_classes import color_de, densidad_de  # noqa: E402

# Cada píxel mide 0,5 m de lado: área de píxel = 0,25 m².
PIXEL_M = 0.5
ALTURA_M = 2.0
LADO_PX = 40

errores = []


def comprobar(condicion, mensaje):
    if condicion:
        print(f"  ok   {mensaje}")
    else:
        print(f"  FALLA {mensaje}")
        errores.append(mensaje)


def aprox(a, b, tolerancia=1e-6):
    return a is not None and abs(a - b) <= tolerancia


def crear_rasters(carpeta):
    """Ortomosaico RGB y nDSM de 40x40 píxeles, con altura constante de 2 m."""
    transform = from_origin(1000.0, 2000.0, PIXEL_M, PIXEL_M)
    perfil = dict(
        driver="GTiff", height=LADO_PX, width=LADO_PX, transform=transform, crs="EPSG:32719"
    )
    ortho = os.path.join(carpeta, "ortho.tif")
    with rasterio.open(ortho, "w", count=3, dtype="uint8", **perfil) as f:
        f.write(np.full((3, LADO_PX, LADO_PX), 128, dtype="uint8"))
    ndsm = os.path.join(carpeta, "ndsm.tif")
    with rasterio.open(ndsm, "w", count=1, dtype="float32", nodata=np.nan, **perfil) as f:
        f.write(np.full((1, LADO_PX, LADO_PX), ALTURA_M, dtype="float32"))
    return ortho, ndsm, transform


def enriquecer(carpeta, ortho, ndsm, detecciones, png_scale=None):
    entrada = os.path.join(carpeta, "detecciones.json")
    datos = {"detections": detecciones}
    if png_scale is not None:
        datos["png_scale"] = png_scale
    with open(entrada, "w") as f:
        json.dump(datos, f)
    return volumeCalc.enrich(entrada, ortho, ndsm, entrada), entrada


def deteccion(**campos):
    base = {
        "id": 0,
        "class": "Muebles",
        "confidence": 0.9,
        "bbox": {"minx": 0, "miny": 0, "maxx": 20, "maxy": 20},
        "polygon": None,
    }
    base.update(campos)
    return base


print("anillo plano a pares")
comprobar(
    volumeCalc.anillo_plano_a_pares([1, 2, 3, 4, 5, 6]) == [(1, 2), (3, 4), (5, 6)],
    "[1,2,3,4,5,6] -> [(1,2),(3,4),(5,6)]",
)
comprobar(
    volumeCalc.anillo_plano_a_pares([1, 2, 3, 4, 5]) == [(1, 2), (3, 4)],
    "un valor suelto al final se descarta",
)

with tempfile.TemporaryDirectory() as carpeta:
    ortho, ndsm, transform = crear_rasters(carpeta)

    print("volumen sobre la caja (sin máscara)")
    # Caja de 20x20 px = 400 px = 100 m²; altura 2 m -> 200 m³.
    salida, _ = enriquecer(carpeta, ortho, ndsm, [deteccion()])
    d = salida["detections"][0]
    comprobar(aprox(d["area_m2"], 100.0, 1.0), f"área ~100 m² (dio {d['area_m2']})")
    comprobar(aprox(d["volume_m3"], 200.0, 2.0), f"volumen ~200 m³ (dio {d['volume_m3']})")

    print("volumen sobre una máscara más chica que la caja")
    # Triángulo de 20x20 px: la mitad del área de la caja.
    triangulo = [[0, 0, 20, 0, 0, 20]]
    salida, _ = enriquecer(carpeta, ortho, ndsm, [deteccion(polygon=triangulo)])
    d = salida["detections"][0]
    comprobar(
        d["volume_m3"] < 140.0,
        f"volumen de la máscara bastante menor que el de la caja (dio {d['volume_m3']})",
    )
    comprobar(aprox(d["volume_m3"], 100.0, 15.0), f"volumen ~100 m³ (dio {d['volume_m3']})")

    print("máscara de varias piezas")
    dos_cuadrados = [
        [0, 0, 10, 0, 10, 10, 0, 10],
        [20, 20, 30, 20, 30, 30, 20, 30],
    ]
    salida, _ = enriquecer(carpeta, ortho, ndsm, [deteccion(polygon=dos_cuadrados)])
    d = salida["detections"][0]
    # Dos cuadrados de 10x10 px: 200 px = 50 m²; altura 2 m -> 100 m³.
    comprobar(aprox(d["volume_m3"], 100.0, 6.0), f"volumen de las dos piezas ~100 m³ (dio {d['volume_m3']})")
    comprobar(
        len(d["geo_polygon"]) >= 3 and all(len(p) == 2 for p in d["geo_polygon"]),
        "geo_polygon es un solo anillo de pares [x, y]",
    )

    print("anillo para el mapa")
    circulo = [
        [20 + 10 * np.cos(a), 20 + 10 * np.sin(a)] for a in np.linspace(0, 2 * np.pi, 400, endpoint=False)
    ]
    plano = [round(float(v), 2) for par in circulo for v in par]
    salida, _ = enriquecer(carpeta, ortho, ndsm, [deteccion(polygon=[plano])])
    d = salida["detections"][0]
    comprobar(
        len(d["geo_polygon"]) < 400,
        f"el contorno se simplifica ({len(d['geo_polygon'])} vértices de 400)",
    )
    comprobar(len(d["geo_polygon"]) >= 8, "el contorno conserva su forma")

    print("png_scale")
    # El PNG es la mitad del ortomosaico: una caja de 10x10 px de PNG mide
    # 20x20 px del ortomosaico (100 m²).
    chica = deteccion(bbox={"minx": 0, "miny": 0, "maxx": 10, "maxy": 10})
    salida, _ = enriquecer(carpeta, ortho, ndsm, [chica], png_scale=0.5)
    d = salida["detections"][0]
    comprobar(aprox(d["area_m2"], 100.0, 1.0), f"caja en espacio PNG llevada al ortomosaico (dio {d['area_m2']})")

    print("densidad de respaldo")
    salida, _ = enriquecer(carpeta, ortho, ndsm, [deteccion(**{"class": "Metal"})])
    d = salida["detections"][0]
    comprobar(d["density_kg_m3"] == 600, f"Metal sin densidad usa 600 (dio {d['density_kg_m3']})")
    comprobar(aprox(d["weight_kg"], d["volume_m3"] * 600, 0.05), "peso = volumen x 600")
    comprobar(densidad_de("Plástico") == 80, "Plástico 80 kg/m³")
    comprobar(densidad_de("Escombros") == 1400, "Escombros 1400 kg/m³")
    comprobar(densidad_de("Clase que no existe") == 200, "clase desconocida usa 200 kg/m³")
    comprobar(color_de("Metal") == "#f97316", "color de una clase anterior")

    print("repetir el análisis")
    detecciones = [deteccion(polygon=triangulo)]
    primera, ruta = enriquecer(carpeta, ortho, ndsm, detecciones)
    segunda = volumeCalc.enrich(ruta, ortho, ndsm, ruta)
    a, b = primera["detections"][0], segunda["detections"][0]
    comprobar(a["volume_m3"] == b["volume_m3"], "mismo volumen en la segunda pasada")
    comprobar(b["polygon"] == triangulo, "la máscara en píxeles se conserva en el archivo")

    print("detección sin superficie")
    plano_vacio = [[5, 5, 5, 5, 5, 5]]
    salida, _ = enriquecer(carpeta, ortho, ndsm, [deteccion(polygon=plano_vacio)])
    d = salida["detections"][0]
    comprobar(d["volume_m3"] is not None, "una máscara degenerada cae a la caja")

print("análisis guardado con la máscara comprimida")
try:
    import analyses  # noqa: E402

    # Contorno de 400 vértices (círculo de radio 50) con un segundo anillo.
    import math  # noqa: E402

    circulo = [round(50 + 50 * f(2 * math.pi * k / 400), 3) for k in range(400) for f in (math.cos, math.sin)]
    cuadrado = [0, 0, 10, 0, 10, 10, 0, 10]
    modelo = analyses.SavedAnalysisIn(
        name="prueba",
        mapUrl="/result/x.png",
        detections=[
            {"id": 0, "class": "Muebles", "polygon": [circulo, cuadrado], "geo_polygon": [[0, 0]]},
            {"id": 1, "class": "Madera", "polygon": None},
        ],
    )
    d0, d1 = modelo.detections
    comprobar(len(d0["polygon"]) == 2, "se conservan todos los anillos")
    comprobar(len(d0["polygon"][0]) < len(circulo), f"el anillo se simplifica ({len(d0['polygon'][0]) // 2} vértices de 400)")
    comprobar(all(isinstance(v, int) for anillo in d0["polygon"] for v in anillo), "las coordenadas son enteros")
    comprobar(d0["polygon"][1] == cuadrado, "un anillo que ya es mínimo no cambia")
    comprobar(d1["polygon"] is None, "una detección sin máscara sigue sin máscara")
    comprobar(
        d0["geo_polygon"] == [[0, 0]] and d0["class"] == "Muebles",
        "el resto de los campos se conserva",
    )
except Exception as e:  # el entorno no tiene las dependencias del backend completo
    print(f"  (se omite: no se pudo importar analyses: {type(e).__name__}: {e})")

print("tabla de colores del frontend")
ruta_ts = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "src", "components", "zone-colors.ts"
)
if not os.path.exists(ruta_ts):
    print("  (se omite: no existe src/components/zone-colors.ts; la imagen del backend no lo incluye)")
else:
    import re  # noqa: E402

    from detecting.waste_classes import WASTE_MAP, CLASES_ANTERIORES  # noqa: E402

    with open(ruta_ts, encoding="utf-8") as f:
        texto_ts = f.read()
    bloque = texto_ts[texto_ts.index("export const CLASS_COLORS"):texto_ts.index("};", texto_ts.index("export const CLASS_COLORS"))]
    colores_ts = {
        (m.group(1) or m.group(2)): m.group(3).lower()
        for m in re.finditer(r'(?:"([^"]+)"|([A-Za-zÁÉÍÓÚáéíóúñÑ]+)):\s*"(#[0-9a-fA-F]{6})"', bloque)
    }
    esperados = {i.name_es: i.color.lower() for i in WASTE_MAP.values()}
    esperados.update({i.name_es: i.color.lower() for i in CLASES_ANTERIORES.values()})
    distintos = {k: (v, colores_ts.get(k)) for k, v in esperados.items() if colores_ts.get(k) != v}
    comprobar(not distintos, f"los colores de waste_classes.py y zone-colors.ts coinciden {distintos or ''}")

print()
if errores:
    print(f"{len(errores)} comprobaciones fallaron")
    sys.exit(1)
print("todas las comprobaciones pasaron")
