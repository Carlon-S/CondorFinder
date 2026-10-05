import asyncio
import io
import os
import uuid
from datetime import datetime, timezone
from typing import Literal

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, model_validator
from pymongo import ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase

import auth as auth_module
import google_places
import street_view

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
    # Nombre del archivo de la foto de Street View, servible por
    # GET /resources/photo/{filename}. None cuando no hay cobertura en esa
    # coordenada, cuando no hay clave configurada, o en los puntos creados antes
    # de que esto existiera: en los tres casos la vista cae al marcador
    # genérico, que es lo que mostraba siempre.
    street_view: str | None = None


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
        street_view=doc.get("street_view"),
    )


# Fotos de la flota, versionadas en el repositorio (ver el comentario de
# _copiar_fotos en scripts/parsear_flota.py para por qué acá y no en GCS), y
# también las de Street View de cada punto. Se define acá arriba, antes de los
# ayudantes que la usan, aunque el endpoint que la sirve esté más abajo.
FOTOS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "recursos")


def _guardar_street_view(lat: float, lng: float) -> str | None:
    """Pide la foto de Street View del lugar y la deja en disco. Devuelve el
    nombre del archivo, o None si no se pudo.

    Sincrónica porque los dos pasos son HTTP; el llamador la corre en un hilo
    para no bloquear el event loop de FastAPI, igual que osrm_client."""
    contenido = street_view.foto_de(lat, lng)
    if not contenido:
        return None
    nombre = f"sv_{uuid.uuid4().hex}.jpg"
    os.makedirs(FOTOS_DIR, exist_ok=True)
    try:
        with open(os.path.join(FOTOS_DIR, nombre), "wb") as f:
            f.write(contenido)
    except OSError:
        return None
    return nombre


def _borrar_foto(nombre: str | None) -> None:
    """Borra una foto de disco sin que su ausencia importe. Se usa cuando un
    punto se mueve y su foto anterior ya no corresponde al lugar: sin esto
    quedarían acumulándose fotos de direcciones viejas que nada referencia."""
    if not nombre:
        return
    ruta = os.path.realpath(os.path.join(FOTOS_DIR, nombre))
    if not ruta.startswith(os.path.realpath(FOTOS_DIR) + os.sep):
        return
    try:
        os.remove(ruta)
    except OSError:
        pass


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
        # Una sola solicitud a Google, acá, y nunca más: la foto queda en disco
        # y la lista la sirve desde ahí. En un hilo para no bloquear el event
        # loop, igual que las llamadas a OSRM.
        "street_view": await asyncio.to_thread(_guardar_street_view, point.lat, point.lng),
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
    previo = await get_db().resource_points.find_one({"_id": oid})
    if not previo:
        raise HTTPException(status_code=404, detail="Punto no encontrado")

    cambios = point.model_dump()

    # La foto solo se vuelve a pedir si el punto se MOVIÓ. Renombrarlo o
    # desactivarlo no cambia el lugar, y pedirla en cada guardado convertiría
    # "una solicitud por punto" en "una por edición", que es justo lo que este
    # diseño evita. El umbral son ~1,1 m, la precisión a la que Street View
    # devuelve la misma panorámica de todos modos.
    se_movio = (
        abs(previo.get("lat", 0) - point.lat) > 1e-5
        or abs(previo.get("lng", 0) - point.lng) > 1e-5
    )
    if se_movio:
        cambios["street_view"] = await asyncio.to_thread(
            _guardar_street_view, point.lat, point.lng
        )
    else:
        # model_dump() no trae street_view (no está en ResourcePointIn), así que
        # sin esto el $set lo dejaría intacto igual; se conserva explícito para
        # que no dependa de qué campos tenga el modelo de entrada.
        cambios["street_view"] = previo.get("street_view")

    result = await get_db().resource_points.find_one_and_update(
        {"_id": oid},
        {"$set": cambios},
        return_document=ReturnDocument.AFTER,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Punto no encontrado")

    # Recién cuando la escritura salió bien: si se borrara antes y el update
    # fallara, el punto quedaría apuntando a un archivo que ya no existe.
    if se_movio and previo.get("street_view") != cambios["street_view"]:
        _borrar_foto(previo.get("street_view"))
    resumenes = await _resumen_por_punto([point_id])
    return _to_out(result, resumenes.get(point_id))


@router.delete("/points/{point_id}")
async def delete_point(
    point_id: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    oid = _object_id(point_id)
    previo = await get_db().resource_points.find_one({"_id": oid})
    result = await get_db().resource_points.delete_one({"_id": oid})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Punto no encontrado")
    # La foto se va con el punto: nada más la referencia, y quedaría ocupando
    # disco sin forma de saber de qué lugar era.
    if previo:
        _borrar_foto(previo.get("street_view"))
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


# =============================================================================
# COMPATIBILIDAD VEHÍCULO ↔ TIPO DE RESIDUO (AC4 de HDU5.1)
#
# Derivada del TIPO, igual que FAMILIA_POR_TIPO y por la misma razón: no es un
# atributo que alguien declare por unidad, es una propiedad de la clase de
# vehículo. Guardarla por recurso daría dos fuentes de verdad.
#
# Las tres reglas son citas de la Municipalidad de Maipú, no deducciones:
#
#   - CAMION 3/4 PLANO: "este vehículo no tiene fines de retiro de escombros,
#     sino más bien de reciclaje (cajas y embalajes, colchones), por lo que no
#     sería prudente incorporarlo a las rutas que estamos trabajando"
#     (02-10-2026). Es una exclusión TOTAL de este tipo de ruta, no por clase.
#
#   - AMPLIROLL: "no debe llevar material muy pesado por la maniobra de
#     descarga", con el límite en 15 toneladas. Eso NO vive acá: vive en
#     `capacidad_ton` de cada unidad, porque es una cifra por vehículo.
#
#   - AMPLIROLL: lleva "preferentemente" voluminoso antes que escombros. Es una
#     PREFERENCIA y no una prohibición, y el criterio usa esa misma distinción:
#     "priorizará la coincidencia de tipo, y solo usará un vehículo no
#     compatible si no existe ninguna alternativa compatible".
# =============================================================================

# Tipos que no participan de una ruta de microbasural, cualquiera sea el
# residuo. Se evalúa aparte de la capacidad: hoy estos dos quedan fuera igual
# porque declaran su límite en toneladas y el reparto es por m3, pero eso es una
# coincidencia, no la regla. Si mañana declararan m3, seguirían fuera.
TIPOS_FUERA_DE_MICROBASURAL: frozenset[str] = frozenset({"CAMION 3/4 PLANO"})

# Qué clases del detector prefiere cada tipo. Ausente = sin preferencia, le da
# igual. Las clases son las que produce el modelo (ver WASTE_CLASSES en
# planificacion.rutas.tsx); si el modelo aprende una clase nueva, acá
# simplemente no tiene preferencia, que es el comportamiento correcto.
PREFERENCIA_POR_TIPO: dict[str, frozenset[str]] = {
    "AMPLIROLL": frozenset({"Muebles", "Neumáticos"}),
}


def tipo_participa_en_microbasural(tipo: str) -> bool:
    """Si un tipo de vehículo puede integrar una ruta de retiro de microbasural."""
    return tipo not in TIPOS_FUERA_DE_MICROBASURAL


def tipo_prefiere_clase(tipo: str, clase: str | None) -> bool:
    """Si este tipo de vehículo es el preferido para esa clase de residuo.

    Sin preferencia declarada devuelve True: un vehículo que no discrimina es
    compatible con todo, y tratarlo como incompatible lo mandaría a la segunda
    vuelta de la selección sin motivo."""
    preferidas = PREFERENCIA_POR_TIPO.get(tipo)
    if preferidas is None or clase is None:
        return True
    return clase in preferidas


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
    # Límite de PESO, al lado del de volumen. Un camión tiene los dos y el
    # sistema solo modelaba el primero, así que no había dónde guardar las dos
    # cifras que la municipalidad entregó en toneladas: el CAMION 3/4 PLANO
    # (1 t) y el AMPLIROLL (15 t, por la maniobra de descarga). Un ortomosaico
    # ya produce `weight_kg` por detección, así que el peso de una zona es un
    # dato que el sistema tiene y hasta ahora no podía contrastar con nada.
    capacidad_ton: float | None = Field(default=None, gt=0)
    # AC3 de HDU5.1: kilómetros que el vehículo recorre antes de necesitar
    # recarga. Solo familia "carga": lo que no circula por sí solo no tiene
    # autonomía propia, y una máquina no recorre una ruta.
    #
    # **La municipalidad respondió que ese límite NO existe en su flota**, así
    # que en producción este campo queda vacío y el criterio no corta nada. Es
    # un resultado válido y hay que documentarlo, no esconderlo: el criterio
    # está implementado y es demostrable declarando una autonomía baja.
    autonomia_km: float | None = Field(default=None, gt=0)
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
        #
        # El arrastre SÍ puede declararla, y no es una excepción al criterio
        # anterior: es que la regla confundía dos cosas distintas. La familia
        # dice cómo se MUEVE una unidad, no si CARGA. Un carro de reciclaje
        # lleva 30 m3 (confirmado por la municipalidad) y necesita que alguien
        # lo tire; las dos cosas son ciertas a la vez.
        #
        # Que la declare no lo mete en ninguna ruta: capacidad_de_carga_por_punto()
        # filtra por familia "carga", y un carro sigue siendo "arrastre". El
        # riesgo que motivó esta validación, una unidad que aparece como
        # transporte disponible sin serlo, sigue cubierto por ese filtro.
        if familia not in ("carga", "arrastre") and self.capacidad_m3 is not None:
            raise ValueError(f"Un recurso de tipo {self.tipo} no lleva capacidad de carga")
        # El peso sigue exactamente la misma regla que el volumen: lo declara
        # lo que carga, se mueva solo o lo remolquen.
        if familia not in ("carga", "arrastre") and self.capacidad_ton is not None:
            raise ValueError(f"Un recurso de tipo {self.tipo} no lleva capacidad en toneladas")
        # La autonomía es más estricta que las capacidades: solo "carga". Un
        # carro remolcado no gasta combustible propio.
        if familia != "carga" and self.autonomia_km is not None:
            raise ValueError(f"Un recurso de tipo {self.tipo} no tiene autonomía propia")
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
        capacidad_ton=doc.get("capacidad_ton"),
        autonomia_km=doc.get("autonomia_km"),
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


@router.post("/photo")
async def upload_resource_photo(
    file: UploadFile = File(...),
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Sube la foto de un recurso y devuelve el nombre con el que quedó guardada.

    La imagen se RE-CODIFICA con Pillow en vez de guardarse tal cual, y eso hace
    tres cosas de una: valida que sea realmente una imagen (un archivo que solo
    dice ser JPEG falla al abrirse), descarta cualquier contenido que viniera
    incrustado fuera del ráster, y la deja al mismo tamaño que las 13 de la
    flota municipal, que el parser ya reduce a 900px. Sin eso, una foto de
    teléfono de 8 MB entraría entera para verse en una ficha de 20rem.

    El nombre lo genera el servidor, nunca el cliente: con el nombre original se
    podría sobrescribir la foto de otro recurso, o escribir fuera del
    directorio.

    Las fotos viven en disco y no en GCS. GCS existe en este proyecto para lo
    que tiene que sobrevivir a una corrida del pipeline; una foto de vehículo es
    dato de referencia y el directorio está montado desde el host (ver
    docker-compose.yml), así que sobrevive a los redespliegues igual.
    """
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="El archivo no es una imagen")

    crudo = await file.read()
    # 10 MB antes de procesar: por encima de eso no es una foto de un camión,
    # y decodificarla costaría memoria del servidor sin ningún beneficio.
    if len(crudo) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="La imagen supera los 10 MB")

    try:
        from PIL import Image

        imagen = Image.open(io.BytesIO(crudo))
        imagen.verify()               # detecta archivos corruptos o que no son imagen
        imagen = Image.open(io.BytesIO(crudo))  # verify() deja el archivo consumido
        imagen = imagen.convert("RGB")
        imagen.thumbnail((900, 900), Image.LANCZOS)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="No se pudo leer la imagen")

    os.makedirs(FOTOS_DIR, exist_ok=True)
    nombre = f"{uuid.uuid4().hex}.jpg"
    imagen.save(os.path.join(FOTOS_DIR, nombre), "JPEG", quality=82, optimize=True)
    return {"foto": nombre}


@router.delete("/photo/{filename}")
async def delete_resource_photo(
    filename: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Borra una foto subida.

    Solo borra las que subió la interfaz, que son las de nombre generado (32
    caracteres hexadecimales y extensión .jpg). Las 13 de la flota municipal
    vienen del repositorio: borrarlas dejaría el directorio distinto de lo que
    dice git y volverían en el próximo despliegue, así que la operación no
    tendría el efecto que aparenta.
    """
    base, ext = os.path.splitext(filename)
    if ext.lower() != ".jpg" or len(base) != 32 or not all(c in "0123456789abcdef" for c in base):
        raise HTTPException(
            status_code=400,
            detail="Solo se pueden borrar fotos subidas desde el sistema",
        )
    ruta = os.path.realpath(os.path.join(FOTOS_DIR, filename))
    if not ruta.startswith(os.path.realpath(FOTOS_DIR) + os.sep):
        raise HTTPException(status_code=404, detail="Foto no encontrada")
    if os.path.isfile(ruta):
        os.remove(ruta)
    return {"message": "Foto eliminada"}


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


# =============================================================================
# DIRECCIONES (Places + Geocoding de Google, con respaldo en Nominatim)
#
# Tres endpoints que son un PROXY fino sobre google_places.py. Existen para que
# la clave se quede en la VM en vez de viajar al navegador: podrían llamarse
# directo desde el cliente, pero entonces haría falta una segunda clave
# restringida por referente, que es falsificable. Crear un punto de recurso se
# hace un puñado de veces en la vida del sistema, así que el salto extra no le
# cuesta nada a nadie.
#
# Los tres devuelven `null` cuando no hay clave o Google no responde, y
# `src/lib/geocoding.ts` se queda con Nominatim. Nunca propagan un error: una
# sugerencia de dirección es una cortesía, no un requisito para guardar.
# =============================================================================


@router.get("/direcciones/sugerencias")
async def sugerir_direcciones(
    q: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Sugerencias mientras se escribe. Una solicitud POR LLAMADA, así que el
    antirrebote del cliente es lo que mantiene el consumo bajo."""
    return await asyncio.to_thread(google_places.autocompletar, q) or []


@router.get("/direcciones/detalle")
async def detalle_direccion(
    placeId: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """La dirección elegida de la lista: calle con número, comuna y coordenada.
    Es lo que llena el formulario y mueve el marcador de una sola vez."""
    return await asyncio.to_thread(google_places.detalle, placeId)


@router.get("/direcciones/inversa")
async def direccion_inversa(
    lat: float,
    lng: float,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Qué dirección hay en esa coordenada. Se dispara al clickear el mapa."""
    return await asyncio.to_thread(google_places.direccion_de, lat, lng)


@router.get("/direcciones/coordenada")
async def coordenada_direccion(
    q: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Dónde queda una dirección escrita a mano, sin pasar por las sugerencias."""
    return await asyncio.to_thread(google_places.coordenada_de, q)


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


# =============================================================================
# PERSONAL (AC1 y AC2 de HDU5.1)
#
# La cuadrilla de un punto. Vive en la base y no en el navegador: empezó en
# localStorage para no almacenar datos personales, y se movió acá a pedido del
# equipo, porque una lista que no se comparte entre equipos ni sobrevive a un
# cambio de navegador obliga a reescribirla en cada máquina.
#
# **Son datos personales** (Ley 19.628) y conviene tenerlo presente: los escribe
# el municipio sobre su propia gente, no se los pedimos a nadie, y no salen de su
# instalación. El sistema no los usa para otra cosa que armar el plan del día.
#
# Colgados de un punto, igual que los vehículos: si mañana hay dos patios, cada
# uno tiene su cuadrilla. El ruteo los junta todos porque las sub-rutas de puntos
# distintos salen a la vez, pero eso es decisión del plan y no del registro.
# =============================================================================

Rol = Literal["conductor", "peoneta", "operador"]


class WorkerIn(BaseModel):
    # Sin mínimo: la fila se crea vacía y el trabajador la llena escribiendo,
    # así que el nombre en blanco es un estado INTERMEDIO legítimo y no un dato
    # inválido. Exigir un carácter hacía fallar el alta antes de que hubiera
    # nada que escribir.
    #
    # Una persona sin nombre no entra al plan: la vista la excluye de la
    # cuadrilla del día (filtra por `nombre.trim()`) y la marca como incompleta,
    # mismo criterio que un recurso que se guarda sin capacidad declarada.
    nombre: str = Field(default="", max_length=120)
    rol: Rol
    # Si entra en el plan del día. Es el equivalente del interruptor de los
    # vehículos, y es lo que cubre "se flexibiliza por inasistencias": quien
    # falta hoy vuelve mañana, y borrarlo convertiría una ausencia en una baja.
    disponible: bool = True
    point_id: str


class WorkerOut(WorkerIn):
    id: str
    owner: str
    created_at: datetime


def _worker_to_out(doc: dict) -> WorkerOut:
    return WorkerOut(
        id=str(doc["_id"]),
        owner=doc["owner"],
        created_at=doc["created_at"],
        nombre=doc.get("nombre", ""),
        rol=doc.get("rol", "peoneta"),
        disponible=doc.get("disponible", True),
        point_id=doc.get("pointId", ""),
    )


@router.get("/workers", response_model=list[WorkerOut])
async def list_workers(
    point_id: str | None = None,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    filtro = {"pointId": point_id} if point_id else {}
    docs = await get_db().perfiles.find(filtro).sort("nombre", 1).to_list(length=None)
    return [_worker_to_out(d) for d in docs]


@router.post("/workers", response_model=WorkerOut, status_code=201)
async def create_worker(
    payload: WorkerIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    doc = {
        **payload.model_dump(exclude={"point_id"}),
        "pointId": payload.point_id,
        "owner": current_user.username,
        "created_at": datetime.now(timezone.utc),
    }
    doc["_id"] = (await get_db().perfiles.insert_one(doc)).inserted_id
    return _worker_to_out(doc)


@router.put("/workers/{worker_id}", response_model=WorkerOut)
async def update_worker(
    worker_id: str,
    payload: WorkerIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    actualizado = await get_db().perfiles.find_one_and_update(
        {"_id": _object_id(worker_id)},
        {"$set": {**payload.model_dump(exclude={"point_id"}), "pointId": payload.point_id}},
        return_document=ReturnDocument.AFTER,
    )
    if not actualizado:
        raise HTTPException(status_code=404, detail="Persona no encontrada")
    return _worker_to_out(actualizado)


@router.delete("/workers/{worker_id}")
async def delete_worker(
    worker_id: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    r = await get_db().perfiles.delete_one({"_id": _object_id(worker_id)})
    if r.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Persona no encontrada")
    return {"ok": True}


@router.patch("/points/{point_id}/disponibilidad", response_model=list[ResourceOut])
async def set_disponibilidad_del_punto(
    point_id: str,
    payload: DisponibilidadIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Pone TODAS las unidades de un punto en el mismo estado, de una vez.

    No es solo comodidad: la municipalidad trabaja por jornada y hay días en que
    el patio entero sale o no sale, y hacerlo de a una en 21 filas es donde se
    cuelan los olvidos.

    Existe como endpoint y no como un bucle en el cliente porque 21 PATCH en
    serie se sentían lentos de verdad, y en paralelo son 21 peticiones
    compitiendo contra la misma colección, con el punto devolviendo una capacidad
    calculada a mitad de camino. Un `update_many` es una sola escritura.

    Devuelve los recursos del punto ya actualizados, así el cliente reemplaza su
    lista sin volver a pedirla."""
    await get_db().resources.update_many(
        {"pointId": point_id},
        {"$set": {"disponible": payload.disponible}},
    )
    docs = await get_db().resources.find({"pointId": point_id}).to_list(length=None)
    return [_resource_to_out(d) for d in docs]


@router.delete("/units/{resource_id}")
async def delete_resource(
    resource_id: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    result = await get_db().resources.delete_one({"_id": _object_id(resource_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Recurso no encontrado")
    return {"message": "Recurso eliminado"}


async def capacidad_de_carga_por_punto(point_ids: list[str]) -> dict[str, list[dict]]:
    """Los vehículos de transporte DISPONIBLES de cada punto, con su identidad.

    Por cada punto que tenga al menos un recurso cargado, devuelve la lista de
    sus recursos de familia "carga" que están disponibles y que declaran
    capacidad. Es una lista y no un total porque routing.py necesita las
    unidades por separado para saber cuántos camiones hacen falta, no solo
    cuánto cabe.

    Devuelve el VEHÍCULO y no solo su capacidad, que es lo que permite el AC7 de
    HDU5.1 ("cada tramo del plan muestra qué vehículo lo recorre, por patente y
    tipo, y su personal asociado"). Antes devolvía `list[float]`: el ruteo sabía
    perfectamente cuáles camiones elegía y tiraba esa información al retornar,
    así que el plan podía decir "2 camiones" y jamás cuáles. La dotación viaja en
    el mismo documento, así que el personal asociado sale gratis con el cambio.

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
        {
            "pointId": 1,
            "tipo": 1,
            "disponible": 1,
            "capacidad_m3": 1,
            "capacidad_ton": 1,
            "autonomia_km": 1,
            "numero_equipo": 1,
            "patente": 1,
            "conductores_requeridos": 1,
            "peonetas_requeridas": 1,
            "operadores_requeridos": 1,
            "foto": 1,
        },
    ).to_list(length=None)

    por_punto: dict[str, list[dict]] = {}
    for d in docs:
        unidades = por_punto.setdefault(d["pointId"], [])
        if not d.get("disponible", True):
            continue
        if FAMILIA_POR_TIPO.get(d.get("tipo", "")) != "carga":
            continue
        capacidad = d.get("capacidad_m3")
        if not capacidad or capacidad <= 0:
            continue
        unidades.append({
            # La clave se llama capacity_m3 y no capacidad_m3 a propósito: es la
            # forma que routing.py ya lee en su lista `trucks`, y cambiar la
            # FUENTE del dato sin cambiar su forma deja intacto el algoritmo de
            # ruteo, que es de otro integrante del equipo.
            "capacity_m3": float(capacidad),
            # Viaja aunque hoy el ruteo no lo use: es el límite que el AC4 de
            # HDU5.1 va a contrastar contra el peso de la zona.
            "capacity_ton": d.get("capacidad_ton"),
            # AC3: el ruteo descarta los órdenes de visita que superen este
            # rango. None significa sin límite declarado, que es el caso de
            # toda la flota real.
            "autonomia_km": d.get("autonomia_km"),
            "resourceId": str(d["_id"]),
            "numeroEquipo": d.get("numero_equipo", ""),
            "patente": d.get("patente", ""),
            "tipo": d.get("tipo", ""),
            "conductores": d.get("conductores_requeridos", 0),
            "peonetas": d.get("peonetas_requeridas", 0),
            "operadores": d.get("operadores_requeridos", 0),
            # Para que el plan pueda mostrar la foto del vehículo asignado. Un
            # trabajador reconoce "el ampliroll amarillo" antes que "KBVZ-41",
            # y la patente sola no sirve para identificarlo en el patio. Viaja
            # el nombre del archivo, no la URL: la sirve
            # GET /resources/photo/{filename} y el frontend la arma, igual que
            # ya hace en la lista de recursos. 8 de las 21 unidades no tienen
            # foto, así que esto es None a menudo y la vista lo contempla.
            "foto": d.get("foto"),
        })
    return por_punto
