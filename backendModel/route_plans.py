"""
CONDORFINDER, PLANES DE RUTA GUARDADOS (C5 y C6 de HDU5.2)
Archivo: backendModel/route_plans.py

Los recorridos que el sistema genera, persistidos. Es la bisagra de los dos
criterios que quedaban: C5 habla de *"un listado de rutas generadas"* y C6 de
*"los registros de rutas anteriores"*, y hasta acá no existía ninguno de los
dos. `POST /routes/generate` calculaba, devolvía y se olvidaba: el plan vivía en
el estado de React y se perdía con un F5.

-------------------------------------------------------------------------------
SE GUARDA AL GENERAR, NO AL DESPACHAR
-------------------------------------------------------------------------------
C6 dice textualmente "todas rutas **generadas** anteriormente", y generadas no
es despachadas. La objeción obvia es que el historial se llena de planes de
prueba; la respuesta no es guardar menos sino que el `estado` distinga una cosa
de la otra y el historial pueda filtrar. Guardar solo lo despachado perdería
justo el caso que el trabajador va a querer revisar: el plan que generó ayer y
decidió no hacer.

-------------------------------------------------------------------------------
SE GUARDA LA RESPUESTA TAL CUAL, Y ESO NO ES PEREZA
-------------------------------------------------------------------------------
El documento lleva el `RoutePlanRouteOut` completo en `plan`, con la misma forma
que el frontend ya sabe dibujar. Reabrir un plan del historial es entonces
pasarle ese objeto a los mismos componentes, sin una capa de traducción que
podría quedar desincronizada del contrato. Una forma propia obligaría a mantener
dos versiones del mismo dato y a migrarlas juntas cada vez que el plan cambie.

Al lado va `peticion`, el cuerpo con que se generó. **Es lo que vuelve posible
C5**: editar una ruta es volver al diálogo de generación con sus valores y
regenerar, así que hay que saber con qué se pidió.

Y va `resumen`, duplicando un puñado de cifras que también están en `plan`. Es
la única desnormalización del módulo y tiene un motivo medible: ver abajo.

-------------------------------------------------------------------------------
LOS DATOS SE COPIAN, NO SE REFERENCIAN
-------------------------------------------------------------------------------
El nombre del punto de origen, los de las zonas, las patentes y las capacidades
quedan congelados como estaban al generar, porque ya vienen así dentro de
`plan`. Un registro histórico que cambia porque alguien renombró una zona o
cambió un camión deja de ser un registro. Es la misma razón por la que
`algorithmVersion` sella cada análisis en `analyses.py`.

-------------------------------------------------------------------------------
LA GEOMETRÍA SE GUARDA, Y EL LISTADO NO LA LEE
-------------------------------------------------------------------------------
Las polilíneas van dentro de `plan`, así que el historial puede redibujar el
trazo. **No cuestan ni una llamada más**: ya están calculadas cuando este módulo
escribe, y volver a pedirlas al abrir un plan sí costaría (con Google, dinero).

Lo que sí costaría es leerlas sin necesidad: un recorrido urbano de 60 km son
unos miles de vértices, o sea del orden de 100 KB por plan, y un listado de
cincuenta planes serían varios MB por cada apertura del historial para mostrar
una tabla de fechas. Por eso **el listado proyecta `plan` fuera** y solo
`GET /route-plans/{id}` lo devuelve. `resumen` existe exactamente para eso: que
la tabla tenga sus cifras sin tocar el documento grande.
"""

from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from pymongo.asynchronous.database import AsyncDatabase

import auditoria
import auth as auth_module

_db: AsyncDatabase | None = None


def set_db(db: AsyncDatabase) -> None:
    global _db
    _db = db


def get_db() -> AsyncDatabase:
    if _db is None:
        raise RuntimeError("route_plans.set_db() no fue llamado")
    return _db


async def create_index() -> None:
    """Índice por fecha descendente, que es el único orden que el historial pide.

    C6 pide las rutas "ordenadas por día", y tanto el listado como la agregación
    de días con datos recorren por ahí. Idempotente, como el resto.
    """
    await get_db().route_plans.create_index([("fecha", -1)])
    # Los retiros se consultan por zona (la línea de tiempo de un lugar) y por
    # fecha (el historial). Compuesto en ese orden porque la zona es el filtro
    # selectivo y la fecha solo ordena dentro de ella.
    await get_db().retiros.create_index([("zoneId", 1), ("fecha", -1)])


router = APIRouter(prefix="/route-plans", tags=["route-plans"])


# =============================================================================
# ESTADOS
# =============================================================================
# El ciclo de vida completo es la pieza 2.1 y todavía no está. Pero el campo
# nace acá y no allá por una razón concreta: agregarlo después obligaría a
# migrar los documentos ya escritos, y C5 lo necesita desde el primer día para
# decidir si una ruta se puede editar.
ESTADO_GENERADA = "generada"
ESTADO_EN_CURSO = "en curso"
ESTADO_TERMINADA = "terminada"
ESTADO_CANCELADA = "cancelada"

ESTADOS = (ESTADO_GENERADA, ESTADO_EN_CURSO, ESTADO_TERMINADA, ESTADO_CANCELADA)

#: Los estados en que una ruta todavía se puede editar o eliminar.
#:
#: Solo `generada`: un plan que ya salió a la calle no se edita, se cancela o se
#: cierra. Editar lo que ya ocurrió es reescribir un hecho, y es la misma regla
#: por la que no se muta un análisis guardado.
ESTADOS_EDITABLES = (ESTADO_GENERADA,)


# =============================================================================
# ESCRITURA
# =============================================================================


def _resumen_de(plan: dict, peticion: dict) -> dict:
    """Las cifras que la tabla del historial muestra, sin abrir el plan.

    Duplica datos que ya están dentro de `plan`, y esa duplicación es la única
    del módulo. Se paga a propósito: sin ella, listar el historial obligaría a
    leer la geometría completa de cada plan para mostrar una fila de tabla.
    """
    recorridos = plan.get("segments") or []
    return {
        # Con varios puntos de origen el plan tiene varios recorridos. La tabla
        # nombra el primero y dice cuántos más, en vez de concatenarlos: una
        # celda con cuatro nombres deja de poder leerse de un vistazo.
        "origenNombre": (recorridos[0].get("originName") if recorridos else None),
        "recorridos": len(recorridos),
        "paradas": len(plan.get("stops") or []),
        "volumenM3": plan.get("totalVolumeM3"),
        "distanciaKm": plan.get("totalDistanceKm"),
        "duracionHoras": plan.get("totalDurationHours"),
        "viajes": sum((s.get("trips") or 1) for s in recorridos),
        "sinAsignar": len(plan.get("unassignedZones") or []),
        "trafficAware": bool(plan.get("trafficAware")),
        "horasDisponibles": peticion.get("availableHours"),
    }


async def guardar(owner: str, plan: dict, peticion: dict) -> str | None:
    """Registra un plan recién generado. Devuelve su id, o None si no se pudo.

    **Nunca lanza, y esa es la regla que define esta función.** Es la misma de
    `auditoria.registrar()`: una generación cuesta llamadas a OSRM o a Google y
    puede tardar bastante, así que perderla porque falló un registro secundario
    sería cobrarle al trabajador el precio de nuestra contabilidad. Si Mongo
    hipa, el plan igual se devuelve y lo único que falta es su fila en el
    historial.

    Por eso el llamador trata el `None` como "no quedó registrado" y sigue, en
    vez de propagar un error.
    """
    try:
        doc = {
            "owner": owner,
            "fecha": datetime.now(timezone.utc),
            "estado": ESTADO_GENERADA,
            "resumen": _resumen_de(plan, peticion),
            "plan": plan,
            "peticion": peticion,
        }
        res = await get_db().route_plans.insert_one(doc)
        return str(res.inserted_id)
    except Exception:
        return None


async def reemplazar(plan_id: str, owner: str, plan: dict, peticion: dict) -> bool:
    """Reescribe un plan existente con una generación nueva (C5).

    Editar una ruta es regenerarla, así que el registro se reemplaza en vez de
    crear uno nuevo: de lo contrario, corregir un volumen dejaría dos entradas
    en el historial para el mismo trabajo y nadie sabría cuál se hizo.

    **La fecha original se conserva**, porque el historial ordena por día y una
    corrección no cambia el día en que se planificó esa jornada.
    """
    try:
        oid = _object_id(plan_id)
    except HTTPException:
        return False
    actual = await get_db().route_plans.find_one({"_id": oid}, {"estado": 1})
    if not actual or actual.get("estado") not in ESTADOS_EDITABLES:
        return False
    try:
        await get_db().route_plans.update_one(
            {"_id": oid},
            {
                "$set": {
                    "owner": owner,
                    "resumen": _resumen_de(plan, peticion),
                    "plan": plan,
                    "peticion": peticion,
                    "editadoEn": datetime.now(timezone.utc),
                }
            },
        )
        return True
    except Exception:
        return False


# =============================================================================
# LECTURA
# =============================================================================


def _object_id(valor: str) -> ObjectId:
    try:
        return ObjectId(valor)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=404, detail="Ruta no encontrada")


class RutaGuardadaOut(BaseModel):
    """Una fila del historial. **Sin el plan**, que es el documento pesado."""

    id: str
    fecha: str
    estado: str
    resumen: dict[str, Any]
    editadoEn: str | None = None
    #: Cuándo salió de verdad y cuándo se cerró. Son hechos del día, distintos
    #: de la hora que el plan calculó: tenerlos separados es lo que después
    #: permite comparar lo planificado con lo que efectivamente se hizo.
    despachadaEn: str | None = None
    cerradaEn: str | None = None


def _fila(doc: dict) -> RutaGuardadaOut:
    def iso(campo: str) -> str | None:
        valor = doc.get(campo)
        return valor.isoformat() if valor else None

    return RutaGuardadaOut(
        id=str(doc["_id"]),
        fecha=doc["fecha"].isoformat(),
        estado=doc.get("estado", ESTADO_GENERADA),
        resumen=doc.get("resumen") or {},
        editadoEn=iso("editadoEn"),
        despachadaEn=iso("despachadaEn"),
        cerradaEn=iso("cerradaEn"),
    )


# **`/fechas` va declarada ANTES que `/{plan_id}`** o ese parámetro la captura y
# "fechas" llega como id. Es la misma trampa que ya costó un rato en
# `puntos_diarios.py`, y se evita con el orden de declaración, no con un regex.
@router.get("/fechas")
async def dias_con_rutas(
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Qué días tienen rutas y cuántas, en UNA agregación.

    Es lo que permite marcar los días con datos en el historial en vez de
    obligar a probar fecha por fecha. Con una consulta por día, navegar un mes
    costaría 31 viajes a Mongo. Mismo criterio que
    `GET /puntos-diarios/fechas`, que resolvió esto mismo para otro objeto.
    """
    cursor = await get_db().route_plans.aggregate(
        [
            {
                "$group": {
                    "_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$fecha"}},
                    "total": {"$sum": 1},
                }
            },
            {"$sort": {"_id": -1}},
        ]
    )
    return [{"fecha": d["_id"], "total": d["total"]} async for d in cursor]


@router.get("/ocupadas")
async def unidades_en_ruta(
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Qué vehículos están en una ruta en curso (pieza 2.2).

    Existe para que la PANTALLA pueda explicarlo. El ruteo ya los excluye por su
    cuenta, pero sin esto la flota del diálogo de generación mostraría un camión
    ocupado como disponible y el plan simplemente no lo usaría, sin decir por
    qué: exactamente la clase de silencio que obliga a adivinar.

    Devuelve ids y patentes mezclados, que es como `unidades_ocupadas()` los
    junta; la vista compara contra las dos. **Va declarada antes de
    `/{plan_id}`** o ese parámetro la captura y "ocupadas" llega como id.
    """
    return {"unidades": sorted(await unidades_ocupadas())}


@router.get("", response_model=list[RutaGuardadaOut])
async def listar_rutas(
    desde: str | None = Query(None, description="YYYY-MM-DD, inclusive"),
    hasta: str | None = Query(None, description="YYYY-MM-DD, inclusive"),
    estado: str | None = Query(None),
    limite: int = Query(100, ge=1, le=500),
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """El historial, de la más reciente a la más antigua.

    **Proyecta `plan` y `peticion` fuera.** Son los campos grandes (la geometría
    de un recorrido de 60 km son miles de vértices), y una tabla de fechas no
    necesita ni un byte de ellos. Sin esta proyección, abrir el historial
    descargaría varios MB para mostrar diez filas.
    """
    filtro: dict[str, Any] = {}
    if estado:
        filtro["estado"] = estado
    rango: dict[str, Any] = {}
    if desde:
        rango["$gte"] = _inicio_del_dia(desde)
    if hasta:
        rango["$lt"] = _fin_del_dia(hasta)
    if rango:
        filtro["fecha"] = rango

    cursor = (
        get_db()
        .route_plans.find(filtro, {"plan": 0, "peticion": 0})
        .sort("fecha", -1)
        .limit(limite)
    )
    return [_fila(d) async for d in cursor]


@router.get("/{plan_id}")
async def obtener_ruta(
    plan_id: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Un plan completo, con su geometría y la petición que lo originó.

    Es la única lectura que trae el documento entero, y por eso es la única que
    permite redibujar el trazo.
    """
    doc = await get_db().route_plans.find_one({"_id": _object_id(plan_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Ruta no encontrada")
    fila = _fila(doc)
    return {
        **fila.model_dump(),
        "plan": doc.get("plan"),
        "peticion": doc.get("peticion"),
    }


# =============================================================================
# CICLO DE VIDA (pieza 2.1)
# =============================================================================
# `generada` -> `en curso` -> `terminada`, y `cancelada` desde cualquiera de las
# dos primeras.
#
# **El paso a `terminada` lo marca una persona, nunca el reloj.** La duración
# calculada es un dato en pantalla ("debería terminar a las HH:MM"), no un
# disparador: un plan que se cierra solo porque pasaron las horas afirmaría que
# el trabajo se hizo sin que nadie lo haya dicho. Además, cerrarlo con el reloj
# obligaría a un proceso en el servidor vigilando fechas, que es infraestructura
# nueva para sostener una afirmación falsa.

#: Qué transiciones son legales. Un diccionario y no una cadena de `if`, para
#: que la regla se pueda leer entera de un vistazo y no quede repartida.
TRANSICIONES: dict[str, tuple[str, ...]] = {
    ESTADO_GENERADA: (ESTADO_EN_CURSO, ESTADO_CANCELADA),
    ESTADO_EN_CURSO: (ESTADO_TERMINADA, ESTADO_CANCELADA),
    # Las dos finales no van a ninguna parte: reabrir una ruta terminada sería
    # reescribir un hecho, y es la misma regla que impide mutar un análisis
    # guardado.
    ESTADO_TERMINADA: (),
    ESTADO_CANCELADA: (),
}


class CambioDeEstadoIn(BaseModel):
    estado: str


@router.patch("/{plan_id}/estado")
async def cambiar_estado(
    plan_id: str,
    body: CambioDeEstadoIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Mueve una ruta por su ciclo de vida.

    **Valida la transición, no solo el destino.** Aceptar cualquier estado
    válido dejaría pasar `terminada -> generada`, que es reabrir algo que ya
    ocurrió, y `cancelada -> en curso`, que es despachar lo que se canceló. El
    mensaje nombra las transiciones posibles desde donde está, porque "estado
    inválido" a secas no dice qué hacer.
    """
    oid = _object_id(plan_id)
    doc = await get_db().route_plans.find_one({"_id": oid}, {"estado": 1, "resumen": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Ruta no encontrada")

    destino = body.estado
    if destino not in ESTADOS:
        raise HTTPException(status_code=400, detail=f'"{destino}" no es un estado válido.')

    actual = doc.get("estado", ESTADO_GENERADA)
    if destino == actual:
        # No es un error: dos pestañas pueden despachar la misma ruta, y la
        # segunda no tiene nada que corregir.
        return {"ok": True, "estado": actual}

    posibles = TRANSICIONES.get(actual, ())
    if destino not in posibles:
        detalle = (
            f'Una ruta "{actual}" puede pasar a: {", ".join(posibles)}.'
            if posibles
            else f'Una ruta "{actual}" ya no cambia de estado.'
        )
        raise HTTPException(status_code=409, detail=detalle)

    campos: dict[str, Any] = {"estado": destino}
    # Cuándo salió y cuándo se cerró. Son hechos del día, no del plan: el plan
    # dice a qué hora DEBERÍA salir, y esto a qué hora salió de verdad. Tenerlos
    # separados es lo que después permite comparar lo planificado con lo hecho.
    if destino == ESTADO_EN_CURSO:
        campos["despachadaEn"] = datetime.now(timezone.utc)
    if destino in (ESTADO_TERMINADA, ESTADO_CANCELADA):
        campos["cerradaEn"] = datetime.now(timezone.utc)

    await get_db().route_plans.update_one({"_id": oid}, {"$set": campos})
    await auditoria.registrar(
        current_user.username,
        "cambiar estado",
        "ruta",
        plan_id,
        {"de": actual, "a": destino},
    )
    return {"ok": True, "estado": destino}


@router.delete("/{plan_id}")
async def eliminar_ruta(
    plan_id: str,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Borra una ruta guardada.

    **Solo las editables**, o sea las que todavía no salieron. Una ruta en curso
    se cancela, no se borra: borrarla haría desaparecer el trabajo que la
    cuadrilla está haciendo en ese momento. Una terminada es historia y la
    historia no se borra por conveniencia.
    """
    oid = _object_id(plan_id)
    doc = await get_db().route_plans.find_one({"_id": oid}, {"estado": 1, "resumen": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Ruta no encontrada")
    estado = doc.get("estado", ESTADO_GENERADA)
    if estado not in ESTADOS_EDITABLES:
        raise HTTPException(
            status_code=409,
            detail=(
                f'Esta ruta está "{estado}" y no se puede eliminar. '
                "Una ruta que ya salió se cancela o se cierra, no se borra."
            ),
        )
    await get_db().route_plans.delete_one({"_id": oid})
    await auditoria.registrar(
        current_user.username,
        "eliminar",
        "ruta",
        plan_id,
        {"resumen": doc.get("resumen")},
    )
    return {"ok": True}


# =============================================================================
# CIERRE DEL RETIRO (pieza 2.4)
# =============================================================================
# Al marcar una ruta terminada, el trabajador confirma por zona cuánto salió DE
# VERDAD. Eso crea un registro de retiro por parada.
#
# -----------------------------------------------------------------------------
# UN RETIRO Y UN ANÁLISIS SON EL MISMO TIPO DE DATO
# -----------------------------------------------------------------------------
# Los dos dicen cuánto volumen había en un lugar en una fecha. Uno lo midió un
# dron y el otro lo contó la cuadrilla, y esa diferencia está en el ORIGEN, no
# en la naturaleza del dato. Por eso van a la misma línea de tiempo de la zona.
#
# **Eso es lo que le da historial de volumen a los 54 puntos del catastro sin
# volarle el dron a ninguno**, que es el mayor valor que quedaba sobre la mesa:
# un punto permanente que se retira todas las semanas acumula una serie real sin
# que nadie haya hecho un vuelo.
#
# Colección aparte y no dentro de `analyses`: un retiro no tiene detecciones, ni
# ortomosaico, ni `algorithmVersion`, así que meterlo ahí obligaría a filtrarlo
# en cada consulta de análisis y a volver opcional medio documento.
#
# -----------------------------------------------------------------------------
# LO DECLARADO NO ES LO RETIRADO
# -----------------------------------------------------------------------------
# Se guardan las DOS cifras: la que el plan iba a mover y la que la cuadrilla
# dice que movió. Confundirlas impediría después comparar lo planificado contra
# lo hecho, que es justo para lo que este registro existe. Es la misma
# distinción que `puntos_diarios.py` ya hace entre CANT. y M3 RETIRO.
#
# **Sin dotación.** Una dotación es una restricción de PLANIFICACIÓN, y un
# retiro ya ocurrió: quién fue está en el plan, y repetirlo acá daría dos
# respuestas a la misma pregunta.


class RetiroDeParadaIn(BaseModel):
    """Lo que la cuadrilla confirma de una parada."""

    stopId: str
    kind: str
    #: Cuánto salió. `None` cuando no se midió: no es lo mismo que cero, igual
    #: que una `capacity_ton` ausente no significa que el camión no aguante
    #: nada. Cero significa que se fue sin cargar.
    retiradoM3: float | None = None
    #: Si la parada se atendió completa. Puede ser `True` con menos volumen del
    #: planificado (la zona tenía menos de lo estimado) y `False` con el volumen
    #: completo (se cargó todo lo que cabía y quedó más).
    completado: bool = True


class CierreIn(BaseModel):
    #: Puede venir vacía: cerrar sin registrar cifras es un resultado válido, y
    #: obligar a llenarlas haría que la ruta quedara "en curso" para siempre
    #: cuando nadie anotó nada.
    retiros: list[RetiroDeParadaIn] = []


@router.post("/{plan_id}/cerrar")
async def cerrar_ruta(
    plan_id: str,
    body: CierreIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Termina una ruta y registra lo que se retiró en cada parada.

    **Es el único camino que la interfaz ofrece para llegar a `terminada`**, y
    valida la misma transición que `PATCH /estado`: la máquina de estados es una
    sola, esto solo agrega los datos del cierre.
    """
    oid = _object_id(plan_id)
    doc = await get_db().route_plans.find_one({"_id": oid})
    if not doc:
        raise HTTPException(status_code=404, detail="Ruta no encontrada")

    actual = doc.get("estado", ESTADO_GENERADA)
    if ESTADO_TERMINADA not in TRANSICIONES.get(actual, ()):
        raise HTTPException(
            status_code=409,
            detail=(
                f'Una ruta "{actual}" no se puede cerrar. '
                "Solo se cierra una que esté en curso."
            ),
        )

    ahora = datetime.now(timezone.utc)

    # Lo que el plan decía de cada parada, para guardar las dos cifras juntas.
    # Se indexa por (kind, stopId) y no por stopId solo: un punto diario y un
    # análisis pueden compartir id sin que eso signifique nada.
    planificado: dict[tuple[str, str], dict] = {}
    for s in ((doc.get("plan") or {}).get("stops") or []):
        if s.get("stopId"):
            planificado[(s.get("kind") or "analysis", s["stopId"])] = s

    registros = []
    for r in body.retiros:
        origen = planificado.get((r.kind, r.stopId), {})
        registros.append({
            "owner": current_user.username,
            "fecha": ahora,
            "planId": plan_id,
            "kind": r.kind,
            "stopId": r.stopId,
            # El nombre se COPIA, igual que en el plan: un registro histórico
            # que cambia porque alguien renombró la zona deja de ser un
            # registro.
            "nombre": origen.get("label"),
            # Solo un análisis pertenece a una zona. Un punto diario es un hecho
            # de una fecha y no un lugar que se sigue en el tiempo, así que su
            # retiro no entra en ninguna serie histórica.
            "zoneId": origen.get("zoneId"),
            "volumenPlanificadoM3": origen.get("removedVolumeM3"),
            "volumenRetiradoM3": r.retiradoM3,
            "completado": r.completado,
        })

    if registros:
        await get_db().retiros.insert_many(registros)

    await get_db().route_plans.update_one(
        {"_id": oid},
        {"$set": {"estado": ESTADO_TERMINADA, "cerradaEn": ahora}},
    )
    await auditoria.registrar(
        current_user.username,
        "cerrar",
        "ruta",
        plan_id,
        {"paradas": len(registros)},
    )
    return {"ok": True, "estado": ESTADO_TERMINADA, "retiros": len(registros)}


@router.get("/retiros/por-zona")
async def retiros_por_zona(
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Cuánto se ha retirado de cada zona, y desde cuándo.

    En UNA agregación, por el mismo motivo que `/fechas`: Vista Principal
    muestra 54 lugares, y preguntar por cada uno serían 54 viajes a Mongo en
    cada apertura.

    Devuelve además la fecha del retiro MÁS RECIENTE, que es lo que permite
    descontar solo los posteriores a la última medición: un retiro anterior al
    vuelo ya está reflejado en lo que el dron vio.

    **Va declarada antes de `/{plan_id}`** o ese parámetro la captura.
    """
    cursor = await get_db().retiros.aggregate(
        [
            {"$match": {"zoneId": {"$ne": None}, "volumenRetiradoM3": {"$ne": None}}},
            {
                "$group": {
                    "_id": "$zoneId",
                    "total": {"$sum": "$volumenRetiradoM3"},
                    "ultimo": {"$max": "$fecha"},
                    "veces": {"$sum": 1},
                }
            },
        ]
    )
    return [
        {
            "zoneId": d["_id"],
            "totalM3": round(d["total"], 2),
            "ultimo": d["ultimo"].isoformat() if d.get("ultimo") else None,
            "veces": d["veces"],
        }
        async for d in cursor
    ]


@router.get("/retiros")
async def listar_retiros(
    zoneId: str | None = Query(None),
    limite: int = Query(200, ge=1, le=1000),
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    """Los retiros registrados, de los más recientes a los más antiguos.

    Con `zoneId` son los de un lugar, que es lo que su línea de tiempo necesita
    para graficarlos junto a las mediciones por dron.
    """
    filtro: dict[str, Any] = {}
    if zoneId:
        filtro["zoneId"] = zoneId
    cursor = get_db().retiros.find(filtro).sort("fecha", -1).limit(limite)
    return [
        {
            "id": str(d["_id"]),
            "fecha": d["fecha"].isoformat(),
            "planId": d.get("planId"),
            "kind": d.get("kind"),
            "stopId": d.get("stopId"),
            "nombre": d.get("nombre"),
            "zoneId": d.get("zoneId"),
            "volumenPlanificadoM3": d.get("volumenPlanificadoM3"),
            "volumenRetiradoM3": d.get("volumenRetiradoM3"),
            "completado": d.get("completado", True),
        }
        async for d in cursor
    ]


# =============================================================================
# OCUPACIÓN DE RECURSOS (pieza 2.2)
# =============================================================================


async def unidades_ocupadas() -> set[str]:
    """Los vehículos que están en una ruta EN CURSO, por id y por patente.

    Un camión despachado no puede entrar a otro plan: está en la calle. Sin
    esto, dos rutas generadas el mismo día despacharían el mismo vehículo y la
    cuadrilla descubriría el choque en el patio.

    **Estado DERIVADO, nunca se escribe `disponible`.** Esa marca es información
    operacional que alguien puso a mano (el camión está en mantención, no está
    el chofer), y pisarla desde el ruteo la destruiría: al terminar la ruta
    habría que "devolverla", y cualquier fallo a mitad de camino dejaría
    unidades apagadas sin que nadie supiera por qué. Derivarla de los planes en
    curso no puede quedar inconsistente, porque no hay nada que sincronizar.

    **Devuelve LAS DOS identidades en el mismo conjunto**, el id del recurso y
    la patente, y quien filtra compara contra ambas. El id es el identificador
    real y no cambia; la patente es lo que la municipalidad usa para nombrar la
    unidad en su planilla, y es lo único que traen los planes guardados antes de
    que `resourceId` viajara en la respuesta. Con uno solo, o se escapan los
    planes viejos o se escapan las unidades sin patente cargada.

    Un vehículo sin ninguna de las dos simplemente no ocupa nada: es preferible
    a inventar una identidad.
    """
    cursor = get_db().route_plans.find(
        {"estado": ESTADO_EN_CURSO}, {"plan.segments.vehicles": 1}
    )
    ocupadas: set[str] = set()
    async for doc in cursor:
        for seg in ((doc.get("plan") or {}).get("segments") or []):
            for v in seg.get("vehicles") or []:
                for clave in (v.get("resourceId"), v.get("patente")):
                    if clave:
                        ocupadas.add(str(clave))
    return ocupadas


# =============================================================================
# AYUDANTES DE FECHA
# =============================================================================
# El filtro del historial llega como `YYYY-MM-DD` y las fechas se guardan como
# datetime en UTC, así que un día es un rango y no una igualdad.


def _inicio_del_dia(dia: str) -> datetime:
    return _parsear(dia)


def _fin_del_dia(dia: str) -> datetime:
    """El instante en que empieza el día SIGUIENTE, para comparar con `$lt`.

    No las 23:59:59 del mismo día: con `$lt` eso deja fuera el último segundo, y
    con `$lte` deja fuera los microsegundos posteriores. Un día entero se expresa
    como "menor que el inicio del siguiente" y no hay instante que se escape.
    """
    return _parsear(dia) + timedelta(days=1)


def _parsear(dia: str) -> datetime:
    try:
        return datetime.strptime(dia, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail="La fecha debe ser YYYY-MM-DD")
