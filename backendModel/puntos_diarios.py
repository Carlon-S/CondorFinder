"""
CONDORFINDER, PUNTOS DIARIOS DE RETIRO (HDU15)
Archivo: backendModel/puntos_diarios.py

Los retiros del día que NO son permanentes: escombros y extras. Son las tablas
"RETIRO DE FONO ESCOMBROS" y "RETIROS EXTRAS" de cada hoja diaria de la
planilla municipal.

**Por qué no son zonas.** Un punto permanente es un lugar que la municipalidad
sigue en el tiempo, así que es una zona con historia. Un punto diario es un
hecho de una fecha: alguien llamó, se fue a retirar, se terminó. Guardarlos
como zonas llenaría Vista Principal de cientos de lugares de una sola visita y
volvería inútil la lista de lo que de verdad hay que seguir.

**Lo declarado no es lo retirado.** La planilla trae CANT. (lo que dijo el
vecino) y M3 RETIRO (lo que se sacó), y en sus hojas coinciden porque se
llenan al final del día. Acá solo se captura lo primero: lo segundo es un
hecho posterior, y confundirlos impediría después comparar lo pedido contra lo
retirado, que es justamente para lo que sirve tenerlos separados.
"""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from pymongo import ReturnDocument
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


# Las dos clases que pide el AC1 de HDU15.
CLASE_ESCOMBROS = "escombros"
CLASE_EXTRAS = "extras"
CLASES = (CLASE_ESCOMBROS, CLASE_EXTRAS)

# Lo que la planilla pone en la columna TIPO de la tabla de escombros.
TIPOS_ESCOMBRO = ("ESC", "RAMAS", "MIXTO", "VOLUMINOSOS")

# Los 17 programas de la hoja SOLICITUDES, con su área de gestión. Se siembran
# al arrancar y se pueden agregar más desde la interfaz: son el vocabulario de
# la municipalidad, no una constante del sistema.
SOLICITUDES_BASE = [
    ("ADIOS CACHUREOS/HOLA LIMPIEZA", "PREVENCIÓN"),
    ("ALÓ ESCOMBROS", "PREVENCIÓN"),
    ("CANALES", "CONTROL"),
    ("CASO SOCIAL (DIDECO)", "CONTROL"),
    ("EMERGENCIAS", "CONTROL"),
    ("INCENDIOS", "CONTROL"),
    ("MESA DE ESPACIOS PÚBLICOS", "CONTROL"),
    ("ONG SIN FINES DE LUCRO", "PREVENCIÓN"),
    ("OPERATIVOS RECICLAJE", "PREVENCIÓN"),
    ("ORGANIZACIONES COMUNITARIAS (JJVV)", "CONTROL"),
    ("ORNATO", "CONTROL"),
    ("OTROS REQUERIMIENTOS", "CONTROL"),
    ("RETIRO A ESTABLECIMIENTO EDUCACIONAL", "PREVENCIÓN"),
    ("RETIRO A INSTITUCIONES O CORPORACIONES", "PREVENCIÓN"),
    ("RETIRO A REQUERIMIENTO (BASURA)", "CONTROL"),
    ("RETIRO PERMANENTE DE MICROBASURALES", "CONTROL"),
    ("RETIRO VIRS", "CONTROL"),
]


async def create_index() -> None:
    await get_db().puntos_diarios.create_index([("fecha", 1), ("clase", 1)])
    await get_db().solicitudes.create_index("nombre", unique=True)


async def sembrar_solicitudes() -> None:
    """Carga los 17 programas si no están. Idempotente, corre en cada arranque.

    Siembra y no migración con script porque es vocabulario fijo que la
    municipalidad ya entregó por escrito, y porque sin él el desplegable de
    "extras" aparece vacío en una instalación nueva, que se lee como un error.
    """
    for nombre, area in SOLICITUDES_BASE:
        await get_db().solicitudes.update_one(
            {"nombre": nombre},
            {"$setOnInsert": {"nombre": nombre, "area": area, "base": True}},
            upsert=True,
        )


# =============================================================================
# MODELOS
# =============================================================================

class SolicitudIn(BaseModel):
    nombre: str
    area: str = "CONTROL"


class SolicitudOut(BaseModel):
    id: str
    nombre: str
    area: str
    base: bool = False


class PuntoDiarioIn(BaseModel):
    """Un retiro del día.

    Los campos específicos de cada clase viven en el mismo modelo, opcionales,
    en vez de en dos modelos separados. Son dos formularios en pantalla pero un
    solo tipo de registro, y partirlo obligaría a duplicar la mitad de los
    campos (dirección, barrio, teléfono, coordenadas) y a elegir entre dos
    endpoints de alta que hacen lo mismo.

    `_validar()` es lo que impide que un escombro llegue con solicitante: el
    campo que no corresponde a la clase se rechaza en vez de guardarse y
    olvidarse, mismo criterio que `_validar_tipo_y_familia()` en resources.py.
    """
    clase: str
    fecha: date
    address: str = ""
    barrio: str | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    telefono: str | None = None
    # Lo que declara quien llama. En m³, igual que la planilla.
    volumenM3: float | None = Field(default=None, ge=0)

    # Solo escombros
    tipoResiduo: str | None = None
    # Solo extras
    solicitud: str | None = None
    solicitante: str | None = None


class PuntoDiarioOut(PuntoDiarioIn):
    id: str
    owner: str
    createdAt: datetime


router = APIRouter(prefix="/puntos-diarios", tags=["puntos-diarios"])


def _validar(p: PuntoDiarioIn) -> None:
    if p.clase not in CLASES:
        raise HTTPException(status_code=400, detail=f"Clase desconocida: {p.clase}")

    if p.clase == CLASE_ESCOMBROS:
        if p.solicitud or p.solicitante:
            raise HTTPException(
                status_code=400,
                detail="Un punto de escombros no lleva solicitud ni solicitante.",
            )
        if p.tipoResiduo and p.tipoResiduo not in TIPOS_ESCOMBRO:
            raise HTTPException(status_code=400, detail=f"Tipo de residuo desconocido: {p.tipoResiduo}")
    else:
        if p.tipoResiduo:
            raise HTTPException(
                status_code=400, detail="Un retiro extra no lleva tipo de residuo."
            )

    # Una coordenada a medias deja un punto que no se puede dibujar ni rutear,
    # sin que nada lo diga. Mismo criterio que en `zones`.
    if (p.lat is None) != (p.lng is None):
        raise HTTPException(status_code=400, detail="La latitud y la longitud van juntas o ninguna")


def _salida(doc: dict) -> PuntoDiarioOut:
    return PuntoDiarioOut(
        id=str(doc["_id"]),
        owner=doc["owner"],
        createdAt=doc["createdAt"],
        clase=doc["clase"],
        fecha=doc["fecha"],
        address=doc.get("address", ""),
        barrio=doc.get("barrio"),
        lat=doc.get("lat"),
        lng=doc.get("lng"),
        telefono=doc.get("telefono"),
        volumenM3=doc.get("volumenM3"),
        tipoResiduo=doc.get("tipoResiduo"),
        solicitud=doc.get("solicitud"),
        solicitante=doc.get("solicitante"),
    )


# =============================================================================
# SOLICITUDES (el vocabulario de la tabla de extras)
# =============================================================================

@router.get("/solicitudes", response_model=list[SolicitudOut])
async def listar_solicitudes(
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    docs = await get_db().solicitudes.find().sort("nombre", 1).to_list(length=None)
    return [
        SolicitudOut(id=str(d["_id"]), nombre=d["nombre"], area=d.get("area", "CONTROL"), base=d.get("base", False))
        for d in docs
    ]


@router.post("/solicitudes", response_model=SolicitudOut)
async def crear_solicitud(
    payload: SolicitudIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    nombre = payload.nombre.strip().upper()
    if not nombre:
        raise HTTPException(status_code=400, detail="El nombre no puede estar vacío")
    # Repetido se rechaza, mismo criterio que las patentes de la flota: con dos
    # filas iguales el desplegable deja de poder identificar cuál se eligió.
    if await get_db().solicitudes.find_one({"nombre": nombre}):
        raise HTTPException(status_code=409, detail="Ya existe una solicitud con ese nombre")
    res = await get_db().solicitudes.insert_one(
        {"nombre": nombre, "area": payload.area.strip().upper() or "CONTROL", "base": False}
    )
    return SolicitudOut(id=str(res.inserted_id), nombre=nombre, area=payload.area, base=False)


# =============================================================================
# PUNTOS DEL DÍA
# =============================================================================

@router.get("", response_model=list[PuntoDiarioOut])
async def listar(
    fecha: date | None = None,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Los puntos de una fecha. Sin parámetro, los de hoy.

    La vista abre siempre en el día de hoy: un punto diario de la semana pasada
    ya se retiró, y dibujarlo en el mapa de generación de rutas haría que el
    plan incluyera un viaje que no corresponde.
    """
    dia = fecha or datetime.now(timezone.utc).date()
    docs = await get_db().puntos_diarios.find(
        {"fecha": datetime(dia.year, dia.month, dia.day)}
    ).to_list(length=None)
    return [_salida(d) for d in docs]


@router.post("", response_model=PuntoDiarioOut)
async def crear(
    payload: PuntoDiarioIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    _validar(payload)
    doc = payload.model_dump()
    # Mongo no guarda `date`, solo `datetime`. Se normaliza a medianoche para
    # que la consulta por día sea una igualdad y no un rango.
    doc["fecha"] = datetime(payload.fecha.year, payload.fecha.month, payload.fecha.day)
    doc["owner"] = current_user.username
    doc["createdAt"] = datetime.now(timezone.utc)
    res = await get_db().puntos_diarios.insert_one(doc)
    creado = await get_db().puntos_diarios.find_one({"_id": res.inserted_id})
    await auditoria.registrar(
        current_user.username, "crear", "punto-diario", str(res.inserted_id), {"clase": payload.clase}
    )
    return _salida(creado)


@router.put("/{punto_id}", response_model=PuntoDiarioOut)
async def editar(
    punto_id: str,
    payload: PuntoDiarioIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    _validar(payload)
    campos = payload.model_dump()
    campos["fecha"] = datetime(payload.fecha.year, payload.fecha.month, payload.fecha.day)
    doc = await get_db().puntos_diarios.find_one_and_update(
        {"_id": analyses_module._object_id(punto_id)},
        {"$set": campos},
        return_document=ReturnDocument.AFTER,
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Punto no encontrado")
    await auditoria.registrar(current_user.username, "editar", "punto-diario", punto_id, None)
    return _salida(doc)


@router.delete("/{punto_id}")
async def eliminar(
    punto_id: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    doc = await get_db().puntos_diarios.find_one_and_delete(
        {"_id": analyses_module._object_id(punto_id)}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Punto no encontrado")
    await auditoria.registrar(
        current_user.username, "eliminar", "punto-diario", punto_id, {"clase": doc.get("clase")}
    )
    return {"ok": True}
