"""Carga los 54 puntos permanentes de la municipalidad desde su archivo KMZ.

El archivo (`Microbasurales_VIRS_sept2026.kmz`) es el catastro de la Dirección
de Aseo: 51 microbasurales y 3 VIRS, cada uno con su ubicación escrita y su
geometría. Es la misma lista de 54 que el README menciona y de la que hasta
ahora el sistema solo tenía el número.

## Cómo correrlo

**En la VM, que es donde vive `MONGODB_URI`.** El `WORKDIR` del contenedor es
`/app` y el backend está en `/app/backendModel/`, así que la ruta lleva ese
prefijo (sin él, `python` responde `No such file or directory`):

    cd ~/CondorFinder
    docker compose exec backend python backendModel/scripts/importar_puntos_permanentes.py
    docker compose exec backend python backendModel/scripts/importar_puntos_permanentes.py --aplicar

El `.env` del servicio ya está cargado en el contenedor, así que no hace falta
pasar nada más, y el KMZ viaja en la imagen (está dentro de `backendModel/`).

**En local, desde `backendModel/` y con el entorno del backend activo**, útil
solo para revisar la data: sin `MONGODB_URI` imprime los 54 y no escribe.

    python scripts/importar_puntos_permanentes.py
    python scripts/importar_puntos_permanentes.py <otro.kmz>

**Dry-run por omisión en los dos casos**, igual que `importar_flota.py` y
`migrar_zonas.py`: la salida se revisa antes de escribir 54 documentos en la
base de producción, y `--aplicar` es lo único que escribe.

**Es idempotente.** Un punto que ya existe con el mismo nombre se actualiza en
vez de duplicarse, y solo en los campos que el KMZ trae: la dirección, la
comuna, las coordenadas y el tipo. **No toca `frecuencia`, `barrio` ni
`active`**, que el KMZ no tiene y que alguien pudo haber completado a mano
desde la interfaz. Ese es el mismo criterio por el que `importar_flota.py` no
pisa `disponible`: un dato que el sistema aprendió después de la carga no lo
revierte una reimportación.

---

## Lo que el KMZ tiene y el sistema NO modela

**Cada punto es un TRAMO de calle, no una coordenada.** Son `LineString` de 2 a
21 vértices: "Camino La Farfana con Alberto Pérez" es el pedazo de calle donde
se acumula la basura, no un punto. El modelo de zona guarda un solo `lat`/`lng`,
así que acá se calcula **el punto medio A LO LARGO de la polilínea**.

Medio a lo largo y no el promedio de los vértices, que es la parte que importa:
en un tramo en forma de L el promedio de los vértices cae FUERA de la calle, y
el punto que se guarda es al que se manda el camión. El punto medio por longitud
está sobre la línea por construcción.

Queda anotada la limitación: en un tramo largo ese punto puede estar a cientos
de metros de cualquiera de los dos extremos. Para ubicar el lugar en el mapa y
para rutear alcanza, pero no reemplaza la dirección, que es como la cuadrilla lo
reconoce en la calle. Si algún día hace falta la extensión completa, está en el
KMZ y volver a extraerla es correr esto de nuevo.
"""

import argparse
import os
import pathlib
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pymongo import MongoClient  # noqa: E402

MONGODB_URI = os.getenv("MONGODB_URI")
DB_NAME = os.getenv("MONGODB_DB_NAME", "condorfinder")

KML_NS = "http://www.opengis.net/kml/2.2"

# El catastro viaja EN EL REPOSITORIO, junto a `flota_maipu.json` y por el mismo
# motivo: es el dato que entregó la municipalidad, pesa 10 KB, y sin él el
# script no se puede correr en la VM sin copiarlo a mano cada vez.
KMZ_POR_OMISION = (
    pathlib.Path(__file__).parent / "datos" / "Microbasurales_VIRS_sept2026.kmz"
)

# El `tipo` del KMZ viene en mayúsculas y el sistema lo guarda capitalizado
# (`TIPOS_PUNTO` en analyses.py). Se mapea explícitamente en vez de hacer
# `.capitalize()`: con un valor nuevo del catastro, un mapeo cerrado falla
# ruidosamente y una transformación automática guardaría algo que después el
# endpoint rechaza.
TIPO_POR_CATEGORIA = {
    "MICROBASURAL": "Microbasural",
    "VIRS": "VIRS",
}

# Caja de Maipú (misma que MAIPU_BBOX en src/lib/maipuBoundary.ts). Un punto
# fuera de acá no es un punto de la comuna: sería un error de extracción, y es
# mejor que el script lo diga que cargarlo y que aparezca en medio del mar.
LAT_MIN, LAT_MAX = -33.57185, -33.45821
LNG_MIN, LNG_MAX = -70.92998, -70.71836

COMUNA = "Maipú"


def _campos_de_descripcion(html: str) -> dict[str, str]:
    """Los atributos de la tabla HTML que el KMZ pone en `<description>`.

    La exportación de ArcGIS mete los atributos como una tabla de dos columnas
    (nombre, valor) dentro de HTML escapado. No hay una forma más limpia de
    leerlos: no vienen en `ExtendedData`, que es donde KML los esperaría.
    """
    celdas = [
        re.sub(r"<[^>]+>", "", c).strip()
        for c in re.findall(r"<td[^>]*>(.*?)</td>", html or "", re.S | re.I)
    ]
    # La primera celda es el título, y de ahí en adelante van en pares.
    return dict(zip(celdas[1::2], celdas[2::2]))


def _vertices(placemark: ET.Element) -> list[tuple[float, float]]:
    """Los vértices del tramo, como (lat, lng).

    KML los escribe `lng,lat,alt` separados por espacios, al revés de como los
    usa Leaflet. Se invierten acá, una sola vez, para que nada aguas abajo
    tenga que recordarlo.
    """
    puntos: list[tuple[float, float]] = []
    for coords in placemark.iter(f"{{{KML_NS}}}coordinates"):
        for par in (coords.text or "").split():
            partes = par.split(",")
            if len(partes) < 2:
                continue
            puntos.append((float(partes[1]), float(partes[0])))
    return puntos


def punto_medio(vertices: list[tuple[float, float]]) -> tuple[float, float]:
    """El punto medio A LO LARGO de la polilínea.

    Recorre el tramo acumulando longitud hasta pasar la mitad, y devuelve el
    punto interpolado ahí. **Por longitud y no el promedio de los vértices**:
    en un tramo en forma de L el promedio cae fuera de la calle, y este punto
    está sobre la línea por construcción.

    La longitud se mide en grados y no en metros a propósito: para partir un
    tramo de pocas cuadras en dos mitades, la distorsión de la latitud es
    irrelevante y evita arrastrar una proyección a un script de carga.
    """
    if len(vertices) == 1:
        return vertices[0]

    tramos = [
        ((vertices[i][0] - vertices[i + 1][0]) ** 2 + (vertices[i][1] - vertices[i + 1][1]) ** 2)
        ** 0.5
        for i in range(len(vertices) - 1)
    ]
    objetivo = sum(tramos) / 2
    recorrido = 0.0
    for i, largo in enumerate(tramos):
        if recorrido + largo >= objetivo:
            # Dónde cae la mitad DENTRO de este tramo, de 0 a 1.
            faltante = (objetivo - recorrido) / largo if largo > 0 else 0.0
            (lat1, lng1), (lat2, lng2) = vertices[i], vertices[i + 1]
            return (lat1 + (lat2 - lat1) * faltante, lng1 + (lng2 - lng1) * faltante)
        recorrido += largo
    return vertices[-1]


def leer_kmz(ruta: str) -> list[dict]:
    """Los puntos del KMZ, ya con su punto medio y su tipo mapeado."""
    with zipfile.ZipFile(ruta) as z:
        nombres = [n for n in z.namelist() if n.lower().endswith(".kml")]
        if not nombres:
            raise SystemExit(f"{ruta} no contiene ningún .kml")
        with z.open(nombres[0]) as f:
            raiz = ET.parse(f).getroot()

    puntos: list[dict] = []
    for pm in raiz.findall(f".//{{{KML_NS}}}Placemark"):
        nombre_el = pm.find(f"{{{KML_NS}}}name")
        desc_el = pm.find(f"{{{KML_NS}}}description")
        campos = _campos_de_descripcion(desc_el.text if desc_el is not None else "")

        # El nombre del placemark y la UBICACION son el mismo texto en este
        # archivo; se prefiere UBICACION porque es el campo del catastro y el
        # `<name>` es la etiqueta de dibujo.
        nombre = (campos.get("UBICACION") or (nombre_el.text or "")).strip()
        categoria = (campos.get("CATEGORIA") or "").strip().upper()
        if categoria not in TIPO_POR_CATEGORIA:
            raise SystemExit(
                f"Categoría desconocida en {nombre!r}: {categoria!r}. "
                f"Conocidas: {sorted(TIPO_POR_CATEGORIA)}"
            )

        vertices = _vertices(pm)
        if not vertices:
            raise SystemExit(f"{nombre!r} no tiene coordenadas")
        lat, lng = punto_medio(vertices)
        if not (LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lng <= LNG_MAX):
            raise SystemExit(
                f"{nombre!r} queda fuera de Maipú: ({lat:.6f}, {lng:.6f}). "
                "Revisa la extracción antes de cargar."
            )

        puntos.append({
            "nombre": nombre,
            "idCatastro": campos.get("ID", ""),
            "tipo": TIPO_POR_CATEGORIA[categoria],
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "vertices": len(vertices),
        })
    return puntos


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "kmz",
        nargs="?",
        default=KMZ_POR_OMISION,
        help=f"Ruta al .kmz del catastro (por omisión {KMZ_POR_OMISION.name})",
    )
    ap.add_argument("--aplicar", action="store_true", help="Escribe en la base")
    ap.add_argument(
        "--owner",
        default=os.getenv("IMPORT_OWNER", ""),
        help="Usuario dueño de los puntos creados (por omisión, el del primer punto que exista)",
    )
    args = ap.parse_args()

    puntos = leer_kmz(args.kmz)
    print(f"{len(puntos)} puntos leídos del KMZ")
    por_tipo: dict[str, int] = {}
    for p in puntos:
        por_tipo[p["tipo"]] = por_tipo.get(p["tipo"], 0) + 1
    print("  por tipo:", por_tipo)
    print(f"  tramos de 1 vértice: {sum(1 for p in puntos if p['vertices'] == 1)}")
    print(f"  tramo más largo: {max(p['vertices'] for p in puntos)} vértices")

    nombres = [p["nombre"] for p in puntos]
    repetidos = {n for n in nombres if nombres.count(n) > 1}
    if repetidos:
        # No es fatal (dos tramos distintos pueden compartir ubicación escrita),
        # pero sí hay que verlo: la coincidencia para no duplicar es por nombre.
        print(f"  AVISO, nombres repetidos en el KMZ: {sorted(repetidos)}")

    # Sin base alcanzable la simulación sigue sirviendo: imprime los 54 para
    # revisarlos. `MONGODB_URI` vive solo en la VM, así que este es el caso
    # normal en la máquina de cualquiera del equipo, y morir acá dejaba el
    # script inútil justo para lo que más se usa, que es mirar la data antes de
    # cargarla.
    if not MONGODB_URI:
        if args.aplicar:
            raise SystemExit("MONGODB_URI no está seteado (ver backendModel/.env.example)")
        print()
        print("Sin MONGODB_URI: no se puede comparar con la base. Los 54 puntos leídos:")
        print()
        for n, p in enumerate(puntos, 1):
            print(
                f"  {n:>2}. [{p['tipo']:<12}] ({p['lat']:.5f}, {p['lng']:.5f}) "
                f"{p['vertices']:>2} vért.  {p['nombre']}"
            )
        print()
        print("Corre esto en la VM, donde el .env tiene MONGODB_URI, para ver qué se crearía.")
        return

    db = MongoClient(MONGODB_URI)[DB_NAME]

    existentes = {z["name"]: z for z in db.zones.find({}, {"name": 1, "owner": 1, "kind": 1})}
    owner = args.owner or next((z.get("owner", "") for z in existentes.values() if z.get("owner")), "")
    if not owner and args.aplicar:
        raise SystemExit(
            "No se pudo deducir el dueño (la base no tiene zonas). "
            "Pasa --owner con el usuario que va a administrarlos."
        )

    crear = [p for p in puntos if p["nombre"] not in existentes]
    actualizar = [p for p in puntos if p["nombre"] in existentes]

    print()
    print(f"A crear     : {len(crear)}")
    print(f"A actualizar: {len(actualizar)}  (ya existen con ese nombre)")
    if actualizar:
        print("   se les reescribe dirección, comuna, coordenadas y tipo;")
        print("   NO se tocan frecuencia, barrio ni active.")
    print()
    for p in puntos[:5]:
        marca = "nuevo" if p["nombre"] in {c["nombre"] for c in crear} else "existe"
        print(f"  [{marca:<6}] {p['tipo']:<12} ({p['lat']:.5f}, {p['lng']:.5f})  {p['nombre']}")
    if len(puntos) > 5:
        print(f"  ... y {len(puntos) - 5} más")

    if not args.aplicar:
        print()
        print("SIMULACIÓN: no se escribió nada. Agrega --aplicar para cargar.")
        return

    ahora = datetime.now(timezone.utc)
    creados = tocados = 0
    for p in puntos:
        # Solo los campos que el KMZ trae. `frecuencia`, `barrio` y `active`
        # quedan fuera a propósito: ver el docstring del módulo.
        campos = {
            "address": p["nombre"],
            "comuna": COMUNA,
            "lat": p["lat"],
            "lng": p["lng"],
            "tipo": p["tipo"],
            "kind": "permanente",
        }
        if p["nombre"] in existentes:
            db.zones.update_one({"_id": existentes[p["nombre"]]["_id"]}, {"$set": campos})
            tocados += 1
        else:
            db.zones.insert_one({
                **campos,
                "name": p["nombre"],
                "owner": owner,
                "createdAt": ahora,
                "active": True,
            })
            creados += 1

    print()
    print(f"Listo: {creados} creados, {tocados} actualizados.")
    print(f"Total de zonas en la base: {db.zones.count_documents({})}")


if __name__ == "__main__":
    main()
