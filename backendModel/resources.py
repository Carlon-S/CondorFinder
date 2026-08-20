from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from pymongo import ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase

import auth as auth_module

# =============================================================================
# CONDORFINDER — RECURSOS DISPONIBLES (HDU6)
# Archivo: backendModel/resources.py
#
# Puntos (depósitos/patios desde donde salen camiones y
# maquinaria) con los recursos asociados a cada uno. Mismo patrón que
# auth.py: get_db()/set_db() inyectado desde el lifespan de orquestador.py,
# un router protegido con la misma dependency de sesión (get_current_user)
# que ya usa el resto del backend.
#
# Modelo grounded en el texto de los AC de HDU6: AC8 pide capacidad de
# carga POR CAMIÓN individual (de ahí trucks: list[TruckIn], no un
# agregado) — tolvas usa el mismo modelo de lista por el mismo motivo (no
# todas las tolvas de un punto tienen por qué tener la misma capacidad).
# AC9 solo pide cantidad de personal. Retroexcavadoras no tiene un AC
# propio con ese nivel de detalle, así que queda como cantidad simple.
# =============================================================================

_db: AsyncDatabase | None = None


def set_db(db: AsyncDatabase) -> None:
    global _db
    _db = db


def get_db() -> AsyncDatabase:
    if _db is None:
        raise RuntimeError("La base de datos no fue inicializada — set_db() debe llamarse en el lifespan.")
    return _db


# =============================================================================
# MODELOS
# =============================================================================

class TruckIn(BaseModel):
    capacity_m3: float = Field(gt=0)


# Mismo shape que TruckIn — se mantiene como modelo aparte (no reusar
# TruckIn para tolvas) porque son conceptos de dominio distintos que
# podrían divergir más adelante.
class TolvaIn(BaseModel):
    capacity_m3: float = Field(gt=0)


class ResourcePointIn(BaseModel):
    name: str
    address: str = ""
    comuna: str = "Maipú"
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    tolvas: list[TolvaIn] = []
    retroexcavadoras_count: int = Field(default=0, ge=0)
    trucks: list[TruckIn] = []
    personal_count: int = Field(default=0, ge=0)
    # HDU5/AC1 — "estado de los puntos de referencia" en la confirmación de
    # generar ruta: cuáles participan. Default True para no requerir que el
    # usuario reactive manualmente cada punto ya creado.
    active: bool = Field(default=True)


class ResourcePointOut(ResourcePointIn):
    id: str
    owner: str
    created_at: datetime


def _to_out(doc: dict) -> ResourcePointOut:
    # .get(..., default) en los campos nuevos (tolvas/address/comuna): los
    # puntos creados antes de este cambio no los tienen en Mongo — con el
    # default no rompen, solo se ven con 0 tolvas y dirección vacía.
    return ResourcePointOut(
        id=str(doc["_id"]),
        owner=doc["owner"],
        created_at=doc["created_at"],
        name=doc["name"],
        address=doc.get("address", ""),
        comuna=doc.get("comuna", "Maipú"),
        lat=doc["lat"],
        lng=doc["lng"],
        tolvas=[TolvaIn(**t) for t in doc.get("tolvas", [])],
        retroexcavadoras_count=doc.get("retroexcavadoras_count", 0),
        trucks=[TruckIn(**t) for t in doc.get("trucks", [])],
        personal_count=doc.get("personal_count", 0),
        active=doc.get("active", True),
    )


def _object_id(point_id: str) -> ObjectId:
    try:
        return ObjectId(point_id)
    except InvalidId:
        raise HTTPException(status_code=404, detail="Punto no encontrado")


# =============================================================================
# ENDPOINTS
# =============================================================================

router = APIRouter(prefix="/resources", tags=["resources"])


@router.post("/points", response_model=ResourcePointOut)
async def create_point(
    point: ResourcePointIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    doc = {
        **point.model_dump(),
        "owner": current_user.username,
        "created_at": datetime.now(timezone.utc),
    }
    result = await get_db().resource_points.insert_one(doc)
    doc["_id"] = result.inserted_id
    return _to_out(doc)


@router.get("/points", response_model=list[ResourcePointOut])
async def list_points(
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    docs = await get_db().resource_points.find().to_list(length=None)
    return [_to_out(d) for d in docs]


@router.get("/points/{point_id}", response_model=ResourcePointOut)
async def get_point(
    point_id: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    doc = await get_db().resource_points.find_one({"_id": _object_id(point_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Punto no encontrado")
    return _to_out(doc)


@router.put("/points/{point_id}", response_model=ResourcePointOut)
async def update_point(
    point_id: str,
    point: ResourcePointIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    oid = _object_id(point_id)
    result = await get_db().resource_points.find_one_and_update(
        {"_id": oid},
        {"$set": point.model_dump()},
        return_document=ReturnDocument.AFTER,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Punto no encontrado")
    return _to_out(result)


@router.delete("/points/{point_id}")
async def delete_point(
    point_id: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    result = await get_db().resource_points.delete_one({"_id": _object_id(point_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Punto no encontrado")
    return {"message": "Punto eliminado"}
