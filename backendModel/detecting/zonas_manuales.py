"""Zonas de basura dibujadas a mano por el trabajador (HDU12).

El modelo puede no detectar un basural. El trabajador lo dibuja sobre el mapa
y elige su tipo de basura; esta función lo agrega al archivo JSON de
detecciones de la tarea como si fuera una detección más, para que
`volumeCalc.enrich()` mida su volumen y su peso igual que el de las demás.

Las zonas llegan en píxeles del PNG del mapa, que es donde se dibujan. Las
máscaras del JSON están en píxeles del ortomosaico, y `png_scale` es el factor
que relaciona los dos espacios (PNG = ortomosaico x png_scale), así que cada
vértice se divide por ese factor.
"""

import json

from detecting.waste_classes import WASTE_MAP, _POR_NOMBRE_ES, color_de, densidad_de


def clase_valida(nombre_es: str) -> bool:
    """Si el nombre en español corresponde a una clase de la tabla."""
    return nombre_es in _POR_NOMBRE_ES


def _clase_yolo_de(nombre_es: str) -> str:
    """Nombre interno del modelo para una clase en español, o "Manual"."""
    for clase_yolo, info in WASTE_MAP.items():
        if info.name_es == nombre_es:
            return clase_yolo
    return "Manual"


def quitar_zona_manual(ruta_json: str, zona_id: int) -> bool:
    """Quita del JSON de detecciones la zona dibujada con ese id.

    Solo toca detecciones marcadas `manual`: nunca una que haya entregado el
    modelo, aunque comparta el id. Devuelve si encontró y quitó la zona.

    Es lo que hace que una zona "eliminada" deje de contar: las zonas dibujadas
    viven en el JSON del vuelo y cada análisis las vuelve a medir, así que sin
    quitarlas de ahí volverían a aparecer en el análisis siguiente."""
    with open(ruta_json, "r", encoding="utf-8") as f:
        datos = json.load(f)
    detecciones = datos.get("detections", [])
    restantes = [d for d in detecciones if not (d.get("manual") and d.get("id") == zona_id)]
    if len(restantes) == len(detecciones):
        return False
    datos["detections"] = restantes
    with open(ruta_json, "w", encoding="utf-8") as f:
        json.dump(datos, f, indent=2)
    return True


def agregar_zonas_manuales(ruta_json: str, zonas: list[dict]) -> int:
    """Agrega las zonas dibujadas al JSON de detecciones y devuelve cuántas.

    Cada zona es `{"class": <nombre en español>, "polygon": [[x, y], ...]}` con
    los vértices en píxeles del PNG. Una zona con menos de 3 vértices o con una
    clase desconocida se ignora. Las detecciones que ya tiene el archivo (las
    del modelo y las zonas manuales de análisis anteriores) no se tocan, así que
    el análisis siguiente mide las áreas nuevas junto con las antiguas."""
    with open(ruta_json, "r", encoding="utf-8") as f:
        datos = json.load(f)

    escala = float(datos.get("png_scale") or 1.0)
    detecciones = datos.setdefault("detections", [])
    siguiente_id = max((d.get("id", -1) for d in detecciones), default=-1) + 1

    agregadas = 0
    for zona in zonas:
        puntos = zona.get("polygon") or []
        nombre = zona.get("class", "")
        if len(puntos) < 3 or not clase_valida(nombre):
            continue

        xs = [p[0] for p in puntos]
        ys = [p[1] for p in puntos]
        anillo_ortho = []
        for x, y in puntos:
            anillo_ortho += [round(x / escala, 1), round(y / escala, 1)]

        detecciones.append(
            {
                "id": siguiente_id,
                "class": nombre,
                "yolo_class": _clase_yolo_de(nombre),
                "color": color_de(nombre),
                "density_kg_m3": densidad_de(nombre),
                "confidence": 1.0,
                "bbox": {
                    "minx": round(min(xs)),
                    "miny": round(min(ys)),
                    "maxx": round(max(xs)),
                    "maxy": round(max(ys)),
                },
                "polygon": [anillo_ortho],
                "manual": True,
            }
        )
        siguiente_id += 1
        agregadas += 1

    with open(ruta_json, "w", encoding="utf-8") as f:
        json.dump(datos, f, indent=2)
    return agregadas
