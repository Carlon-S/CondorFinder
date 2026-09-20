"""Limpieza: borra zonas que se quedaron sin ningún análisis.

Hasta hace poco `DELETE /analyses/{id}` era un delete_one pelado sobre la
colección `analyses`, y en toda la API no existía (ni existe) un borrado de
zonas. Resultado: cada vez que alguien eliminaba la última captura de una zona,
el documento de esa zona quedaba en la base para siempre.

Eso se nota en el diálogo "Generar informe" de Vista Principal, que lista las
zonas: aparecían filas con "0 capturas · 0 análisis", marcables pero sin nada
que aportar al documento, acumulándose con cada borrado.

El endpoint ya se corrigió y ahora borra la zona cuando elimina su último
análisis, así que esto NO se va a volver a acumular. Este script es para
limpiar lo que quedó de antes.

Tres huérfanos más que arrastra la misma causa, y que este script también
reporta (y repara con --aplicar):

  - análisis marcados `historical` cuyo `supersededBy` apunta a un id que ya
    no existe: quedan ocultos de todos los filtros salvo "Historial", y ahí su
    "Reemplazado por:" sale en blanco. Se les devuelve el estado vigente.
  - análisis con `possibleDuplicateOf` apuntando a un id inexistente: quedan
    en `duplicateStatus: "pending"` contra la nada, sin banner posible. Se
    vuelven al estado inicial.

Uso, desde backendModel/ y con el entorno del backend activo:

    python scripts/limpiar_zonas_huerfanas.py            # simulación
    python scripts/limpiar_zonas_huerfanas.py --aplicar  # escribe

Es idempotente: correrlo de nuevo sobre una base ya limpia no hace nada.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bson import ObjectId  # noqa: E402
from pymongo import MongoClient  # noqa: E402

MONGODB_URI = os.getenv("MONGODB_URI")
# Mismo nombre de variable que usa el lifespan de orquestador.py, para que el
# script apunte a la misma base sin configuración aparte.
DB_NAME = os.getenv("MONGODB_DB_NAME", "condorfinder")


def main() -> int:
    aplicar = "--aplicar" in sys.argv

    if not MONGODB_URI:
        print("Falta MONGODB_URI en el entorno.")
        return 1

    cliente = MongoClient(MONGODB_URI)
    db = cliente[DB_NAME]

    analisis = list(db.analyses.find({}, {"zoneId": 1, "name": 1, "supersededBy": 1,
                                          "possibleDuplicateOf": 1, "historical": 1}))
    zonas = list(db.zones.find({}))

    ids_analisis = {str(a["_id"]) for a in analisis}
    zonas_en_uso = {a.get("zoneId") for a in analisis if a.get("zoneId")}

    huerfanas = [z for z in zonas if str(z["_id"]) not in zonas_en_uso]
    cadenas_rotas = [
        a for a in analisis
        if a.get("supersededBy") and a["supersededBy"] not in ids_analisis
    ]
    duplicados_colgando = [
        a for a in analisis
        if a.get("possibleDuplicateOf") and a["possibleDuplicateOf"] not in ids_analisis
    ]

    print(f"Análisis en la base: {len(analisis)}")
    print(f"Zonas en la base:    {len(zonas)}   (en uso: {len(zonas_en_uso)})")
    print()

    print(f"[1] Zonas huérfanas, sin ningún análisis: {len(huerfanas)}")
    for z in huerfanas:
        print(f"      - {z['_id']}  {z.get('name')!r}  creada {z.get('createdAt')}")
    print()

    print(f"[2] Cadenas de reemplazo rotas: {len(cadenas_rotas)}")
    for a in cadenas_rotas:
        print(f"      - {a['_id']}  {a.get('name')!r}  apunta a {a['supersededBy']} (no existe)")
    print()

    print(f"[3] Duplicados pendientes contra un análisis inexistente: {len(duplicados_colgando)}")
    for a in duplicados_colgando:
        print(f"      - {a['_id']}  {a.get('name')!r}  apunta a {a['possibleDuplicateOf']} (no existe)")
    print()

    if not huerfanas and not cadenas_rotas and not duplicados_colgando:
        print("Nada que limpiar.")
        return 0

    if not aplicar:
        print("Simulación. Revisa la lista de arriba y, si es correcta,")
        print("vuelve a correr con --aplicar.")
        return 0

    if huerfanas:
        r = db.zones.delete_many({"_id": {"$in": [z["_id"] for z in huerfanas]}})
        print(f"Zonas eliminadas: {r.deleted_count}")

    if cadenas_rotas:
        r = db.analyses.update_many(
            {"_id": {"$in": [ObjectId(str(a["_id"])) for a in cadenas_rotas]}},
            {"$set": {"historical": False, "supersededBy": None}},
        )
        print(f"Análisis devueltos a vigente: {r.modified_count}")

    if duplicados_colgando:
        r = db.analyses.update_many(
            {"_id": {"$in": [ObjectId(str(a["_id"])) for a in duplicados_colgando]}},
            {"$set": {"possibleDuplicateOf": None, "duplicateStatus": None}},
        )
        print(f"Duplicados pendientes limpiados: {r.modified_count}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
