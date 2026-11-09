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


def aplicar_ediciones_del_modelo(ruta_json: str, conservar_ids: list[int] | None, ediciones: list[dict]) -> dict:
    """Deja las detecciones del MODELO como las muestra la vista.

    La vista es la fuente de verdad (igual que con las zonas dibujadas): cada
    análisis recibe qué detecciones siguen y cuáles cambiaron, y el archivo
    queda así, sin importar qué dejó un análisis anterior.

    Nada se destruye. Una detección quitada se marca `quitada` en vez de
    borrarse, y una editada guarda sus valores de origen en `_original`. Al
    empezar, todo se devuelve a ese origen y recién entonces se aplican los
    cambios recibidos; así reabrir un análisis antiguo, que sí tenía lo que otro
    análisis posterior quitó o modificó, vuelve a medirlo completo.

    `conservar_ids`: ids de las detecciones del modelo que la vista muestra
    (None = no tocar nada). `ediciones`: `{"id", "class"?, "polygon"?}`, con el
    polígono en píxeles del PNG. Devuelve `{"quitadas": n, "editadas": n}`."""
    with open(ruta_json, "r", encoding="utf-8") as f:
        datos = json.load(f)
    escala = float(datos.get("png_scale") or 1.0)
    por_id = {e["id"]: e for e in ediciones}

    quitadas = editadas = 0
    for d in datos.get("detections", []):
        if d.get("manual"):
            continue
        original = d.pop("_original", None)
        if original:
            d.update(original)
        d.pop("quitada", None)

        if conservar_ids is not None and d.get("id") not in conservar_ids:
            d["quitada"] = True
            quitadas += 1
            continue

        e = por_id.get(d.get("id"))
        if not e:
            continue
        nombre = e.get("class")
        puntos = e.get("polygon") or []
        cambia_clase = bool(nombre) and clase_valida(nombre) and nombre != d.get("class")
        cambia_forma = len(puntos) >= 3
        if not cambia_clase and not cambia_forma:
            continue
        d["_original"] = {
            k: d[k]
            for k in ("class", "yolo_class", "color", "density_kg_m3", "bbox", "polygon")
            if k in d
        }
        if cambia_clase:
            d["class"] = nombre
            d["yolo_class"] = _clase_yolo_de(nombre)
            d["color"] = color_de(nombre)
            d["density_kg_m3"] = densidad_de(nombre)
        if cambia_forma:
            xs = [p[0] for p in puntos]
            ys = [p[1] for p in puntos]
            anillo = []
            for x, y in puntos:
                anillo += [round(x / escala, 1), round(y / escala, 1)]
            d["polygon"] = [anillo]
            d["bbox"] = {
                "minx": round(min(xs)),
                "miny": round(min(ys)),
                "maxx": round(max(xs)),
                "maxy": round(max(ys)),
            }
        editadas += 1

    with open(ruta_json, "w", encoding="utf-8") as f:
        json.dump(datos, f, indent=2)
    return {"quitadas": quitadas, "editadas": editadas}


def reemplazar_zonas_manuales(ruta_json: str, zonas: list[dict]) -> int:
    """Deja en el JSON exactamente las zonas dibujadas que se envían.

    Quita TODAS las zonas dibujadas que el archivo traiga de análisis anteriores
    y agrega las recibidas. Lo que se analiza es lo que el trabajador ve en la
    pantalla: las zonas que ya estaban en el análisis abierto (las antiguas) más
    las que acaba de dibujar (las nuevas), y la vista las manda todas juntas. Si
    el JSON conservara por su cuenta las de ensayos anteriores, volverían a
    aparecer en cada análisis sin que nadie las hubiera dibujado esta vez.

    Las detecciones del modelo no se tocan. Devuelve cuántas zonas quedaron."""
    with open(ruta_json, "r", encoding="utf-8") as f:
        datos = json.load(f)
    datos["detections"] = [d for d in datos.get("detections", []) if not d.get("manual")]
    with open(ruta_json, "w", encoding="utf-8") as f:
        json.dump(datos, f, indent=2)
    return agregar_zonas_manuales(ruta_json, zonas)


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
