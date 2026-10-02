"""Carga la flota real de la municipalidad como punto de salida y recursos (HDU8).

Lee `scripts/datos/flota_maipu.json`, que produjo `parsear_flota.py` a partir de
la planilla de la Dirección de Aseo. Este script NO lee el Excel: así el
servidor no necesita openpyxl ni el archivo original, y lo que entra al sistema
es exactamente lo que está versionado en el repositorio.

**Corre en simulación por omisión.** Imprime lo que haría y no escribe nada
hasta que se le pasa --aplicar, igual que migrar_zonas.py.

Es idempotente en los dos niveles:

  - El punto se busca por su dirección, que es la identidad real de un lugar.
    Si ya existe se actualiza en vez de crear un duplicado.
  - Cada recurso se busca por N° de equipo dentro de ese punto. El N° de equipo
    es el identificador que usa la municipalidad en sus propias planillas de
    programación diaria, así que es la clave natural.

Lo que NO pisa al volver a correr: el campo `disponible`. Si alguien marcó un
camión como no disponible desde la interfaz, una reimportación no lo vuelve a
poner en servicio. Esa marca es información operacional que el sistema
aprendió después de la carga, y la planilla no sabe nada de ella.

Uso, desde backendModel/ con el entorno del backend activo:

    python scripts/importar_flota.py             # simulación
    python scripts/importar_flota.py --aplicar   # escribe
"""

import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pymongo import MongoClient  # noqa: E402

JSON_FLOTA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "datos", "flota_maipu.json")

# Mismo mapa que resources.py. Se repite acá a propósito en vez de importar el
# módulo: importarlo arrastra fastapi y el resto del backend para un script que
# solo necesita hablar con Mongo. Si divergen, el validador del endpoint
# rechaza el tipo desconocido, así que la divergencia se nota al primer POST y
# no queda silenciosa.
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


def _campos_del_recurso(r, point_id, familia):
    """Documento del recurso, con los campos de su familia y los demás nulos.

    La familia decide qué campos tienen sentido: una retroexcavadora no lleva
    capacidad de carga y un carro de arrastre no lleva dotación. Se escriben
    explícitamente nulos o en cero en vez de omitirse, para que un documento
    viejo y uno nuevo tengan la misma forma y las lecturas no tengan que
    distinguir "no aplica" de "campo que todavía no existía".
    """
    return {
        "tipo": r["tipo"],
        "numero_equipo": r["numeroEquipo"],
        "patente": r.get("patente") or "",
        "marca": r.get("marca") or "",
        "modelo": r.get("modelo") or "",
        "anio": r.get("anio"),
        # "carga" Y "arrastre", igual que _validar_tipo_y_familia() en
        # resources.py. El arrastre la declara porque un CARRO RECICLAJE lleva
        # 30 m³ y necesita que alguien lo tire, y las dos cosas son ciertas;
        # que la declare no lo mete en ninguna ruta, porque
        # capacidad_de_carga_por_punto() sigue filtrando por "carga".
        #
        # Esta línea decía solo "carga", de antes de esa corrección, y como el
        # upsert hace $set con todos los campos, volver a correr el importador
        # borraba los 30 m³ de los dos carros de reciclaje sin decir nada.
        "capacidad_m3": r.get("capacidadM3") if familia in ("carga", "arrastre") else None,
        # Peso maximo, misma regla de familia que el volumen.
        "capacidad_ton": r.get("capacidadTon") if familia in ("carga", "arrastre") else None,
        "capacidad_balde_m3": r.get("capacidadBaldeM3") if familia == "maquina" else None,
        "conductores_requeridos": 0 if familia == "arrastre" else r.get("conductoresRequeridos", 0),
        "peonetas_requeridas": 0 if familia == "arrastre" else r.get("peonetasRequeridas", 0),
        "operadores_requeridos": 0 if familia == "arrastre" else r.get("operadoresRequeridos", 0),
        "observaciones": r.get("observaciones") or "",
        "foto": r.get("foto"),
        "pointId": point_id,
    }


def main():
    aplicar = "--aplicar" in sys.argv

    if not os.path.isfile(JSON_FLOTA):
        print(f"No existe {JSON_FLOTA}")
        print("Corre primero: python scripts/parsear_flota.py \"<ruta a Datos Recursos>\"")
        sys.exit(1)

    with open(JSON_FLOTA, encoding="utf-8") as fh:
        datos = json.load(fh)

    punto = datos["punto"]
    recursos = datos["recursos"]

    if punto.get("lat") is None or punto.get("lng") is None:
        print("El punto no tiene coordenadas y sin ellas no sirve como origen de ruta.")
        print("Complétalas en PUNTO de parsear_flota.py y regenera el JSON.")
        sys.exit(1)

    uri = os.environ.get("MONGODB_URI")
    if not uri:
        print("Falta MONGODB_URI en el entorno.")
        sys.exit(1)
    db = MongoClient(uri)[os.environ.get("MONGODB_DB_NAME", "condorfinder")]

    owner = os.environ.get("SEED_ADMIN_USERNAME", "admin")

    print(f"{'APLICANDO' if aplicar else 'SIMULACIÓN, no escribe nada'}")
    print(f"Fuente: {datos.get('fuente')}")
    print(f"Owner:  {owner}")
    print()

    # ── punto de salida ───────────────────────────────────────────────────
    existente = db.resource_points.find_one({"address": punto["direccion"]})
    campos_punto = {
        "name": punto["nombre"],
        "address": punto["direccion"],
        "comuna": punto["comuna"],
        "lat": punto["lat"],
        "lng": punto["lng"],
        "active": True,
    }

    if existente:
        point_id = str(existente["_id"])
        print(f"Punto YA EXISTE: {existente.get('name')} ({point_id}), se actualizan sus datos")
        if aplicar:
            # El NOMBRE no se pisa: el que viene del JSON es un respaldo (la
            # dirección), y si alguien le puso el nombre real desde la interfaz,
            # una reimportación no tiene por qué deshacerlo. Mismo criterio que
            # con `disponible` en los recursos.
            sin_nombre = {k: v for k, v in campos_punto.items() if k != "name"}
            db.resource_points.update_one({"_id": existente["_id"]}, {"$set": sin_nombre})
    else:
        print(f"Punto NUEVO: {punto['nombre']}, {punto['direccion']}, {punto['comuna']}")
        print(f"  coordenadas {punto['lat']}, {punto['lng']}")
        if aplicar:
            # El punto ya no lleva contadores de maquinaria: su capacidad vive
            # en los recursos. personal_count queda en cero porque la planilla
            # de flota no trae dotación del patio, solo la que requiere cada
            # vehículo, y ese dato hay que pedirlo aparte.
            doc = {
                **campos_punto,
                "personal_count": 0,
                "owner": owner,
                "created_at": datetime.now(timezone.utc),
            }
            point_id = str(db.resource_points.insert_one(doc).inserted_id)
        else:
            point_id = "<nuevo>"

    print()

    # ── recursos ──────────────────────────────────────────────────────────
    nuevos = 0
    actualizados = 0
    saltados = []

    for r in recursos:
        familia = FAMILIA_POR_TIPO.get(r["tipo"])
        if familia is None:
            saltados.append(f"{r['numeroEquipo']}: tipo '{r['tipo']}' desconocido")
            continue

        campos = _campos_del_recurso(r, point_id, familia)
        previo = (
            db.resources.find_one({"numero_equipo": r["numeroEquipo"], "pointId": point_id})
            if point_id != "<nuevo>"
            else None
        )

        etiqueta = f"{r['numeroEquipo']:>5} {r['tipo']:<18}"
        if campos["capacidad_m3"]:
            capacidad = f"carga {campos['capacidad_m3']} m³"
        elif campos["capacidad_ton"]:
            # El CAMION 3/4 PLANO declara su limite en TONELADAS y no en m³, asi
            # que sin esta rama se seguia imprimiendo "sin capacidad declarada"
            # para una unidad cuyo dato ya tenemos.
            capacidad = f"carga {campos['capacidad_ton']} t"
        elif campos["capacidad_balde_m3"]:
            capacidad = f"balde {campos['capacidad_balde_m3']} m³"
        else:
            capacidad = "sin capacidad declarada"
        foto = campos["foto"] or "sin foto"

        if previo:
            actualizados += 1
            print(f"  ACTUALIZA {etiqueta} {capacidad:<28} {foto}")
            if aplicar:
                # disponible NO se toca: ver la nota del encabezado.
                db.resources.update_one({"_id": previo["_id"]}, {"$set": campos})
        else:
            nuevos += 1
            print(f"  CREA      {etiqueta} {capacidad:<28} {foto}")
            if aplicar:
                db.resources.insert_one({
                    **campos,
                    "disponible": r.get("disponible", True),
                    "owner": owner,
                    "created_at": datetime.now(timezone.utc),
                })

    print()
    print(f"{nuevos} a crear, {actualizados} a actualizar, {len(saltados)} saltados")

    # Un vehiculo de carga sin NINGUNA capacidad declarada, ni en m³ ni en
    # toneladas. El CAMION 3/4 PLANO salia aca hasta que la municipalidad
    # entrego su limite (1 t, 02-10-2026): tenia el dato, solo que en otra
    # unidad, y seguir reportandolo como un hueco era falso.
    sin_capacidad = [
        r["numeroEquipo"]
        for r in recursos
        if FAMILIA_POR_TIPO.get(r["tipo"]) == "carga"
        and not r.get("capacidadM3")
        and not r.get("capacidadTon")
    ]
    if sin_capacidad:
        print()
        print(f"AVISO: {len(sin_capacidad)} vehículos de carga sin capacidad declarada: "
              f"{', '.join(sin_capacidad)}")
        print("El ruteo los excluye, porque despachar un camión que no puede llevar")
        print("nada da una ruta imposible. Es un dato que hay que pedirle a la")
        print("municipalidad, no algo que se pueda deducir.")

    # Capacidad declarada SOLO en toneladas: el ruteo tampoco los despacha,
    # porque reparte por volumen, pero es una exclusion distinta y conviene que
    # se lean distinto. No es un dato que falte.
    solo_toneladas = [
        r["numeroEquipo"]
        for r in recursos
        if FAMILIA_POR_TIPO.get(r["tipo"]) == "carga"
        and not r.get("capacidadM3")
        and r.get("capacidadTon")
    ]
    if solo_toneladas:
        print()
        print(f"NOTA: {len(solo_toneladas)} vehículos declaran su capacidad en toneladas "
              f"y no en m³: {', '.join(solo_toneladas)}")
        print("El ruteo reparte por volumen, así que no los despacha. En el caso del")
        print("CAMION 3/4 PLANO eso además coincide con lo que pidió la municipalidad:")
        print('"no sería prudente incorporarlo a las rutas que estamos trabajando",')
        print("porque hace retiros de reciclaje y no de escombros.")

    for s in saltados:
        print(f"SALTADO: {s}")

    if not aplicar:
        print()
        print("Nada de esto se escribió. Para aplicarlo:")
        print("    python scripts/importar_flota.py --aplicar")


if __name__ == "__main__":
    main()
