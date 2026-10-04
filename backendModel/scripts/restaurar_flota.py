"""Devuelve la flota del punto al estado de la planilla, después de una prueba.

Verificar HDU5.1 obliga a desfigurar la flota: bajar capacidades, cambiar
límites de peso, declarar autonomías que no existen y marcar unidades como no
disponibles. Deshacer eso a mano son decenas de ediciones en la interfaz, y es
justo donde queda una tolva en 4 m³ que después hace que un plan no cuadre y
nadie sepa por qué.

Este script reescribe los campos desde `scripts/datos/flota_maipu.json`, que es
la fuente versionada, y **vuelve a poner todas las unidades como disponibles**.

── Diferencia con importar_flota.py ──
`importar_flota.py` NO toca `disponible`, a propósito: esa marca es información
operacional que el sistema aprendió después de la carga, y una reimportación no
debe pisarla. Acá sí se pisa, y por eso es un script aparte con su propio
nombre: restaurar es exactamente la operación que quiere deshacer lo que el
trabajador (o una prueba) marcó.

**Corre en simulación por omisión**, igual que los otros scripts del proyecto.

Uso, desde el contenedor del backend:

    python backendModel/scripts/restaurar_flota.py             # simulación
    python backendModel/scripts/restaurar_flota.py --aplicar   # escribe
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pymongo import MongoClient  # noqa: E402

JSON_FLOTA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "datos", "flota_maipu.json")

# Los campos que una prueba puede haber tocado. Se restauran TODOS, incluidos
# los que vienen en None: dejar una autonomía declarada porque el JSON no trae
# valor sería dejar justo la restricción que la prueba introdujo.
CAMPOS = ("capacidad_m3", "capacidad_ton", "capacidad_balde_m3", "autonomia_km")

ORIGEN = {
    "capacidad_m3": "capacidadM3",
    "capacidad_ton": "capacidadTon",
    "capacidad_balde_m3": "capacidadBaldeM3",
    "autonomia_km": "autonomiaKm",
}


def main():
    aplicar = "--aplicar" in sys.argv
    if not aplicar:
        print("SIMULACIÓN, no escribe nada")

    if not os.path.exists(JSON_FLOTA):
        print(f"No existe {JSON_FLOTA}")
        sys.exit(1)

    with open(JSON_FLOTA, encoding="utf-8") as f:
        datos = json.load(f)

    uri = os.environ.get("MONGODB_URI")
    if not uri:
        print("Falta MONGODB_URI en el entorno.")
        sys.exit(1)
    db = MongoClient(uri)[os.environ.get("MONGODB_DB_NAME", "condorfinder")]

    direccion = datos["punto"]["direccion"]
    punto = db.resource_points.find_one({"address": direccion})
    if not punto:
        print(f"No se encontró el punto con dirección {direccion}")
        sys.exit(1)
    point_id = str(punto["_id"])
    print(f"Punto: {punto.get('name')} ({point_id})")
    print()

    cambiados = 0
    sin_cambios = 0
    no_encontrados = []

    for r in datos["recursos"]:
        doc = db.resources.find_one({"numero_equipo": r["numeroEquipo"], "pointId": point_id})
        if not doc:
            no_encontrados.append(r["numeroEquipo"])
            continue

        esperado = {campo: r.get(ORIGEN[campo]) for campo in CAMPOS}
        esperado["disponible"] = True

        difieren = {
            campo: (doc.get(campo), valor)
            for campo, valor in esperado.items()
            if doc.get(campo) != valor
        }
        if not difieren:
            sin_cambios += 1
            continue

        cambiados += 1
        detalle = ", ".join(f"{c}: {antes} -> {ahora}" for c, (antes, ahora) in difieren.items())
        print(f"  {r['numeroEquipo']:>5} {r['tipo']:<18} {detalle}")
        if aplicar:
            db.resources.update_one({"_id": doc["_id"]}, {"$set": esperado})

    # El punto también: una prueba puede haberlo desactivado.
    if not punto.get("active", True):
        cambiados += 1
        print(f"  PUNTO  {punto.get('name')}: active False -> True")
        if aplicar:
            db.resource_points.update_one({"_id": punto["_id"]}, {"$set": {"active": True}})

    print()
    print(f"{cambiados} a restaurar, {sin_cambios} ya estaban bien")
    for ne in no_encontrados:
        print(f"AVISO: {ne} no existe en la base, no se restauró")

    if cambiados == 0:
        print()
        print("La flota ya está en su estado original.")
    elif not aplicar:
        print()
        print("Nada de esto se escribió. Para aplicarlo:")
        print("    python backendModel/scripts/restaurar_flota.py --aplicar")


if __name__ == "__main__":
    main()
