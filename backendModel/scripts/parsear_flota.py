"""Parser de la planilla de flota de la municipalidad, para HDU8.

Corre UNA VEZ en la máquina de desarrollo, no en el servidor, y produce
`scripts/datos/flota_maipu.json`, que es lo que se versiona y lo que después
lee `importar_flota.py` en la VM.

Está partido en dos a propósito. El Excel vive fuera del repositorio (lo
entrega la Dirección de Aseo, Ornato y Gestión Ambiental) y leerlo necesita
openpyxl, que no está en requirements.txt: meterlo ahí para una carga única
agregaría una dependencia al backend de producción para siempre. Con el JSON
intermedio, el servidor no necesita ni el Excel ni openpyxl, la carga es
determinista, y el diff de git muestra exactamente qué datos entran al sistema
antes de que entren.

NO INVENTA NADA. Cuando un dato no está en la planilla queda nulo y aparece en
el informe de la salida. La capacidad y la dotación vienen en texto libre
("Capacidad 10 M3", "1 Conductor + 2 Peonetas"), así que se extraen con
expresión regular y lo que no calce se reporta en vez de rellenarse con un
valor por omisión, que es lo que convertiría un dato faltante en un dato falso.

Uso, desde backendModel/:

    python scripts/parsear_flota.py "<ruta a Datos Recursos>"

Espera encontrar dentro de esa carpeta:

    DETALLE DE FLOTA.xlsx
    Fotos Camiones/<N° de equipo>.jpeg
"""

import json
import os
import re
import sys
from collections import Counter

# Familias de campos. Un tipo de recurso no pide los mismos datos que otro, y
# esto es lo que sostiene el AC2 de HDU8 ("al elegir el tipo, el sistema pide
# los detalles relevantes de ese tipo"). Los nueve tipos son los de la
# planilla, sin agrupar: es el vocabulario con el que la municipalidad nombra
# su propia flota, y juntarlos en menos categorías sería inventar una
# clasificación que nadie usa.
#
#   carga    -> capacidad de la tolva o caja, en m3
#   maquina  -> capacidad del balde, en m3
#   arrastre -> no se conduce solo, no lleva capacidad ni dotación
#   apoyo    -> vehículo de supervisión, sin capacidad de carga
FAMILIA_POR_TIPO = {
    "TOLVA": "carga",
    "AMPLIROLL": "carga",
    "CAMION 3/4 PLANO": "carga",
    "RETRO": "maquina",
    "FRONTAL": "maquina",
    "MINICARGADOR": "maquina",
    "CARRO ARRASTRE": "arrastre",
    "CARRO RECICLAJE": "arrastre",
    "CAMIONETA": "apoyo",
}

# El punto real desde el que sale la flota, según la municipalidad.
#
# La coordenada NO viene de geocodificar la dirección, viene medida sobre el
# lugar. Se intentó por datos abiertos y no existe: Nominatim conoce la calle
# como "General San Martín" y devuelve tres segmentos sin ningún house_number,
# y una consulta a Overpass por el número 2730 en toda la comuna de Maipú trae
# solo dos direcciones, ninguna en esta calle. Elegir uno de los tres segmentos
# habría dejado el punto de salida en la cuadra equivocada, que en una historia
# sobre generar rutas no es un detalle cosmético. Queda fija acá y no se
# recalcula: geocodificar esta dirección otra vez la empeoraría.
PUNTO = {
    # El nombre es la DIRECCIÓN, no una etiqueta inventada. La planilla de flota
    # no trae nombre para el recinto y el programa diario tampoco, así que
    # cualquier cosa como "Punto de salida" o "Depósito municipal" sería un
    # nombre que nadie en la municipalidad usa. Si más adelante dan el nombre
    # real, se cambia desde la interfaz y la reimportación ya no lo pisa.
    "nombre": "Gral. José San Martín 2730",
    "direccion": "Gral. José San Martín 2730",
    "comuna": "Maipú",
    "lat": -33.502421124221655,
    "lng": -70.76424413105302,
}

CAPACIDAD_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*M\s*3", re.IGNORECASE)
DOTACION_RE = {
    "conductores": re.compile(r"(\d+)\s*conductor", re.IGNORECASE),
    "peonetas": re.compile(r"(\d+)\s*peoneta", re.IGNORECASE),
    "operadores": re.compile(r"(\d+)\s*operador", re.IGNORECASE),
}


def _numero(valor):
    """Un entero de la planilla puede venir como int, float o texto."""
    if valor is None:
        return None
    if isinstance(valor, (int, float)):
        return int(valor)
    texto = str(valor).strip()
    return int(texto) if texto.isdigit() else None


def _texto(valor):
    if valor is None:
        return None
    limpio = str(valor).strip()
    return limpio or None


def _capacidades(observaciones):
    """Saca la capacidad del texto libre de OBSERVACIONES.

    La planilla escribe dos cosas distintas con la misma unidad:

        "Capacidad 10 M3"        -> capacidad de carga del vehículo
        "Con balde de cap. 3M3"  -> capacidad del balde de una máquina

    La palabra "balde" es lo único que las distingue, así que es lo que se
    usa. Si no hay número, las dos quedan nulas: hay filas sin capacidad
    declarada (las dos AMPLIROLL, los carros) y una RETRO que no declara balde
    aunque sus dos hermanas sí.
    """
    if not observaciones:
        return None, None
    match = CAPACIDAD_RE.search(observaciones)
    if not match:
        return None, None
    valor = float(match.group(1).replace(",", "."))
    if "balde" in observaciones.lower():
        return None, valor
    return valor, None


def _dotacion(texto):
    """Dotación requerida por el vehículo, desde texto libre.

    Va en HDU8 y no en HDU5.1 porque es un atributo del vehículo, no de la
    planificación: el camión REQUIERE un conductor y dos peonetas siempre, sea
    que hoy salga a ruta o no. HDU5.1 después cruza este requerimiento contra
    los perfiles de trabajador disponibles, pero no es quien lo define.
    """
    if not texto:
        return {"conductores": 0, "peonetas": 0, "operadores": 0}
    return {
        clave: (int(m.group(1)) if (m := regex.search(texto)) else 0)
        for clave, regex in DOTACION_RE.items()
    }


def _copiar_fotos(base_fotos, nombres):
    """Copia al repositorio las fotos que se van a usar, reducidas.

    Van versionadas en `backendModel/static/recursos/` y no a GCS. GCS existe en
    este proyecto para lo que tiene que sobrevivir a una corrida del pipeline
    (el PNG de un análisis guardado); una foto de un camión municipal es dato de
    referencia que cambia una vez al año, y subirla exigiría un endpoint de
    carga de archivos que ningún criterio de HDU8 pide. Versionadas viajan
    solas en la imagen de Docker y se sirven desde disco.

    Se reducen porque los originales llegan hasta 370 kB cada uno y en pantalla
    se ven en una ficha chica: a 900px de lado largo y calidad 82 se ven igual y
    el repositorio no carga con 3.3 MB de binarios.

    El directorio se llama `static/recursos` y no `resources/`: un directorio
    con ese nombre al lado de `resources.py` compite con el módulo en la
    resolución de imports de Python.
    """
    try:
        from PIL import Image
    except ImportError:
        print("Falta Pillow para reducir las fotos: pip install Pillow")
        return 0, 0

    destino = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "static", "recursos",
    )
    os.makedirs(destino, exist_ok=True)

    copiadas = 0
    bytes_antes = 0
    bytes_despues = 0
    for nombre in sorted(nombres):
        origen = os.path.join(base_fotos, nombre)
        if not os.path.isfile(origen):
            continue
        bytes_antes += os.path.getsize(origen)
        with Image.open(origen) as img:
            img = img.convert("RGB")
            img.thumbnail((900, 900), Image.LANCZOS)
            img.save(os.path.join(destino, nombre), "JPEG", quality=82, optimize=True)
        bytes_despues += os.path.getsize(os.path.join(destino, nombre))
        copiadas += 1

    return copiadas, (bytes_antes, bytes_despues, destino)


def _foto_de(equipo, fotos):
    """Nombre del archivo de foto de este equipo, o None.

    Las fotos vienen nombradas con el N° de equipo, así que el cruce es
    directo. Hay una repetida ("1179 (2).jpeg"): se prefiere siempre la de
    nombre exacto y la copia se ignora.
    """
    exacta = f"{equipo}.jpeg"
    if exacta in fotos:
        return exacta
    for nombre in sorted(fotos):
        if nombre.startswith(str(equipo)):
            return nombre
    return None


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    base = sys.argv[1]
    xlsx = os.path.join(base, "DETALLE DE FLOTA.xlsx")
    dir_fotos = os.path.join(base, "Fotos Camiones")

    if not os.path.isfile(xlsx):
        print(f"No se encontró la planilla en {xlsx}")
        sys.exit(1)

    try:
        import openpyxl
    except ImportError:
        print("Falta openpyxl. Es solo para este script, no para el backend:")
        print("    pip install openpyxl")
        sys.exit(1)

    fotos = set(os.listdir(dir_fotos)) if os.path.isdir(dir_fotos) else set()

    wb = openpyxl.load_workbook(xlsx, data_only=True)
    ws = wb.worksheets[0]

    recursos = []
    avisos = []
    for fila, valores in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        equipo = _numero(valores[0])
        if equipo is None:
            continue  # filas de relleno al final de la planilla

        tipo = _texto(valores[2])
        if not tipo:
            avisos.append(f"fila {fila}: equipo {equipo} sin TIPO DE VEHÍCULO, se omite")
            continue
        tipo = tipo.upper()

        familia = FAMILIA_POR_TIPO.get(tipo)
        if familia is None:
            avisos.append(
                f"fila {fila}: equipo {equipo} con tipo '{tipo}' desconocido, "
                "hay que agregarlo a FAMILIA_POR_TIPO antes de cargar"
            )
            continue

        observaciones = _texto(valores[6])
        capacidad_m3, capacidad_balde_m3 = _capacidades(observaciones)
        dotacion = _dotacion(_texto(valores[7]))
        foto = _foto_de(equipo, fotos)

        if familia == "carga" and capacidad_m3 is None:
            avisos.append(
                f"equipo {equipo} ({tipo}) es de carga y no declara capacidad en "
                f"OBSERVACIONES ({observaciones!r}), queda nula"
            )
        if familia == "maquina" and capacidad_balde_m3 is None:
            avisos.append(
                f"equipo {equipo} ({tipo}) es máquina y no declara balde en "
                f"OBSERVACIONES ({observaciones!r}), queda nulo"
            )
        if foto is None:
            avisos.append(f"equipo {equipo} ({tipo}) sin foto")

        recursos.append({
            "numeroEquipo": str(equipo),
            "patente": _texto(valores[1]),
            "tipo": tipo,
            "familia": familia,
            "marca": _texto(valores[3]),
            "modelo": _texto(valores[4]),
            "anio": _numero(valores[5]),
            "capacidadM3": capacidad_m3,
            "capacidadBaldeM3": capacidad_balde_m3,
            "conductoresRequeridos": dotacion["conductores"],
            "peonetasRequeridas": dotacion["peonetas"],
            "operadoresRequeridos": dotacion["operadores"],
            "observaciones": observaciones,
            "foto": foto,
            # Todo lo que la municipalidad entregó está operativo. El AC4 de
            # HDU8 es lo que permite cambiarlo desde la interfaz.
            "disponible": True,
        })

    salida = {
        "fuente": os.path.basename(xlsx),
        "punto": PUNTO,
        "recursos": recursos,
    }

    destino_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "datos")
    os.makedirs(destino_dir, exist_ok=True)
    destino = os.path.join(destino_dir, "flota_maipu.json")
    with open(destino, "w", encoding="utf-8") as fh:
        json.dump(salida, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    # ── informe ───────────────────────────────────────────────────────────
    print(f"Planilla: {xlsx}")
    print(f"Fotos:    {len(fotos)} archivos en {dir_fotos}")
    print(f"Escrito:  {destino}")
    print()
    print(f"{len(recursos)} recursos, por tipo:")
    for tipo, n in sorted(Counter(r["tipo"] for r in recursos).items()):
        familia = FAMILIA_POR_TIPO[tipo]
        con_foto = sum(1 for r in recursos if r["tipo"] == tipo and r["foto"])
        print(f"  {tipo:<20} {n:>2}  familia={familia:<9} con foto: {con_foto}/{n}")
    print()
    print(f"{sum(1 for r in recursos if r['foto'])}/{len(recursos)} recursos con foto")

    # Solo las fotos que algún recurso referencia. Las copias sueltas del
    # directorio de origen (hay un "1179 (2).jpeg" que duplica al 1179) no
    # entran al repositorio.
    usadas = {r["foto"] for r in recursos if r["foto"]}
    copiadas, medidas = _copiar_fotos(dir_fotos, usadas)
    if copiadas:
        antes, despues, destino = medidas
        print(f"{copiadas} fotos copiadas a {destino}")
        print(f"  {antes / 1024:.0f} kB -> {despues / 1024:.0f} kB")

    if avisos:
        print()
        print(f"{len(avisos)} datos faltantes o dudosos, quedan nulos:")
        for aviso in avisos:
            print(f"  - {aviso}")

    if PUNTO["lat"] is None or PUNTO["lng"] is None:
        print()
        print("FALTA: el punto no tiene coordenadas. OpenStreetMap no tiene")
        print("numeración en Gral. San Martín, así que hay que completarlas a")
        print("mano en PUNTO antes de importar, o dejar que se ajusten desde el")
        print("mapa de /recursos después de cargar.")


if __name__ == "__main__":
    main()
