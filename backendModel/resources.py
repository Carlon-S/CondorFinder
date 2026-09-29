import os
from datetime import datetime, timezone
from typing import Literal

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, model_validator
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

class ResourcePointIn(BaseModel):
    """Un punto de salida: el LUGAR desde el que opera la flota.

    Ya no lleva contadores de maquinaria. HDU6 los tenía (`tolvas`, `trucks`,
    `retroexcavadoras_count`) porque no existía otra forma de declarar de qué
    disponía un patio, pero un contador no tiene patente, no tiene año y sobre
    todo no se puede marcar como "en taller". Los recursos individuales de HDU8
    cubren todo eso con más detalle, así que mantener las dos representaciones
    dejaba dos fuentes de verdad para la misma pregunta y ninguna forma de saber
    cuál manda.

    Los criterios de HDU6 sobre capacidad individual por camión siguen
    cumpliéndose: se declara por unidad, ahora además con patente, marca, modelo,
    año y dotación requerida.

    `personal_count` SÍ se queda, y no es una inconsistencia. Es el único dato de
    HDU6 sin equivalente en la planilla de flota: la planilla trae DOTACIÓN, que
    es lo que un vehículo REQUIERE, no los trabajadores que el punto TIENE. Son
    magnitudes distintas, y cruzarlas es el trabajo de HDU5.1.
    """

    name: str
    address: str = ""
    comuna: str = "Maipú"
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    personal_count: int = Field(default=0, ge=0)
    # HDU5/AC1 — "estado de los puntos de referencia" en la confirmación de
    # generar ruta: cuáles participan. Default True para no requerir que el
    # usuario reactive manualmente cada punto ya creado.
    active: bool = Field(default=True)


class ResourcePointOut(ResourcePointIn):
    id: str
    owner: str
    created_at: datetime
    # Resumen de los recursos de este punto, calculado, nunca almacenado. Es lo
    # que reemplaza a los contadores en las vistas que los mostraban (el panel
    # de resumen y el diálogo de generar ruta): si se guardara, volvería a haber
    # dos fuentes de verdad, que es justamente lo que se acaba de eliminar.
    resource_count: int = 0
    available_count: int = 0
    capacity_m3: float = 0.0


def _to_out(doc: dict, resumen: dict | None = None) -> ResourcePointOut:
    resumen = resumen or {}
    return ResourcePointOut(
        id=str(doc["_id"]),
        owner=doc["owner"],
        created_at=doc["created_at"],
        name=doc["name"],
        address=doc.get("address", ""),
        comuna=doc.get("comuna", "Maipú"),
        lat=doc["lat"],
        lng=doc["lng"],
        personal_count=doc.get("personal_count", 0),
        active=doc.get("active", True),
        resource_count=resumen.get("total", 0),
        available_count=resumen.get("disponibles", 0),
        capacity_m3=resumen.get("capacidad", 0.0),
    )


async def _resumen_por_punto(point_ids: list[str]) -> dict[str, dict]:
    """Cuántos recursos tiene cada punto, cuántos disponibles y cuánta capacidad.

    La capacidad cuenta lo MISMO que cuenta el ruteo: recursos de familia
    "carga", disponibles, con capacidad declarada. Si esta cuenta y la del ruteo
    difirieran, la pantalla diría que un punto tiene 60 m³ y la ruta se armaría
    con otra cifra, que es el tipo de desacuerdo que nadie encuentra hasta que
    una ruta sale imposible sin explicación.
    """
    if not point_ids:
        return {}
    docs = await get_db().resources.find(
        {"pointId": {"$in": point_ids}},
        {"pointId": 1, "tipo": 1, "disponible": 1, "capacidad_m3": 1},
    ).to_list(length=None)

    resumen: dict[str, dict] = {}
    for d in docs:
        r = resumen.setdefault(d["pointId"], {"total": 0, "disponibles": 0, "capacidad": 0.0})
        r["total"] += 1
        if not d.get("disponible", True):
            continue
        r["disponibles"] += 1
        if FAMILIA_POR_TIPO.get(d.get("tipo", "")) != "carga":
            continue
        capacidad = d.get("capacidad_m3")
        if capacidad and capacidad > 0:
            r["capacidad"] += float(capacidad)
    return resumen


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
    resumenes = await _resumen_por_punto([str(d["_id"]) for d in docs])
    return [_to_out(d, resumenes.get(str(d["_id"]))) for d in docs]


@router.get("/points/{point_id}", response_model=ResourcePointOut)
async def get_point(
    point_id: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    doc = await get_db().resource_points.find_one({"_id": _object_id(point_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Punto no encontrado")
    resumenes = await _resumen_por_punto([point_id])
    return _to_out(doc, resumenes.get(point_id))


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
    resumenes = await _resumen_por_punto([point_id])
    return _to_out(result, resumenes.get(point_id))


@router.delete("/points/{point_id}")
async def delete_point(
    point_id: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    result = await get_db().resource_points.delete_one({"_id": _object_id(point_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Punto no encontrado")
    # Los recursos de ese punto se van con él: un vehículo cuyo punto de salida
    # ya no existe no tiene desde dónde salir, y quedaría invisible en todas las
    # vistas, que listan por punto.
    await get_db().resources.delete_many({"pointId": point_id})
    return {"message": "Punto eliminado"}


# =============================================================================
# HDU8 — RECURSOS INDIVIDUALES
#
# HDU6 modela los recursos como CONTADORES dentro del punto (tolvas: [{...}],
# retroexcavadoras_count, ...). Sirvió para declarar de qué dispone un patio,
# pero no alcanza para lo que pide HDU8: cada recurso es una unidad con su
# propia identidad (N° de equipo, patente), sus propios datos según el tipo, y
# su propio interruptor de disponibilidad. Un contador no se puede marcar como
# "en taller".
#
# Por eso los recursos van en su propia colección y no dentro del documento del
# punto: el punto es el LUGAR (dirección, coordenadas, activo) y el recurso es
# la UNIDAD que opera desde ahí, apuntando con pointId. Así una unidad se puede
# listar, editar y dar de baja sin reescribir el punto completo, y mañana se
# puede mover de patio cambiando un campo.
#
# Los contadores de HDU6 NO se eliminan ni se migran a la fuerza: siguen siendo
# el respaldo de los puntos que todavía no tienen recursos cargados (ver
# capacidad_de_carga_por_punto más abajo). Eso deja a HDU6 funcionando tal como
# se entregó y verificó, en vez de romperla para que entre HDU8.
# =============================================================================

# Los nueve tipos son los de la planilla de flota de la municipalidad, sin
# agrupar: es el vocabulario con el que nombran su propia flota. Lo que cambia
# el formulario no es el tipo sino la FAMILIA, y son cuatro, que es lo que hace
# que el AC2 ("el sistema pide los detalles relevantes de ese tipo") sea algo
# real y no una etiqueta.
#
#   carga    -> capacidad de la tolva o caja, en m3. Es la que el ruteo suma.
#   maquina  -> capacidad del balde, en m3. No transporta, carga.
#   arrastre -> se remolca, no lleva capacidad ni dotación propia.
#   apoyo    -> vehículo de supervisión, sin capacidad de carga.
FAMILIA_POR_TIPO: dict[str, str] = {
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

Familia = Literal["carga", "maquina", "arrastre", "apoyo"]


class ResourceIn(BaseModel):
    """Un recurso individual.

    Las capacidades son opcionales a propósito, y esto NO es laxitud: en la
    planilla real solo las seis tolvas declaran capacidad. Los dos AMPLIROLL y
    los dos CAMION 3/4 PLANO no la traen, y tres máquinas no declaran balde. Si
    el modelo las exigiera, cargar los datos reales obligaría a inventar
    números, que es exactamente lo que no se puede hacer con un dato
    operacional. Quedan nulas, se ven nulas en la interfaz, y el ruteo excluye
    con motivo a los vehículos de carga sin capacidad.
    """

    tipo: str
    numero_equipo: str = ""
    patente: str = ""
    marca: str = ""
    modelo: str = ""
    anio: int | None = Field(default=None, ge=1950, le=2100)
    capacidad_m3: float | None = Field(default=None, gt=0)
    capacidad_balde_m3: float | None = Field(default=None, gt=0)
    conductores_requeridos: int = Field(default=0, ge=0)
    peonetas_requeridas: int = Field(default=0, ge=0)
    operadores_requeridos: int = Field(default=0, ge=0)
    observaciones: str = ""
    foto: str | None = None
    # AC4 de HDU8. Default True: un recurso recién registrado está operativo,
    # obligar a activarlo después sería un paso extra sin sentido.
    disponible: bool = True
    # Punto de salida desde el que opera.
    point_id: str

    @model_validator(mode="after")
    def _validar_tipo_y_familia(self):
        if self.tipo not in FAMILIA_POR_TIPO:
            conocidos = ", ".join(sorted(FAMILIA_POR_TIPO))
            raise ValueError(f"Tipo de recurso desconocido: {self.tipo}. Conocidos: {conocidos}")
        familia = FAMILIA_POR_TIPO[self.tipo]
        # Se rechaza el campo que no corresponde a la familia en vez de
        # ignorarlo en silencio: una capacidad de carga guardada en una
        # retroexcavadora la haría aparecer como transporte disponible en el
        # ruteo, y nadie se enteraría hasta ver una ruta imposible.
        if familia != "carga" and self.capacidad_m3 is not None:
            raise ValueError(f"Un recurso de tipo {self.tipo} no lleva capacidad de carga")
        if familia != "maquina" and self.capacidad_balde_m3 is not None:
            raise ValueError(f"Un recurso de tipo {self.tipo} no lleva capacidad de balde")
        if familia == "arrastre" and (
            self.conductores_requeridos or self.peonetas_requeridas or self.operadores_requeridos
        ):
            raise ValueError(f"Un recurso de tipo {self.tipo} se remolca, no lleva dotación propia")
        return self


class ResourceOut(ResourceIn):
    id: str
    owner: str
    created_at: datetime
    # Derivada del tipo, nunca enviada por el cliente: es la que decide qué
    # campos pide el formulario y qué recursos suma el ruteo.
    familia: Familia


def _resource_to_out(doc: dict) -> ResourceOut:
    tipo = doc["tipo"]
    return ResourceOut(
        id=str(doc["_id"]),
        owner=doc["owner"],
        created_at=doc["created_at"],
        tipo=tipo,
        familia=FAMILIA_POR_TIPO.get(tipo, "apoyo"),
        numero_equipo=doc.get("numero_equipo", ""),
        patente=doc.get("patente", ""),
        marca=doc.get("marca", ""),
        modelo=doc.get("modelo", ""),
        anio=doc.get("anio"),
        capacidad_m3=doc.get("capacidad_m3"),
        capacidad_balde_m3=doc.get("capacidad_balde_m3"),
        conductores_requeridos=doc.get("conductores_requeridos", 0),
        peonetas_requeridas=doc.get("peonetas_requeridas", 0),
        operadores_requeridos=doc.get("operadores_requeridos", 0),
        observaciones=doc.get("observaciones", ""),
        foto=doc.get("foto"),
        disponible=doc.get("disponible", True),
        point_id=doc.get("pointId", ""),
    )


class DisponibilidadIn(BaseModel):
    disponible: bool


# Fotos de la flota, versionadas en el repositorio (ver el comentario de
# _copiar_fotos en scripts/parsear_flota.py para por qué acá y no en GCS).
FOTOS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "recursos")


@router.get("/photo/{filename}")
async def get_resource_photo(
    filename: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Sirve la foto de un recurso desde disco.

    Exige sesión como el resto de este router. La cookie viaja igual en un
    `<img src>`: en desarrollo es mismo origen (el proxy de vite) y en
    producción es cross-site pero la cookie va con `samesite=none; secure` y
    `domain=.condorfinder.cl`, así que el navegador la manda.

    El nombre se valida contra la ruta REAL resuelta y no solo buscando "..":
    en Windows y en un enlace simbólico hay más formas de salirse de un
    directorio que esa, y acá el nombre viene de la URL.
    """
    ruta = os.path.realpath(os.path.join(FOTOS_DIR, filename))
    if not ruta.startswith(os.path.realpath(FOTOS_DIR) + os.sep):
        raise HTTPException(status_code=404, detail="Foto no encontrada")
    if not os.path.isfile(ruta):
        raise HTTPException(status_code=404, detail="Foto no encontrada")
    return FileResponse(ruta, media_type="image/jpeg")


@router.get("/types")
async def list_resource_types(
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Tipos de recurso con su familia, para el AC1 y el AC2.

    Los sirve el backend en vez de que el frontend los tenga duplicados: la
    familia es la que decide qué campos pide el formulario, y si las dos partes
    llevaran su propia copia de esa tabla, una validación aceptada en pantalla
    podría ser rechazada por el servidor sin explicación."""
    return [{"tipo": t, "familia": f} for t, f in sorted(FAMILIA_POR_TIPO.items())]


@router.post("/units", response_model=ResourceOut)
async def create_resource(
    resource: ResourceIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    punto = await get_db().resource_points.find_one({"_id": _object_id(resource.point_id)})
    if not punto:
        raise HTTPException(status_code=404, detail="El punto de salida no existe")

    doc = resource.model_dump()
    # pointId en camelCase, igual que en analyses.py: es una referencia entre
    # documentos, no un campo de dominio del recurso.
    doc["pointId"] = doc.pop("point_id")
    doc["owner"] = current_user.username
    doc["created_at"] = datetime.now(timezone.utc)
    result = await get_db().resources.insert_one(doc)
    doc["_id"] = result.inserted_id
    return _resource_to_out(doc)


@router.get("/units", response_model=list[ResourceOut])
async def list_resources(
    pointId: str | None = None,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    filtro = {"pointId": pointId} if pointId else {}
    docs = await get_db().resources.find(filtro).to_list(length=None)
    return [_resource_to_out(d) for d in docs]


@router.put("/units/{resource_id}", response_model=ResourceOut)
async def update_resource(
    resource_id: str,
    resource: ResourceIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """AC3 de HDU8: editar un recurso ya registrado."""
    doc = resource.model_dump()
    doc["pointId"] = doc.pop("point_id")
    actualizado = await get_db().resources.find_one_and_update(
        {"_id": _object_id(resource_id)},
        {"$set": doc},
        return_document=ReturnDocument.AFTER,
    )
    if not actualizado:
        raise HTTPException(status_code=404, detail="Recurso no encontrado")
    return _resource_to_out(actualizado)


@router.patch("/units/{resource_id}/disponibilidad", response_model=ResourceOut)
async def set_disponibilidad(
    resource_id: str,
    payload: DisponibilidadIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """AC4 de HDU8: alternar disponible / no disponible.

    Endpoint propio y no un PUT completo: cambiar la disponibilidad es la acción
    más frecuente de esta vista (un camión entra y sale de taller), y hacerla
    con un PUT obligaría al cliente a reenviar el recurso entero, con el riesgo
    de pisar un campo que alguien más editó en el intervalo."""
    actualizado = await get_db().resources.find_one_and_update(
        {"_id": _object_id(resource_id)},
        {"$set": {"disponible": payload.disponible}},
        return_document=ReturnDocument.AFTER,
    )
    if not actualizado:
        raise HTTPException(status_code=404, detail="Recurso no encontrado")
    return _resource_to_out(actualizado)


@router.delete("/units/{resource_id}")
async def delete_resource(
    resource_id: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    result = await get_db().resources.delete_one({"_id": _object_id(resource_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Recurso no encontrado")
    return {"message": "Recurso eliminado"}


async def capacidad_de_carga_por_punto(point_ids: list[str]) -> dict[str, list[float]]:
    """Capacidades de carga DISPONIBLES, solo de los puntos que tienen recursos.

    Por cada punto que tenga al menos un recurso cargado, devuelve la lista de
    capacidades en m3 de sus recursos de familia "carga" que están disponibles y
    que declaran capacidad. Es una lista y no un total porque routing.py necesita
    las unidades por separado para saber cuántos camiones hacen falta, no solo
    cuánto cabe.

    Un punto sin nada que aportar simplemente no aparece en el resultado, y
    routing.py lo lee como lista vacía. Ya no hace falta distinguir "sin
    recursos" de "sin capacidad disponible": el punto dejó de guardar contadores
    de maquinaria, así que no hay a qué caer de respaldo y los dos casos
    significan lo mismo, capacidad cero.

    Tres exclusiones, cada una por su motivo:

      - `disponible: False`, que es literalmente el AC5. Este es el único lugar
        del sistema donde ese interruptor cambia un resultado, así que si esta
        función no filtrara, el criterio no tendría cómo verificarse.
      - familia distinta de "carga": una retroexcavadora no transporta.
      - capacidad nula: cuatro vehículos de carga de la flota real no la
        declaran. Sumarlos como 0 sería inofensivo, pero contarlos como camiones
        disponibles haría que el ruteo despachara un vehículo que no puede
        llevar nada.
    """
    if not point_ids:
        return {}

    docs = await get_db().resources.find(
        {"pointId": {"$in": point_ids}},
        {"pointId": 1, "tipo": 1, "disponible": 1, "capacidad_m3": 1},
    ).to_list(length=None)

    por_punto: dict[str, list[float]] = {}
    for d in docs:
        capacidades = por_punto.setdefault(d["pointId"], [])
        if not d.get("disponible", True):
            continue
        if FAMILIA_POR_TIPO.get(d.get("tipo", "")) != "carga":
            continue
        capacidad = d.get("capacidad_m3")
        if not capacidad or capacidad <= 0:
            continue
        capacidades.append(float(capacidad))
    return por_punto
