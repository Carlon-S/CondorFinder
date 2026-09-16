"""Migración: agrupar los análisis ya guardados en zonas.

Hasta ahora cada análisis guardado era una isla con su propio nombre, y lo
único que vinculaba dos análisis del mismo terreno era la cadena de HDU7
(`supersededBy` / `historical`). El modelo nuevo introduce una zona explícita,
que es la que persiste en el tiempo y agrupa las versiones (vuelos) con sus
análisis.

Esta migración usa esas cadenas como semilla: cada cadena existente se
convierte en una zona. Es una heurística tan buena como las confirmaciones de
duplicado que se hicieron en su momento, así que **corre en simulación por
defecto** y hay que revisar la salida antes de aplicar nada. Si alguna
agrupación quedó mal, se corrige después con el endpoint de reasignar versión.

Uso, desde backendModel/ y con el entorno del backend activo:

    python scripts/migrar_zonas.py            # simulación, no escribe nada
    python scripts/migrar_zonas.py --aplicar  # escribe

Es idempotente: los análisis que ya tienen zoneId se saltan, así que se puede
volver a correr sin duplicar zonas.
"""

import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pymongo import MongoClient  # noqa: E402

MONGODB_URI = os.getenv("MONGODB_URI")
# Mismo nombre de variable que usa el lifespan de orquestador.py, para que el
# script apunte a la misma base sin configuración aparte.
DB_NAME = os.getenv("MONGODB_DB_NAME", "condorfinder")


def construir_grupos(analisis: list[dict]) -> list[list[dict]]:
    """Agrupa los análisis siguiendo las cadenas de reemplazo de HDU7.

    `supersededBy` apunta del análisis viejo al que lo reemplazó, así que dos
    análisis quedan en el mismo grupo si hay un camino entre ellos por ese
    campo, en cualquier dirección. Se recorre como un grafo no dirigido, igual
    que hace mergeOverlapping en el frontend con las detecciones solapadas.
    """
    por_id = {str(a["_id"]): a for a in analisis}
    vecinos: dict[str, set] = {k: set() for k in por_id}

    for a in analisis:
        actual = str(a["_id"])
        sucesor = a.get("supersededBy")
        if sucesor and sucesor in por_id:
            vecinos[actual].add(sucesor)
            vecinos[sucesor].add(actual)

    vistos: set = set()
    grupos: list[list[dict]] = []
    for clave in por_id:
        if clave in vistos:
            continue
        cola = [clave]
        grupo: list[str] = []
        while cola:
            nodo = cola.pop()
            if nodo in vistos:
                continue
            vistos.add(nodo)
            grupo.append(nodo)
            cola.extend(v for v in vecinos[nodo] if v not in vistos)
        grupos.append([por_id[k] for k in grupo])

    return grupos


def nombre_de_grupo(grupo: list[dict]) -> str:
    """El nombre de la zona sale del análisis más reciente del grupo: es el que
    el trabajador escribió último y por lo tanto el vigente."""
    mas_nuevo = max(grupo, key=lambda a: a.get("savedAt") or datetime.min.replace(tzinfo=timezone.utc))
    return mas_nuevo.get("name") or "Zona sin nombre"


def main() -> int:
    aplicar = "--aplicar" in sys.argv

    if not MONGODB_URI:
        print("Falta MONGODB_URI en el entorno.")
        return 1

    cliente = MongoClient(MONGODB_URI)
    db = cliente[DB_NAME]

    pendientes = list(db.analyses.find({"zoneId": {"$in": [None, ""]}}))
    ya_migrados = db.analyses.count_documents({"zoneId": {"$nin": [None, ""]}})

    print(f"Análisis sin zona: {len(pendientes)}")
    print(f"Análisis ya migrados (se saltan): {ya_migrados}")
    if not pendientes:
        print("Nada que migrar.")
        return 0

    grupos = construir_grupos(pendientes)
    print(f"Zonas a crear: {len(grupos)}\n")

    for i, grupo in enumerate(grupos, start=1):
        nombre = nombre_de_grupo(grupo)
        # La versión es la tarea de origen. Los análisis sin ella cuentan como
        # versión propia, porque no hay forma de saber con cuál compartían
        # vuelo.
        versiones = {a.get("sourceTaskId") or f"sin-tarea-{a['_id']}" for a in grupo}
        sin_fecha = sum(1 for a in grupo if not a.get("captureDate"))
        print(f"{i:3}. {nombre}")
        print(f"     análisis: {len(grupo)}   versiones: {len(versiones)}   sin fecha de captura: {sin_fecha}")
        for a in sorted(grupo, key=lambda x: x.get("savedAt") or datetime.min.replace(tzinfo=timezone.utc)):
            marca = "histórico" if a.get("historical") else "vigente  "
            print(f"       - {marca}  {a.get('savedAt')}  {a.get('name')}")
        print()

    if not aplicar:
        print("Simulación. Revisa la agrupación de arriba y, si es correcta,")
        print("vuelve a correr con --aplicar.")
        return 0

    creadas = 0
    actualizados = 0
    for grupo in grupos:
        zona = db.zones.insert_one({
            "owner": grupo[0].get("owner", "admin"),
            "name": nombre_de_grupo(grupo),
            "createdAt": datetime.now(timezone.utc),
        })
        creadas += 1
        for a in grupo:
            # savedAt como fecha de captura es lo único disponible en los
            # registros viejos: nadie guardó el EXIF en su momento. Queda
            # marcada como estimada para que la interfaz lo advierta y permita
            # corregirla.
            db.analyses.update_one(
                {"_id": a["_id"]},
                {"$set": {
                    "zoneId": str(zona.inserted_id),
                    "captureDate": a.get("captureDate") or a.get("savedAt"),
                    "captureDateEstimated": True,
                    "uploadedAt": a.get("uploadedAt") or a.get("savedAt"),
                }},
            )
            actualizados += 1

    print(f"Listo. Zonas creadas: {creadas}. Análisis actualizados: {actualizados}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
