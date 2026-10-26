"""
CONDORFINDER, ITINERARIO SEMANAL DE PUNTOS PERMANENTES (HDU14)
Archivo: backendModel/itinerario.py

La grilla de LUNES a SÁBADO donde la municipalidad reparte sus puntos
permanentes. Es la hoja `PERMANENTES` de su planilla, que hoy mantienen a mano
en Excel.

**No hay una colección de puntos.** Un punto permanente ES una zona
(`analyses.py`, colección `zones`, con `kind: "permanente"`), y eso no es un
atajo: una zona y un punto permanente son el mismo objeto, un lugar de la
comuna que hay que limpiar. Lo único que los distinguía era que el sistema
solo sabía crear el lugar como efecto secundario de guardar un análisis. Con
dos colecciones habría que decidir qué pasa el día que a un punto permanente le
vuelan el dron, y la respuesta correcta (son el mismo) es la que elimina la
pregunta.

Acá vive solo el REPARTO: qué puntos toca cada día. Un documento por día, con
un arreglo ORDENADO de ids de zona, porque el orden dentro de la columna es la
secuencia del recorrido y no un conjunto.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from pymongo.asynchronous.database import AsyncDatabase

import analyses as analyses_module
import auditoria
import auth as auth_module

_db: AsyncDatabase | None = None


def set_db(db: AsyncDatabase) -> None:
    global _db
    _db = db


def get_db() -> AsyncDatabase:
    if _db is None:
        raise RuntimeError("La base de datos no fue inicializada, set_db() debe llamarse en el lifespan.")
    return _db


async def create_index() -> None:
    await get_db().itinerario_dias.create_index("dia", unique=True)


# Los seis días que trae la planilla. Es una tupla de TEXTO y no un enumerado
# de Pydantic a propósito: el día que la municipalidad trabaje domingo, eso es
# agregar un elemento acá y no tocar el modelo ni la base.
DIAS = ("lunes", "martes", "miercoles", "jueves", "viernes", "sabado")


class DiaIn(BaseModel):
    """La lista ORDENADA de puntos de un día.

    Se reemplaza entera en vez de tener un endpoint por alta y otro por baja:
    la vista arrastra y reordena, así que después de cada gesto lo que tiene es
    la lista final. Mandar diferencias obligaría al frontend a calcularlas y a
    los dos lados a coincidir en el resultado.
    """
    puntos: list[str]


class PuntoDelDia(BaseModel):
    """Un punto ya resuelto contra `zones`, listo para dibujar."""
    id: str
    name: str
    address: str | None = None
    barrio: str | None = None
    tipo: str | None = None
    frecuencia: str | None = None
    photoUrl: str | None = None
    lat: float | None = None
    lng: float | None = None
    active: bool = True


class DiaOut(BaseModel):
    dia: str
    puntos: list[PuntoDelDia]


router = APIRouter(prefix="/itinerario", tags=["itinerario"])


def _validar_dia(dia: str) -> str:
    d = dia.strip().lower()
    if d not in DIAS:
        raise HTTPException(status_code=400, detail=f"Día desconocido: {dia}")
    return d


def _como_punto(doc: dict) -> PuntoDelDia:
    return PuntoDelDia(
        id=str(doc["_id"]),
        name=doc["name"],
        address=doc.get("address"),
        barrio=doc.get("barrio"),
        tipo=doc.get("tipo"),
        frecuencia=doc.get("frecuencia"),
        photoUrl=doc.get("photoUrl"),
        lat=doc.get("lat"),
        lng=doc.get("lng"),
        active=doc.get("active", True),
    )


async def _zonas_por_id(ids: list[str]) -> dict[str, dict]:
    """Las zonas de esos ids, en UNA consulta para toda la grilla.

    Sin esto serían seis consultas (una por día) o, peor, una por punto. La
    grilla completa de la municipalidad son unos 40 puntos repartidos.
    """
    oids = []
    for i in ids:
        try:
            oids.append(analyses_module._object_id(i))
        except HTTPException:
            # Un id guardado que ya no es un ObjectId válido. Se ignora en vez
            # de tumbar la grilla entera: ver el filtrado de abajo.
            continue
    if not oids:
        return {}
    docs = await get_db().zones.find({"_id": {"$in": oids}}).to_list(length=None)
    return {str(d["_id"]): d for d in docs}


@router.get("", response_model=list[DiaOut])
async def get_itinerario(
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """La grilla completa, siempre con los seis días.

    Devuelve el día aunque no tenga documento ni puntos: el frontend dibuja seis
    columnas pase lo que pase, y hacerle inventar las que faltan sería ponerle a
    él la lista de días que ya está acá.
    """
    docs = await get_db().itinerario_dias.find().to_list(length=None)
    por_dia = {d["dia"]: d.get("puntos", []) for d in docs}

    todos = [p for lista in por_dia.values() for p in lista]
    zonas = await _zonas_por_id(todos)

    salida = []
    for dia in DIAS:
        # **Se filtran los ids que ya no resuelven.** `delete_zone` hace un
        # `$pull` al borrar, así que en condiciones normales no debería quedar
        # ninguno; esto cubre un documento escrito por una versión anterior del
        # sistema, o un borrado hecho a mano en Mongo. Un hueco silencioso en la
        # grilla es peor que un punto que simplemente no está.
        puntos = [_como_punto(zonas[pid]) for pid in por_dia.get(dia, []) if pid in zonas]
        salida.append(DiaOut(dia=dia, puntos=puntos))
    return salida


@router.put("/{dia}", response_model=DiaOut)
async def set_dia(
    dia: str,
    payload: DiaIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Reemplaza la lista ordenada de un día."""
    d = _validar_dia(dia)

    # Duplicados dentro del MISMO día se colapsan, conservando la primera
    # aparición. En la planilla una columna nunca repite un punto, y repetirlo
    # significaría pasar dos veces por el mismo lugar el mismo día. Que el
    # mismo punto esté en VARIOS días sí está permitido y es lo normal: El
    # Conquistador está lunes, miércoles, jueves y sábado.
    vistos: set[str] = set()
    limpios: list[str] = []
    for pid in payload.puntos:
        if pid not in vistos:
            vistos.add(pid)
            limpios.append(pid)

    zonas = await _zonas_por_id(limpios)
    desconocidos = [p for p in limpios if p not in zonas]
    if desconocidos:
        raise HTTPException(
            status_code=400,
            detail=f"Hay {len(desconocidos)} punto(s) que ya no existen. Recarga la vista.",
        )

    await get_db().itinerario_dias.update_one(
        {"dia": d},
        {
            "$set": {"puntos": limpios, "updatedAt": datetime.now(timezone.utc)},
            "$setOnInsert": {"dia": d, "owner": current_user.username},
        },
        upsert=True,
    )
    await auditoria.registrar(
        current_user.username, "editar", "itinerario", d, {"puntos": len(limpios)}
    )
    return DiaOut(dia=d, puntos=[_como_punto(zonas[p]) for p in limpios])
