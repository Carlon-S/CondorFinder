"""Tabla de clases de residuo del modelo de detección.

Es la única fuente de nombres, colores y densidades que usan
`detectingOrtho.py` (al escribir el JSON de detecciones) y `volumeCalc.py` (al
calcular el peso de cada detección). No importa torch ni SAHI, así que se puede
cargar desde cualquier módulo sin arrastrar el modelo.

Cada clase tiene tres datos:
  - `name_es`: el nombre que ve el usuario en pantalla e informes.
  - `color`: color hexadecimal con el que se pinta la clase.
  - `density`: densidad aparente en kg/m³. El peso de una detección es su
    volumen multiplicado por este valor.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class WasteInfo:
    """Los tres datos de una clase de residuo."""

    name_es: str
    color: str
    density: float


# Valor para una clase que no está en ninguna tabla.
UNKNOWN = WasteInfo("Tipo de basura indefinido", "#f59e0b", 200)

# Las 20 clases del modelo `bestseg.pt`, indexadas por el nombre que el modelo
# les da internamente.
WASTE_MAP: dict[str, WasteInfo] = {
    "Rubble": WasteInfo("Escombros", "#b91c1c", 1400),
    "Construction and demolition materials": WasteInfo("Residuo de construcción", "#ef4444", 400),
    "Asphalt milling": WasteInfo("Fresado asfáltico", "#374151", 1600),
    "Excavation materials": WasteInfo("Material de excavación", "#92400e", 1600),
    "Appliances": WasteInfo("Electrodomésticos", "#06b6d4", 150),
    "Electronic equipment": WasteInfo("Equipos electrónicos", "#6366f1", 150),
    "Furniture": WasteInfo("Muebles", "#a855f7", 200),
    "Metal barrels": WasteInfo("Barriles metálicos", "#94a3b8", 100),
    "Plastic packaging": WasteInfo("Envases plásticos", "#0ea5e9", 80),
    "Wood": WasteInfo("Madera", "#ca8a04", 300),
    "Pallets": WasteInfo("Pallets", "#eab308", 150),
    "Scrap": WasteInfo("Chatarra", "#78716c", 600),
    "Plastic": WasteInfo("Plástico", "#3b82f6", 80),
    "Vehicles": WasteInfo("Vehículos", "#14b8a6", 150),
    "Tyres": WasteInfo("Neumáticos", "#64748b", 400),
    "Paper": WasteInfo("Papel", "#84cc16", 100),
    "Foundry": WasteInfo("Fundición", "#d946ef", 1200),
    "Asbestos": WasteInfo("Asbesto", "#ec4899", 400),
    "Textile": WasteInfo("Textil", "#fb7185", 100),
    "Mixed items": WasteInfo("Residuos mezclados", "#8b5cf6", 200),
}

# Clases que producía el modelo anterior y que no tienen equivalente directo en
# la tabla de arriba. Los JSON de detecciones y los análisis guardados antes del
# cambio de modelo traen estos nombres en español.
CLASES_ANTERIORES: dict[str, WasteInfo] = {
    "Metal": WasteInfo("Metal", "#f97316", 600),
    "Residuo orgánico": WasteInfo("Residuo orgánico", "#22c55e", 300),
    "Tipo de basura indefinido": UNKNOWN,
}

# Índice por nombre en español: cubre las 20 clases actuales y las tres
# anteriores sin equivalente. Las clases anteriores que sí tienen equivalente
# (Plástico, Muebles, Neumáticos, Residuo de construcción) ya están en
# `WASTE_MAP` con el mismo nombre en español.
_POR_NOMBRE_ES: dict[str, WasteInfo] = {
    **{info.name_es: info for info in WASTE_MAP.values()},
    **CLASES_ANTERIORES,
}


# Nombres internos del modelo de cajas `best.pt` (7 clases, sin máscara) y la
# clase en español a la que corresponde cada uno. Las siete existen en las tablas
# de arriba, así que el color y la densidad salen de ellas.
CLASES_DE_BEST: dict[str, str] = {
    "construction_waste": "Residuo de construcción",
    "furniture": "Muebles",
    "metal": "Metal",
    "plastic": "Plástico",
    "organic_waste": "Residuo orgánico",
    "tyres": "Neumáticos",
    "other": "Tipo de basura indefinido",
}


def info_por_clase_yolo(clase_yolo: str) -> WasteInfo:
    """Datos de una clase a partir del nombre interno del modelo.

    Reconoce los nombres de `bestseg.pt` (20 clases) y los de `best.pt` (7
    clases). Devuelve `UNKNOWN` si el modelo entrega una clase que ninguna
    tabla conoce."""
    if clase_yolo in WASTE_MAP:
        return WASTE_MAP[clase_yolo]
    nombre_es = CLASES_DE_BEST.get(clase_yolo)
    if nombre_es is not None:
        return _POR_NOMBRE_ES[nombre_es]
    return UNKNOWN


def densidad_de(nombre_es: str) -> float:
    """Densidad en kg/m³ de una clase a partir de su nombre en español.

    Se usa con los JSON de detecciones que no traen `density_kg_m3` (los
    generados antes del cambio de modelo). Una clase desconocida usa la
    densidad de `UNKNOWN`."""
    return _POR_NOMBRE_ES.get(nombre_es, UNKNOWN).density


def color_de(nombre_es: str) -> str:
    """Color hexadecimal de una clase a partir de su nombre en español."""
    return _POR_NOMBRE_ES.get(nombre_es, UNKNOWN).color
