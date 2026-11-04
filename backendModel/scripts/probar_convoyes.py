"""Pruebas del reparto de paradas entre convoyes de un mismo punto.

Usa las funciones reales de `routing.py` (`_partir_en_convoyes`,
`_repartir_por_carga` y `_capacidad_de_viaje`), con la flota real de la
municipalidad (2 AMPLIROLL de 20 m³ y 6 TOLVA de 10 m³). No necesita Mongo ni el
servicio de rutas.

Comprueba que:

  - cuando se piden N convoyes y hay al menos N paradas, los N convoyes reciben
    alguna parada, aunque un solo convoy retirara todo con menos viajes;
  - con menos paradas que convoyes, cada parada se asigna y los convoyes
    sobrantes quedan vacíos;
  - cada parada se asigna exactamente a un convoy;
  - un convoy que no se puede tripular no recibe paradas;
  - entre repartos que dejan todos los convoyes con paradas, se elige el de
    menos viajes.

Se ejecuta desde la raíz del repositorio, con el entorno del backend:

    backendModel/joining/venv/bin/python backendModel/scripts/probar_convoyes.py
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import routing  # noqa: E402

errores = []


def comprobar(condicion, mensaje):
    if condicion:
        print(f"  ok   {mensaje}")
    else:
        print(f"  FALLA {mensaje}")
        errores.append(mensaje)


def camion(i, tipo, m3, ton, peonetas):
    return {
        "resourceId": f"r{i}",
        "tipo": tipo,
        "patente": f"P{i}",
        "capacity_m3": m3,
        "capacity_ton": ton,
        "conductores": 1,
        "peonetas": peonetas,
    }


# Dotación de la flota real: el AMPLIROLL pide 1 conductor y 1 peoneta; la TOLVA,
# 1 conductor y 2 peonetas.
FLOTA = [camion(1, "AMPLIROLL", 20, 15, 1), camion(2, "AMPLIROLL", 20, 15, 1)] + [
    camion(i, "TOLVA", 10, None, 2) for i in range(3, 9)
]
PUNTO = {"_id": "patio", "name": "Patio", "trucks": FLOTA}


def parada(indice, volumen):
    return {"stopId": f"p{indice}", "volumeM3": volumen, "weightTon": 0}


def repartir(volumenes, convoyes=2, personal=None):
    stops = [parada(i, v) for i, v in enumerate(volumenes)]
    lista = routing._partir_en_convoyes(PUNTO, convoyes)
    reparto = routing._repartir_por_carga(lista, stops, personal)
    return stops, lista, reparto


def viajes_totales(lista, reparto, personal=None):
    """Viajes que cuesta el reparto, con la misma cuenta que usa el algoritmo."""
    pool = None if personal is None else {r: list(n) for r, n in personal.items()}
    total = 0
    for c in lista:
        zonas = reparto[str(c["_id"])]
        volumen = sum(z["volumeM3"] for z in zonas)
        if volumen <= 0:
            continue
        cap, nombres = routing._capacidad_de_viaje(c, zonas, pool)
        total += math.ceil(volumen / cap - 1e-9)
        if pool is not None:
            for rol in pool:
                pool[rol] = [n for n in pool[rol] if n not in nombres]
    return total


def con_paradas(lista, reparto):
    return sum(1 for c in lista if reparto[str(c["_id"])])


def se_conservan(stops, reparto):
    asignadas = sorted(z["stopId"] for zonas in reparto.values() for z in zonas)
    return asignadas == sorted(s["stopId"] for s in stops)


print("los convoyes pedidos salen todos")
stops, lista, reparto = repartir([30, 15, 6, 4, 5], 2)
comprobar(con_paradas(lista, reparto) == 2, "30, 15, 6, 4, 5 con 2 convoyes: salen los 2")
comprobar(se_conservan(stops, reparto), "cada parada queda en un solo convoy")

stops, lista, reparto = repartir([30, 15, 6, 4, 5], 3)
comprobar(con_paradas(lista, reparto) == 3, "30, 15, 6, 4, 5 con 3 convoyes: salen los 3")
comprobar(se_conservan(stops, reparto), "cada parada queda en un solo convoy (3 convoyes)")

stops, lista, reparto = repartir([30, 15, 6, 4, 5], 4)
comprobar(con_paradas(lista, reparto) == 4, "30, 15, 6, 4, 5 con 4 convoyes: salen los 4")
comprobar(se_conservan(stops, reparto), "cada parada queda en un solo convoy (4 convoyes)")

for volumenes in ([30, 25, 20, 15, 6], [40, 40, 40], [25, 25, 25, 25], [20, 20, 20, 20, 20], [30, 30, 6, 4, 5]):
    stops, lista, reparto = repartir(volumenes, 2)
    comprobar(
        con_paradas(lista, reparto) == 2 and se_conservan(stops, reparto),
        f"{volumenes} con 2 convoyes: salen los 2",
    )

print("menos paradas que convoyes")
stops, lista, reparto = repartir([30], 2)
comprobar(con_paradas(lista, reparto) == 1, "una parada y 2 convoyes: sale 1")
comprobar(se_conservan(stops, reparto), "la parada queda asignada")

stops, lista, reparto = repartir([30, 12], 4)
comprobar(con_paradas(lista, reparto) == 2, "dos paradas y 4 convoyes: salen 2")
comprobar(se_conservan(stops, reparto), "las dos paradas quedan asignadas")

print("un solo convoy")
stops, lista, reparto = repartir([30, 15, 6, 4, 5], 1)
comprobar(len(lista) == 1 and se_conservan(stops, reparto), "con 1 convoy todas las paradas van a ese convoy")

print("entre repartos con todos los convoyes saliendo, el de menos viajes")
volumenes = [30, 25, 20, 15]
personal = {"conductor": ["C1", "C2"], "peoneta": ["P1", "P2"]}
stops, lista, reparto = repartir(volumenes, 2, personal)
comprobar(con_paradas(lista, reparto) == 2, "30, 25, 20, 15 con 2 conductores y 2 peonetas: salen los 2")
comprobar(viajes_totales(lista, reparto, personal) == 5, "el reparto cuesta 5 viajes (el mínimo posible)")
comprobar(se_conservan(stops, reparto), "cada parada queda en un solo convoy")

print("un convoy que no se puede tripular no recibe paradas")
solo_uno = {"conductor": ["C1"], "peoneta": ["P1", "P2"]}
stops, lista, reparto = repartir([30, 15, 6, 4, 5], 2, solo_uno)
comprobar(con_paradas(lista, reparto) == 1, "con personal para un solo vehículo sale un solo convoy")
comprobar(se_conservan(stops, reparto), "todas las paradas quedan asignadas al convoy que sí se puede tripular")

print()
if errores:
    print(f"{len(errores)} comprobaciones fallaron")
    sys.exit(1)
print("todas las comprobaciones pasaron")
