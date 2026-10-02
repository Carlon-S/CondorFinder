import asyncio
import itertools
import re
from math import asin, cos, radians, sin, sqrt

from bson import ObjectId
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from pymongo.asynchronous.database import AsyncDatabase
from pyproj import Transformer

import auth as auth_module
import osrm_client
import resources as resources_module

# =============================================================================
# CONDORFINDER — GENERACIÓN DE RUTA ÓPTIMA (HDU5)
# Archivo: backendModel/routing.py
#
# POST /routes/generate resuelve la capacidad REAL de los puntos activos y
# los basurales reales de los análisis elegidos contra Mongo (el frontend
# solo manda IDs — nunca los datos en sí), arma la ruta real (OSRM, ver
# osrm_client.py) y devuelve la respuesta con la forma exacta que
# src/lib/routePlan.ts espera.
#
# Decisiones de modelo, ya conversadas y cerradas con el equipo antes de
# implementar (no re-litigar sin volver a hablarlo):
#   - Capacidad de la ruta = los recursos de familia "carga" DISPONIBLES de
#     los puntos activos (ver capacidad_de_carga_por_punto en resources.py).
#     Las máquinas (retro, frontal, minicargador) cargan pero no transportan,
#     así que no suman capacidad, y los carros de arrastre se remolcan.
#     `personal_count` tampoco es una restricción hoy (sin AC que lo pida).
#
#     CORRECCIÓN respecto de lo que decía esta nota antes. Decía que "las
#     tolvas quedan fijas en el punto (acopio local, no son una unidad de
#     transporte)" y por eso no entraban al cálculo. Con la flota real en la
#     mano eso resultó estar equivocado: en el vocabulario de la municipalidad
#     una TOLVA es un camión volquete. Las seis de la planilla son Ford Cargo y
#     Hino con patente, "Capacidad 10 M3" y dotación "1 Conductor + 2
#     Peonetas", y la programación diaria les asigna viajes de retiro
#     ("PRIMER VIAJE TODAS LAS TOLVAS LAS INDUSTRIAS", 48 m³, equipos
#     2184-2183-1138-2224). Si no contaran, el punto de salida real quedaría
#     con 0 m³ de capacidad, porque TODOS sus vehículos de carga son tolvas.
#   - Un stop de ruta = un ANÁLISIS cargado (no una detección individual):
#     la ubicación es `orthoCenter` (huella real del ortomosaico, estable
#     entre corridas — mismo criterio que ya usa /rutas.tsx para el círculo
#     de zona) y el volumen es la suma de `volume_m3` de todas sus
#     detecciones. Visitar cada detección por separado no tiene sentido
#     operacional: son puntos casi superpuestos dentro de la misma zona.
#   - Si ningún punto activo por sí solo cubre el volumen total, se prueba
#     con combinaciones de 2+ puntos (mochila por tamaño creciente) y se
#     reparte cada zona al punto más cercano dentro del grupo elegido
#     (con rebalanceo si algún punto queda sobrecargado) — cada punto
#     resultante arma su PROPIO recorrido independiente (una cuadrilla por
#     patio, no una ruta fusionada entre depósitos distintos).
#   - Cada recorrido es base -> zonas -> relleno sanitario -> base, tres
#     tramos. El único que se hace cargado es el de la última zona al
#     relleno, y por eso es el único al que se le aplica
#     _LOADED_SPEED_FACTOR; la ida y el regreso se hacen vacíos. El tiempo
#     total del plan (para el chequeo contra availableHours y lo que se
#     muestra) asume que las sub-rutas de distintos puntos corren en
#     PARALELO (cuadrillas distintas saliendo a la vez), así que se usa el
#     máximo entre sub-rutas, no la suma.
#
# `priorityWasteType` **sí hace algo desde el AC4**: es el desempate de la
# elección de vehículo. Durante mucho tiempo estuvo en el contrato sin tocar
# ninguna lógica, o sea era un control que mentía, lo que es peor que no
# tenerlo. Ahora, cuando el trabajador elige un tipo en el diálogo, esa clase
# reemplaza a la dominante calculada para decidir qué vehículos se prefieren.
# No cambia el ORDEN de las paradas: el algoritmo sigue visitando todas las
# zonas que entraron al plan.
#
# Los modelos de acá abajo usan nombres de campo en camelCase (no el
# snake_case habitual en Python) A PROPÓSITO: src/lib/routePlan.ts interpreta
# la respuesta tal cual llega, sin traducir nombres.
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
# MODELOS — mismo shape que src/lib/routePlan.ts
# =============================================================================

class RoutePlanRequestIn(BaseModel):
    analysisIds: list[str]
    activePointIds: list[str]
    availableHours: float
    priorityWasteType: str | None = None
    # Zonas que el trabajador marcó como prioritarias: entran al plan antes que
    # las demás y son las últimas en salir cuando la capacidad o las horas
    # obligan a recortar.
    #
    # Existe porque el criterio automático con el que se llena el plan (volumen
    # ascendente, ver el handler) no puede saber que una zona es urgente: que
    # haya un reclamo, un colegio al lado o un riesgo sanitario es información
    # que vive fuera del sistema. En vez de inventar una heurística que lo
    # adivine, se le da la palanca a quien sí lo sabe.
    #
    # Es del PLAN y no de la zona, así que no se persiste: una zona urgente hoy
    # puede no serlo mañana, y guardarlo convertiría una decisión del día en un
    # atributo permanente del basural. Los ids que no estén también en
    # `analysisIds` se ignoran solos, porque la marca se cruza contra las zonas
    # efectivamente cargadas.
    priorityAnalysisIds: list[str] = []


class RoutePlanStopOut(BaseModel):
    order: int
    lat: float
    lng: float
    label: str
    # Qué análisis guardado es esta parada. El dato ya lo tenía _load_route_stops
    # y el handler lo descartaba al armar la salida, así que la vista tenía que
    # emparejar la parada con su zona POR NOMBRE para mostrarle el volumen y el
    # tipo de residuo, cosa que se rompe con dos zonas que se llamen parecido.
    analysisId: str | None = None


class RoutePlanVehicleOut(BaseModel):
    """Identidad de un vehículo asignado a un tramo. AC7 de HDU5.1. Calca
    RoutePlanVehicle de src/lib/routePlan.ts campo por campo."""
    patente: str
    tipo: str
    resourceId: str | None = None
    numeroEquipo: str | None = None
    capacityM3: float | None = None
    # Nombre del archivo, no la URL: la sirve GET /resources/photo/{filename} y
    # el frontend la arma, igual que en la lista de recursos. None en 8 de las 21
    # unidades de la flota real.
    foto: str | None = None
    # La dotación de ESTE vehículo. Estaba a nivel del tramo, que servía mientras
    # el tramo tenía un solo camión; con varios, "1 conductor, 2 peonetas" sin
    # decir de cuál no significa nada.
    crew: list[str] = []


class RouteSegmentOut(BaseModel):
    """Un resumen por sub-ruta/punto de origen usado — mismo índice que
    outboundPaths[i]/returnPaths[i] abajo, para que el frontend pueda
    mostrar la ventana flotante de cada tramo (estilo Google Maps: camiones
    usados, tiempo, distancia, velocidad — la velocidad la calcula el
    frontend como distancia/tiempo, no hace falta mandarla aparte)."""
    originName: str
    trucksUsed: int
    # ── AC7 de HDU5.1 ──
    # **Todos** los vehículos del tramo, cada uno con su patente, su tipo, su
    # capacidad, su foto y su propia dotación.
    #
    # Antes viajaba un `vehicle` singular y solo cuando el tramo lo recorría un
    # camión; con dos o más, la vista caía a "2 camiones" y no decía cuáles.
    # Interpretar el criterio ("qué vehículo lo recorre, por patente y tipo") en
    # singular estricto llevaba a partir la sub-ruta por camión, que es trabajo
    # del algoritmo; nombrar a los dos que efectivamente recorren el tramo lo
    # cumple sin inventar un reparto de zonas que nadie decidió, y es verdad.
    vehicles: list[RoutePlanVehicleOut] = []
    outboundDistanceKm: float
    outboundDurationHours: float
    # Tramo de la última zona al relleno sanitario, el único que se recorre
    # cargado. Opcionales en el contrato de TypeScript para que un plan generado
    # por una versión anterior del backend siga parseando.
    disposalName: str | None = None
    disposalDistanceKm: float | None = None
    disposalDurationHours: float | None = None
    returnDistanceKm: float
    returnDurationHours: float


class RoutePlanUnassignedOut(BaseModel):
    """Una zona que no entró al plan, con el motivo. AC6 de HDU5.1.

    El motivo viaja como TEXTO y no como código: es lo que se le muestra al
    trabajador tal cual, y el conjunto de motivos va a crecer con cada
    restricción que se implemente (personal incompleto, fuera de autonomía,
    ningún vehículo compatible). Un enum obligaría a sincronizar backend y
    frontend cada vez que aparece uno nuevo."""
    analysisId: str
    name: str
    reason: str


class RoutePlanRouteOut(BaseModel):
    stops: list[RoutePlanStopOut]
    totalDistanceKm: float | None = None
    totalDurationHours: float | None = None
    # Con cuánto se armó el plan DE VERDAD. No es lo mismo que el volumen de las
    # zonas cargadas: desde que existe AC6, el plan puede dejar zonas fuera, y
    # sin esta cifra el trabajador vería "6,94 m³ cargados" sin forma de saber
    # que el recorrido mueve 3,61. También es lo único que hace observable que
    # el ruteo respeta la bandera `enabled` de cada detección.
    totalVolumeM3: float | None = None
    # Un trazo (lista de [lat, lng]) por sub-ruta/punto de origen usado —
    # casi siempre uno solo. Separados en ida/vuelta para que el frontend
    # los pinte con estilos distintos (ver GeoMapImpl.tsx).
    outboundPaths: list[list[list[float]]] = []
    # El tramo cargado, de la última zona al relleno. Separado de los otros dos
    # para poder pintarlo distinto: es el único que el camión hace lleno.
    disposalPaths: list[list[list[float]]] = []
    returnPaths: list[list[list[float]]] = []
    segments: list[RouteSegmentOut] = []
    # AC6: el plan sigue siendo válido para el resto. Lista vacía significa que
    # todas las zonas entraron.
    unassignedZones: list[RoutePlanUnassignedOut] = []


class RoutePlanSuccessOut(BaseModel):
    status: str = "success"
    route: RoutePlanRouteOut


class RoutePlanInfeasibleOut(BaseModel):
    status: str = "infeasible"
    message: str


# =============================================================================
# REPROYECCIÓN UTM → WGS84 (orthoCenter viene en el CRS proyectado del
# ortomosaico, ej. "EPSG:32719" — OSRM y los puntos de HDU6 necesitan
# WGS84). Mismo patrón de reconocimiento de zona UTM que
# src/lib/projection.ts (326xx = norte, 327xx = sur), replicado acá porque
# esta conversión corre en el backend (para llamar a OSRM), no en Leaflet.
# =============================================================================

_UTM_CRS_PATTERN = re.compile(r"^EPSG:(326|327)(\d{2})$")
_transformer_cache: dict[str, Transformer] = {}


def _utm_to_wgs84(x: float, y: float, crs: str) -> tuple[float, float] | None:
    crs_norm = crs.strip().upper()
    if not _UTM_CRS_PATTERN.match(crs_norm):
        return None
    if crs_norm not in _transformer_cache:
        _transformer_cache[crs_norm] = Transformer.from_crs(crs_norm, "EPSG:4326", always_xy=True)
    lng, lat = _transformer_cache[crs_norm].transform(x, y)
    return (lat, lng)


def _format_number(value: float) -> str:
    """"1.0" -> "1", "1.5" -> "1.5", "20.0" -> "20" — para cualquier número
    (horas, m³) que se muestre en un mensaje de texto al usuario. `:g`
    recorta ceros decimales sobrantes sin redondear de forma rara los casos
    con decimales reales. Los campos numéricos de la respuesta JSON
    (totalDistanceKm/totalDurationHours) NO pasan por acá — son datos, el
    frontend decide cómo formatearlos para mostrar."""
    return f"{round(value, 2):g}"


def _haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distancia en línea recta (metros) — SOLO para heurísticas baratas
    (ordenar candidatos, repartir zonas entre puntos) antes de pedirle a
    OSRM la distancia real por calles del resultado final. Nunca se le
    muestra esto al usuario como si fuera la distancia real de la ruta."""
    lat1, lng1 = a
    lat2, lng2 = b
    r = 6371000.0
    p1, p2 = radians(lat1), radians(lat2)
    dphi = radians(lat2 - lat1)
    dlambda = radians(lng2 - lng1)
    h = sin(dphi / 2) ** 2 + cos(p1) * cos(p2) * sin(dlambda / 2) ** 2
    return 2 * r * asin(sqrt(h))


# =============================================================================
# PUENTE DE ENTRADA — puntos activos (capacidad real de camiones)
# =============================================================================

async def _load_active_points(point_ids: list[str]) -> list[dict]:
    """Trae de Mongo los puntos de `point_ids`, filtrando además por
    `active: True` server-side (la lista del frontend pudo quedar vieja).
    IDs con formato inválido se descartan en vez de tirar un 500."""
    valid_ids: list[ObjectId] = []
    for pid in point_ids:
        try:
            valid_ids.append(ObjectId(pid))
        except Exception:
            continue
    if not valid_ids:
        return []
    puntos = await get_db().resource_points.find(
        {"_id": {"$in": valid_ids}, "active": True}
    ).to_list(length=None)

    # HDU8: la capacidad de transporte sale de los RECURSOS individuales
    # disponibles del punto, no de la lista `trucks` que HDU6 guardaba dentro
    # del documento. Es lo que hace real el AC5 de HDU8 ("un recurso no
    # disponible queda excluido al armar la asignación de una ruta"): este es el
    # único lugar del sistema donde ese interruptor cambia un resultado.
    #
    # Se escribe sobre la misma clave `trucks` a propósito. Las cuatro
    # funciones de abajo que calculan capacidad y cantidad mínima de camiones ya
    # leen de ahí, están probadas y son de otro integrante del equipo: cambiar
    # la FUENTE del dato sin cambiar su forma deja ese algoritmo intacto.
    #
    # Se escribe SIEMPRE, incluso lista vacía. El documento del punto ya no
    # guarda contadores de maquinaria (ver ResourcePointIn en resources.py), así
    # que no hay ningún respaldo al que caer: un punto sin recursos disponibles
    # tiene capacidad cero, y _select_origin_group lo descarta.
    #
    # Hubo una versión intermedia que respetaba los contadores viejos cuando el
    # punto no tenía capacidad propia. Tenía un agujero justo en el criterio que
    # esto implementa: marcar TODOS los recursos de un punto como no disponibles
    # dejaba la lista vacía, el respaldo se activaba, y la capacidad volvía a
    # salir de los contadores en vez de bajar a cero.
    capacidades = await resources_module.capacidad_de_carga_por_punto(
        [str(p["_id"]) for p in puntos]
    )
    for punto in puntos:
        punto["trucks"] = capacidades.get(str(punto["_id"]), [])
    return puntos


def _point_truck_capacity(point: dict) -> float:
    return sum(t.get("capacity_m3", 0) for t in point.get("trucks", []))


_MAX_UNIDADES_FUERZA_BRUTA = 14  # 2^14 = 16384 subconjuntos, instantáneo


def _trucks_used(
    point: dict,
    assigned_volume: float,
    assigned_weight_ton: float = 0.0,
    clase_dominante: str | None = None,
) -> list[dict]:
    """QUÉ camiones de `point` hacen falta para cubrir `assigned_volume`.

    Devuelve las UNIDADES, no su cantidad. Antes se llamaba _min_trucks_used y
    retornaba un entero: sabía perfectamente cuáles camiones había elegido y
    descartaba esa información justo al retornar, que es la razón por la que el
    plan nunca pudo decir qué vehículo recorre cada tramo (AC7 de HDU5.1).

    **Elige el conjunto con menos vehículos y, entre los de ese tamaño, el de
    menor capacidad sobrante.** Los dos criterios en ese orden, y ninguno es
    arbitrario: cada vehículo de más es una dotación de más (un conductor y una
    o dos peonetas que ese día no están en otra parte), así que la cantidad pesa
    primero; a igual cantidad, el vehículo justo es mejor que el grande, porque
    mandar un AMPLIROLL de 20 m³ a retirar 6,94 deja 13 m³ de capacidad parada.

    Antes era una voraz por capacidad descendente, que minimiza la cantidad pero
    ignora el desperdicio: con la flota real elegía siempre un ampliroll, aunque
    una tolva de 10 m³ hiciera el mismo viaje. Ese era un defecto observable en
    pantalla, no una imprecisión teórica.

    La enumeración es exacta porque la flota de un punto es chica (21 unidades en
    total, 8 con capacidad). Se corta en el primer tamaño que alcanza, así que
    para el caso normal (un solo vehículo basta) ni siquiera recorre los pares.
    Por encima de _MAX_UNIDADES_FUERZA_BRUTA cae a la voraz de antes, que sigue
    dando una respuesta válida aunque no la mejor.

    Con al menos un camión se despacha uno aunque el volumen asignado sea 0:
    igual hay que hacer el viaje, y se manda el más chico.

    ── AC4 de HDU5.1 ──
    Con `assigned_weight_ton` y `clase_dominante` se aplican las reglas de tipo
    de residuo, y la estructura refleja la del criterio: "priorizará la
    coincidencia de tipo, y solo usará un vehículo no compatible si no existe
    ninguna alternativa compatible con capacidad suficiente".

      1. Reglas DURAS, que descartan candidatos: el tipo que no participa de una
         ruta de microbasural, y el que no aguanta el peso de la zona.
      2. Dos vueltas de la MISMA enumeración: primero sobre los preferidos para
         esa clase, y solo si ninguna combinación alcanza, sobre todos. El "con
         capacidad suficiente" del criterio es lo que ya hacía el enumerador, no
         hubo que agregarlo.

    Devuelve [] cuando ninguna regla dura deja candidatos. El llamador lo
    traduce en una zona sin asignar con su motivo (AC6)."""
    camiones = [c for c in point.get("trucks", []) if c.get("capacity_m3", 0) > 0]

    # ── Reglas duras ──
    camiones = [
        c
        for c in camiones
        if resources_module.tipo_participa_en_microbasural(c.get("tipo", ""))
    ]
    if assigned_weight_ton > 0:
        # Un límite de peso ausente no descarta: significa no declarado, no
        # ilimitado-pero-cero. Toda la flota de transporte declara m3; solo el
        # AMPLIROLL declara además sus 15 t.
        camiones = [
            c
            for c in camiones
            if c.get("capacity_ton") is None or c["capacity_ton"] >= assigned_weight_ton
        ]

    if not camiones:
        return []

    def enumerar(candidatos: list[dict]) -> list[dict]:
        por_capacidad = sorted(candidatos, key=lambda t: t.get("capacity_m3", 0))
        if assigned_volume <= 0:
            return por_capacidad[:1]

        if len(candidatos) <= _MAX_UNIDADES_FUERZA_BRUTA:
            for tamano in range(1, len(candidatos) + 1):
                mejor: tuple[float, list[dict]] | None = None
                for combo in itertools.combinations(por_capacidad, tamano):
                    capacidad = sum(c.get("capacity_m3", 0) for c in combo)
                    if capacidad < assigned_volume:
                        continue
                    if mejor is None or capacidad < mejor[0]:
                        mejor = (capacidad, list(combo))
                # El primer tamaño con solución es el mínimo de vehículos, y
                # dentro de él ya se eligió la capacidad más baja que alcanza.
                if mejor is not None:
                    return mejor[1]
            return []

        # Respaldo: voraz por capacidad descendente, para una flota grande.
        total = 0.0
        elegidos: list[dict] = []
        for c in reversed(por_capacidad):
            elegidos.append(c)
            total += c.get("capacity_m3", 0)
            if total >= assigned_volume:
                break
        return elegidos if total >= assigned_volume else []

    # ── Primera vuelta: solo los preferidos para esta clase ──
    preferidos = [
        c
        for c in camiones
        if resources_module.tipo_prefiere_clase(c.get("tipo", ""), clase_dominante)
    ]
    if preferidos and len(preferidos) < len(camiones):
        elegidos = enumerar(preferidos)
        if elegidos:
            return elegidos

    # ── Segunda vuelta: "si no existe ninguna alternativa compatible" ──
    elegidos = enumerar(camiones)
    if elegidos:
        return elegidos

    # Ningún subconjunto cubre el volumen. No debería pasar (el handler recorta
    # la carga antes), pero devolver la flota entera es más útil que nada.
    return sorted(camiones, key=lambda t: t.get("capacity_m3", 0), reverse=True)


def _dotacion_de(camion: dict) -> list[str]:
    """La dotación de un vehículo como texto legible, que es lo que el AC7 llama
    "su personal asociado".

    Sale de la planilla de la municipalidad (conductores/peonetas/operadores
    requeridos por unidad), así que son los ROLES y no los nombres. El criterio
    detalla el nivel del vehículo ("por patente y tipo") y deja el del personal
    sin calificar, a diferencia del AC2, que sí habla de "un mismo perfil de
    trabajador" y por eso sí va a necesitar identidad.

    El día que exista el registro de trabajadores, esta función devuelve nombres
    y la vista no cambia: el contrato es `crew?: string[]`."""
    partes: list[str] = []
    for cantidad, singular, plural in (
        (camion.get("conductores", 0), "conductor", "conductores"),
        (camion.get("peonetas", 0), "peoneta", "peonetas"),
        (camion.get("operadores", 0), "operador", "operadores"),
    ):
        if cantidad:
            partes.append(f"{cantidad} {singular if cantidad == 1 else plural}")
    return partes


# =============================================================================
# PUENTE DE ENTRADA — basurales reales de los análisis guardados elegidos
# =============================================================================

async def _load_route_stops(analysis_ids: list[str]) -> list[dict]:
    """Un stop por ANÁLISIS cargado (no por detección) — ubicación =
    orthoCenter reproyectado a WGS84, volumen = suma de volume_m3 de todas
    sus detecciones. Análisis sin crs/orthoCenter, o cuyo CRS no se puede
    reproyectar, se omiten (no hay forma de ubicarlos en una ruta real)."""
    valid_ids: list[ObjectId] = []
    for aid in analysis_ids:
        try:
            valid_ids.append(ObjectId(aid))
        except Exception:
            continue
    if not valid_ids:
        return []

    docs = await get_db().analyses.find({"_id": {"$in": valid_ids}}).to_list(length=None)

    stops: list[dict] = []
    for doc in docs:
        crs = doc.get("crs")
        center = doc.get("orthoCenter")
        if not crs or not center or len(center) != 2:
            continue
        latlng = _utm_to_wgs84(center[0], center[1], crs)
        if latlng is None:
            continue
        lat, lng = latlng
        # Las detecciones que el trabajador desactivó en la vista de análisis
        # NO cuentan. Sin este filtro el ruteo planificaba con un volumen mayor
        # al que el propio sistema muestra en pantalla, y como ese número decide
        # qué cabe y qué no, una zona podía quedar fuera de la ruta por un
        # volumen que el trabajador ya había descartado. Mismo criterio que
        # computeSummary() en el frontend: ausente significa activa.
        activas = [d for d in doc.get("detections", []) if d.get("enabled", True)]
        total_volume = sum((d.get("volume_m3") or 0) for d in activas)
        # AC4 de HDU5.1. Dos datos que ya estaban guardados en cada análisis y
        # que el ruteo no leía: el peso (lo calcula volumeCalc.py por detección,
        # densidad x volumen) y la clase de residuo. Sin ellos no hay contra qué
        # comparar ni el límite en toneladas del AMPLIROLL ni la compatibilidad
        # por tipo.
        total_weight_kg = sum((d.get("weight_kg") or 0) for d in activas)
        clases: dict[str, float] = {}
        for d in activas:
            vol = d.get("volume_m3") or 0
            desglose = d.get("breakdown")
            if desglose:
                # Detección fusionada ("Varios tipos"): su volumen es el del
                # GRUPO, no la suma de sus partes, así que se reparte entre las
                # clases en proporción, igual que volumeByWasteType() en el
                # frontend. Sumar el desglose haría que el detalle por tipo
                # superara el total de la zona.
                peso_total = sum((p.get("volume_m3") or 0) for p in desglose) or 1
                for parte in desglose:
                    clase = parte.get("class") or "Sin clasificar"
                    proporcion = (parte.get("volume_m3") or 0) / peso_total
                    clases[clase] = clases.get(clase, 0) + vol * proporcion
            else:
                clase = d.get("class") or "Sin clasificar"
                clases[clase] = clases.get(clase, 0) + vol
        stops.append({
            "analysisId": str(doc["_id"]),
            "name": doc.get("name") or "Zona sin nombre",
            "lat": lat,
            "lng": lng,
            "volumeM3": total_volume,
            "weightTon": total_weight_kg / 1000,
            "clasesPorVolumen": clases,
            # El "tipo de residuo predominante" del que habla el criterio: la
            # clase que más volumen aporta. None si la zona no tiene ninguna
            # detección activa.
            "claseDominante": max(clases, key=clases.get) if clases else None,
        })
    return stops


# =============================================================================
# SELECCIÓN DE ORIGEN(ES) — "mochila" de puntos por capacidad de camiones
# =============================================================================

def _select_origin_group(points: list[dict], total_volume: float) -> list[dict] | None:
    """Elige el subconjunto MÁS CHICO de puntos activos (ya ordenados por
    cercanía a las zonas, ver caller) cuya capacidad de camiones cubre
    `total_volume`. Prueba tamaños crecientes (1, 2, 3, ...) — con la
    cantidad de puntos que maneja este proyecto (unos pocos), fuerza bruta
    sobre itertools.combinations es instantánea."""
    candidates = [p for p in points if _point_truck_capacity(p) > 0]
    if not candidates:
        return None
    for size in range(1, len(candidates) + 1):
        for combo in itertools.combinations(candidates, size):
            if sum(_point_truck_capacity(p) for p in combo) >= total_volume:
                return list(combo)
    return None


def _split_stops_by_nearest(points: list[dict], stops: list[dict]) -> dict[str, list[dict]]:
    """Reparte cada zona al punto más cercano (línea recta) dentro del
    grupo elegido, con un rebalanceo simple: si un punto queda con más
    volumen asignado del que sus camiones soportan, mueve su zona más
    lejana al siguiente punto con margen — hasta que todos calcen o no
    quede movimiento posible (caller trata cada sub-grupo restante por su
    cuenta, _build_subroute vuelve a fallar si de verdad no alcanza)."""
    assignment: dict[str, list[dict]] = {str(p["_id"]): [] for p in points}
    for s in stops:
        nearest = min(points, key=lambda p: _haversine((p["lat"], p["lng"]), (s["lat"], s["lng"])))
        assignment[str(nearest["_id"])].append(s)

    capacity = {str(p["_id"]): _point_truck_capacity(p) for p in points}

    def volume_of(pid: str) -> float:
        return sum(s["volumeM3"] for s in assignment[pid])

    changed = True
    while changed:
        changed = False
        for p in points:
            pid = str(p["_id"])
            if volume_of(pid) <= capacity[pid]:
                continue
            overloaded_stops = sorted(
                assignment[pid],
                key=lambda s: -_haversine((p["lat"], p["lng"]), (s["lat"], s["lng"])),
            )
            for s in overloaded_stops:
                for other in sorted(points, key=lambda o: _haversine((o["lat"], o["lng"]), (s["lat"], s["lng"]))):
                    oid = str(other["_id"])
                    if oid == pid or volume_of(oid) + s["volumeM3"] > capacity[oid]:
                        continue
                    assignment[pid].remove(s)
                    assignment[oid].append(s)
                    changed = True
                    break
                if changed:
                    break
            if changed:
                break
    return assignment


# =============================================================================
# ORDEN DE PARADAS (TSP acotado) + GEOMETRÍA REAL POR SUB-RUTA
# =============================================================================

# Camión cargado ≈ 85% de la velocidad del vacío. Se llamaba
# _RETURN_SPEED_FACTOR mientras el tramo cargado era el de vuelta a la base;
# ahora el cargado es el que va de la última zona al relleno, y el de vuelta
# desde el relleno a la base se hace vacío, a velocidad normal.
_LOADED_SPEED_FACTOR = 0.85
_MAX_STOPS_BRUTE_FORCE = 8  # 8! = 40320 permutaciones, instantáneo

# =============================================================================
# SITIO DE DISPOSICIÓN FINAL
#
# La Municipalidad de Maipú lo confirmó por escrito el 30-09-2026: "Se descarga
# en el Relleno Sanitario Santiago Poniente. Dependiendo de la ruta asignada, el
# camión debe volver a concluirla, o bien, llegar a la base si concluye el turno
# o la hora de colación."
#
# Hasta ahora el ruteo calculaba base -> zonas -> base, o sea el camión volvía
# cargado al patio, que no es lo que ocurre. Ahora calcula
# base -> zonas -> relleno -> base.
#
# **Y para los planes que este sistema genera, esa geometría es exacta, no una
# aproximación.** Lo que la municipalidad describe como "volver a concluir la
# ruta" son los viajes intermedios de un camión que se llena a mitad de camino,
# y eso acá no puede pasar: el handler solo deja entrar al plan las zonas cuyo
# volumen cabe en la capacidad despachada, así que la carga llega completa a la
# primera descarga. El día que el plan permita exceder la capacidad con viajes
# múltiples, esto vuelve a ser una simplificación y hay que decirlo.
#
# Duplicado en src/lib/disposalSite.ts, que lo necesita para dibujar el marcador
# antes de que exista una ruta. Si cambia, cambia en los dos. El arreglo de
# fondo es que sea un punto de recursos con su tipo, no una constante.
# =============================================================================

RELLENO_SANITARIO_NOMBRE = "Relleno Sanitario Santiago Poniente"
RELLENO_SANITARIO = (-33.521018456153946, -70.86714285793538)


async def _best_stop_order(
    origin: tuple[float, float],
    stop_coords: list[tuple[float, float]],
    autonomia_km: float | None = None,
) -> tuple[list[int], float, float, float] | None | str:
    """Evalúa todas las permutaciones de `stop_coords` (fuerza bruta hasta
    _MAX_STOPS_BRUTE_FORCE, vecino-más-cercano por encima de eso) usando la
    matriz real de OSRM, y devuelve el mejor orden con los tres tiempos del
    recorrido: (orden de índices 1-based, ida, descarga, regreso) en segundos.
    None si OSRM no responde.

    **El relleno entra en la matriz como un nodo más**, así que el orden elegido
    ya tiene en cuenta dónde termina el recorrido: con la base y el relleno en
    extremos distintos de la comuna, el mejor orden sin contar la descarga puede
    no ser el mejor contándola. Sigue siendo UNA sola llamada a OSRM, porque la
    matriz se pide completa de una vez y la búsqueda es aritmética sobre ella.

    **AC3 de HDU5.1**: con `autonomia_km`, se descartan las permutaciones cuya
    distancia total supere ese rango. El criterio lo pide con esas palabras,
    "descartará cualquier ORDEN cuya distancia total (ida y vuelta) supere ese
    rango", y por eso el filtro vive acá y no afuera: sacar zonas sería
    responder una pregunta distinta. Solo cuando NINGÚN orden cabe se devuelve
    "sin_autonomia" y el handler recién entonces saca una zona (AC6).

    Devuelve "sin_autonomia" (str) en ese caso, para distinguirlo de None, que
    significa que OSRM no respondió. Son dos problemas distintos: uno es una
    restricción que se cumplió y el otro es un servicio caído."""
    all_points = [origin] + stop_coords + [RELLENO_SANITARIO]
    matrix = await asyncio.to_thread(osrm_client.table_matrix, all_points)
    if matrix is None:
        return None
    durations = matrix["durations"]
    # Ya venían en la misma respuesta (table_matrix pide
    # annotations=duration,distance), solo que nadie las usaba. El AC3 no
    # agrega ni una llamada.
    distances = matrix["distances"]

    n = len(stop_coords)
    indices = list(range(1, n + 1))
    relleno = n + 1  # último punto de la matriz

    def orders_to_try():
        if n <= _MAX_STOPS_BRUTE_FORCE:
            yield from itertools.permutations(indices)
            return
        # Vecino más cercano — heurística, no óptimo exacto, pero evita una
        # explosión combinatoria si algún día hay muchas zonas en una ruta.
        remaining = set(indices)
        order: list[int] = []
        current = 0
        while remaining:
            nxt = min(remaining, key=lambda i: durations[current][i])
            order.append(nxt)
            remaining.remove(nxt)
            current = nxt
        yield tuple(order)

    # El regreso sale del relleno y es el mismo para toda permutación, pero se
    # suma igual al total: si no, se compararían recorridos incompletos.
    regreso = durations[relleno][0]
    regreso_m = distances[relleno][0]
    limite_m = autonomia_km * 1000 if autonomia_km else None

    best_order: tuple[int, ...] | None = None
    best_total = None
    best_ida = best_descarga = 0.0
    hubo_candidatos = False
    for order in orders_to_try():
        ida = 0.0
        ida_m = 0.0
        prev = 0
        for idx in order:
            ida += durations[prev][idx]
            ida_m += distances[prev][idx]
            prev = idx
        # Cargado desde la última zona hasta el relleno. La ida va a velocidad
        # normal porque el camión se va llenando recién en el camino, y el
        # regreso también, porque vuelve vacío.
        descarga = durations[prev][relleno] / _LOADED_SPEED_FACTOR
        # AC3: el recorrido COMPLETO, que con el relleno son tres tramos. El
        # criterio dice "ida y vuelta", o sea todo lo que el camión maneja antes
        # de volver al patio.
        if limite_m is not None and ida_m + distances[prev][relleno] + regreso_m > limite_m:
            continue
        hubo_candidatos = True
        total = ida + descarga + regreso
        if best_total is None or total < best_total:
            best_total, best_order, best_ida, best_descarga = total, order, ida, descarga

    if not hubo_candidatos:
        return "sin_autonomia"

    assert best_order is not None
    return list(best_order), best_ida, best_descarga, regreso


async def _build_subroute(
    point: dict,
    point_stops: list[dict],
    available_hours: float,
    clase_preferida: str | None = None,
) -> dict | None:
    """Arma la ida+vuelta completa desde `point` por `point_stops` — orden
    óptimo, geometría real (calles) de cada tramo, y chequeo de
    availableHours.

    Devuelve None cuando OSRM falla, y un dict con una bandera cuando el
    recorrido se armó pero no cumple una restricción: `excedeHoras` (no cabe en
    la jornada) o `excedeAutonomia` (AC3, ningún orden cabe en el rango del
    vehículo). **Antes todo eso devolvía None**, y el handler no podía
    distinguirlo: un servicio caído y una restricción que se cumplió son
    problemas distintos, el primero es un error y el segundo es una zona que hay
    que dejar fuera con su motivo (AC6)."""
    origin = (point["lat"], point["lng"])
    stop_coords = [(s["lat"], s["lng"]) for s in point_stops]

    # Qué camiones van se decide ANTES de evaluar el recorrido, y no al final
    # como estaba. No es una optimización: la autonomía que limita (AC3) es la
    # de estos camiones, así que hay que conocerlos para poder filtrar órdenes.
    # El conjunto depende solo del volumen asignado, que ya se conoce acá.
    # AC4: el peso y la clase dominante del conjunto. La clase que manda es la
    # que más volumen aporta SUMANDO todas las paradas de esta sub-ruta, no la
    # de una zona suelta: los camiones se despachan por recorrido, así que la
    # pregunta "qué residuo lleva este camión" se responde sobre todo lo que va
    # a cargar.
    clases_sub: dict[str, float] = {}
    for z in point_stops:
        for clase, vol in (z.get("clasesPorVolumen") or {}).items():
            clases_sub[clase] = clases_sub.get(clase, 0) + vol
    clase_dominante = max(clases_sub, key=clases_sub.get) if clases_sub else None
    # El trabajador manda sobre el cálculo: si eligió un tipo prioritario en el
    # diálogo, esa es la clase contra la que se busca vehículo compatible. Es
    # una decisión suya sobre qué residuo importa hoy, y el sistema no tiene
    # cómo saberla.
    if clase_preferida:
        clase_dominante = clase_preferida

    camiones = _trucks_used(
        point,
        sum(s["volumeM3"] for s in point_stops),
        sum(s.get("weightTon", 0) for s in point_stops),
        clase_dominante,
    )
    if not camiones:
        # Ninguna regla dura dejó candidatos. No es un fallo del servicio ni un
        # problema de capacidad: es el AC4 diciendo que esta carga no la puede
        # llevar ningún vehículo del punto.
        return {
            "sinVehiculoCompatible": True,
            "clase": clase_dominante,
            "pesoTon": sum(s.get("weightTon", 0) for s in point_stops),
        }

    # El rango que manda es el MÍNIMO de los despachados: si uno se queda sin
    # combustible, el recorrido no se completa. Los que no la declaran (None) no
    # limitan, y si ninguno la declara no hay filtro, que es el caso de
    # producción: la municipalidad respondió que esa restricción no existe en su
    # flota.
    autonomias = [c["autonomia_km"] for c in camiones if c.get("autonomia_km")]
    autonomia_km = min(autonomias) if autonomias else None

    order_result = await _best_stop_order(origin, stop_coords, autonomia_km)
    if order_result is None:
        return None
    if order_result == "sin_autonomia":
        return {"excedeAutonomia": True, "autonomiaKm": autonomia_km}
    order, ida_seconds, descarga_seconds, regreso_seconds = order_result

    total_hours = (ida_seconds + descarga_seconds + regreso_seconds) / 3600
    if total_hours > available_hours:
        # No es un fallo del servicio: el recorrido existe y es demasiado largo.
        # El handler lo resuelve sacando la parada más lejana y reintentando.
        return {"excedeHoras": True, "horas": total_hours}

    ordered_stops = [point_stops[i - 1] for i in order]
    ultima = (ordered_stops[-1]["lat"], ordered_stops[-1]["lng"])

    # Tres tramos, no dos: la carga se descarga en el relleno y el camión
    # recién después vuelve al patio. Las tres geometrías se piden en paralelo,
    # así que agregar la descarga no agrega latencia, solo una llamada.
    outbound_coords = [origin] + [(s["lat"], s["lng"]) for s in ordered_stops]
    disposal_coords = [ultima, RELLENO_SANITARIO]
    return_coords = [RELLENO_SANITARIO, origin]
    outbound_geo, disposal_geo, return_geo = await asyncio.gather(
        asyncio.to_thread(osrm_client.route_geometry, outbound_coords),
        asyncio.to_thread(osrm_client.route_geometry, disposal_coords),
        asyncio.to_thread(osrm_client.route_geometry, return_coords),
    )
    if outbound_geo is None or disposal_geo is None or return_geo is None:
        return None

    # Duraciones "reales" (de la geometría final que se va a dibujar, no del
    # estimado de la matriz, que solo sirvió para elegir el orden). El factor de
    # carga se aplica al tramo de descarga, el mismo que ya se usó para decidir
    # factibilidad, para no mostrar un número "a velocidad de vacío" que
    # contradiga por qué ese tramo se calcula más lento.
    outbound_hours = outbound_geo["durationHours"]
    disposal_hours = disposal_geo["durationHours"] / _LOADED_SPEED_FACTOR
    return_hours = return_geo["durationHours"]

    return {
        "originName": point.get("name", ""),
        # Los camiones elegidos viajan enteros, no solo su cantidad: el handler
        # necesita la patente y la dotación para el AC7. Se eligieron arriba,
        # antes de evaluar el recorrido.
        "trucks": camiones,
        "stops": ordered_stops,
        "outboundPath": outbound_geo["path"],
        "disposalPath": disposal_geo["path"],
        "returnPath": return_geo["path"],
        "outboundDistanceKm": outbound_geo["distanceKm"],
        "outboundDurationHours": outbound_hours,
        "disposalDistanceKm": disposal_geo["distanceKm"],
        "disposalDurationHours": disposal_hours,
        "returnDistanceKm": return_geo["distanceKm"],
        "returnDurationHours": return_hours,
        "distanceKm": (
            outbound_geo["distanceKm"] + disposal_geo["distanceKm"] + return_geo["distanceKm"]
        ),
        "durationHours": outbound_hours + disposal_hours + return_hours,
    }


# =============================================================================
# ENDPOINT
# =============================================================================

router = APIRouter(prefix="/routes", tags=["routes"])


@router.post("/generate")
async def generate_route(
    payload: RoutePlanRequestIn,
    current_user: auth_module.UserOut = Depends(auth_module.get_current_user),
):
    active_points = await _load_active_points(payload.activePointIds)
    if not active_points:
        return RoutePlanInfeasibleOut(message="No hay puntos activos disponibles para generar la ruta.")

    stops = await _load_route_stops(payload.analysisIds)
    if not stops:
        return RoutePlanInfeasibleOut(message="No hay zonas de basura ubicables para generar la ruta.")

    # La marca de prioridad se cruza contra las zonas que SÍ se pudieron cargar,
    # así que un id marcado que no se pudo ubicar (sin orthoCenter, sin CRS
    # reproyectable) desaparece por sí solo en vez de arrastrarse como una
    # prioridad sobre una zona que no está en el plan.
    prioritarias = set(payload.priorityAnalysisIds)
    for z in stops:
        z["prioritaria"] = z["analysisId"] in prioritarias

    total_volume = sum(s["volumeM3"] for s in stops)
    centroid = (
        sum(s["lat"] for s in stops) / len(stops),
        sum(s["lng"] for s in stops) / len(stops),
    )
    points_by_proximity = sorted(active_points, key=lambda p: _haversine((p["lat"], p["lng"]), centroid))

    # ── AC6 de HDU5.1: el plan se arma con lo que SÍ cabe ────────────────────
    #
    # Antes, cada una de estas situaciones mataba el plan entero con un
    # infeasible: que la capacidad total no alcanzara, que el reparto entre
    # puntos no calzara, o que el recorrido no cupiera en las horas. El criterio
    # pide lo contrario, que las zonas sin vehículo posible queden marcadas "sin
    # asignar" con el motivo SIN invalidar el resto del plan.
    #
    # Las dos salidas por infeasible que sí se conservan están más arriba (sin
    # puntos activos y sin zonas ubicables): ahí no hay nada que armar, y
    # devolver un plan vacío sería peor que decirlo.
    sin_asignar: list[RoutePlanUnassignedOut] = []

    def descartar(zona: dict, motivo: str) -> None:
        # Una zona marcada como prioritaria que igual queda fuera tiene que
        # decirlo en el motivo. El trabajador la marcó justamente para que no
        # pasara; si el plan la descarta con el mismo texto que a cualquier otra,
        # se enteraría solo comparando su propia marca contra la lista, que es
        # exactamente el trabajo que la marca venía a ahorrarle.
        if zona.get("prioritaria"):
            motivo = f"{motivo} Estaba marcada como prioritaria."
        sin_asignar.append(RoutePlanUnassignedOut(
            analysisId=zona["analysisId"], name=zona["name"], reason=motivo
        ))

    # Paso 1, la capacidad. Se elige el grupo de puntos que más volumen cubre y
    # se llenan sus camiones con las zonas que caben.
    #
    # El orden de llenado es por volumen ASCENDENTE, y es una decisión de
    # negocio, no técnica: el objetivo municipal es eliminar microbasurales, así
    # que entran más zonas por jornada atendiendo primero las chicas. Llenando
    # por volumen descendente se retiraría más material en menos paradas. La
    # zona grande que queda fuera no se pierde de vista: aparece en la lista de
    # sin asignar con su motivo, y el trabajador puede generarla sola.
    #
    # Las marcadas como prioritarias van PRIMERO, y entre ellas sigue rigiendo el
    # mismo orden ascendente. Esto es lo que hace que la marca signifique algo:
    # sin ella, una zona urgente que además es grande es la primera candidata a
    # quedar fuera, precisamente al revés de lo que se quería.
    origin_group = _select_origin_group(points_by_proximity, total_volume)
    if origin_group is None:
        # Ningún conjunto cubre el volumen completo: se usan todos los puntos
        # activos y se recorta la carga, en vez de no hacer nada.
        origin_group = [p for p in points_by_proximity if _point_truck_capacity(p) > 0]

    capacidad_total = sum(_point_truck_capacity(p) for p in origin_group)
    if not origin_group or capacidad_total <= 0:
        return RoutePlanInfeasibleOut(
            message=(
                "Ningún punto activo tiene vehículos disponibles con capacidad declarada. "
                "Revisa los recursos del punto antes de generar la ruta."
            )
        )

    stops_que_caben: list[dict] = []
    acumulado = 0.0
    for zona in sorted(stops, key=lambda z: (not z["prioritaria"], z["volumeM3"])):
        if acumulado + zona["volumeM3"] <= capacidad_total:
            stops_que_caben.append(zona)
            acumulado += zona["volumeM3"]
        else:
            descartar(
                zona,
                f"La capacidad disponible ({_format_number(capacidad_total)} m³) no alcanza "
                f"para esta zona.",
            )

    if not stops_que_caben:
        return RoutePlanInfeasibleOut(
            message=(
                f"Ninguna zona cargada cabe en la capacidad disponible "
                f"({_format_number(capacidad_total)} m³)."
            )
        )

    if len(origin_group) == 1:
        # Copia: más abajo se le quitan paradas con .remove() al relajar por
        # horas, y sin copiar se estaría mutando la misma lista que acaba de
        # servir para decidir qué cabía.
        stops_by_point = {str(origin_group[0]["_id"]): list(stops_que_caben)}
    else:
        stops_by_point = _split_stops_by_nearest(origin_group, stops_que_caben)

    sub_routes: list[dict] = []
    for point in origin_group:
        point_stops = stops_by_point.get(str(point["_id"]), [])
        if not point_stops:
            continue

        # Paso 2, el reparto. _split_stops_by_nearest es una heurística y puede
        # dejar un punto por sobre su propia capacidad aunque la del grupo
        # alcance. Antes eso devolvía infeasible; ahora se recorta ese punto.
        capacidad_punto = _point_truck_capacity(point)
        asignado = sum(s["volumeM3"] for s in point_stops)
        while point_stops and asignado > capacidad_punto:
            # `not prioritaria` delante del volumen en la clave de `max` es lo que
            # hace que una prioritaria sea la ÚLTIMA en salir: las no prioritarias
            # puntúan 1 y las marcadas 0, así que se recorta entre las no
            # marcadas (y de ellas, la más grande) mientras quede alguna. Si todas
            # las que quedan están marcadas, empatan en 0 y el criterio vuelve a
            # ser el volumen: la marca no puede volver imposible un recorte que de
            # todos modos hay que hacer.
            fuera = max(point_stops, key=lambda z: (not z["prioritaria"], z["volumeM3"]))
            point_stops.remove(fuera)
            asignado -= fuera["volumeM3"]
            descartar(
                fuera,
                f'El reparto dejó esta zona fuera de la capacidad de "{point.get("name", "el punto")}" '
                f"({_format_number(capacidad_punto)} m³).",
            )
        if not point_stops:
            continue

        # Paso 3, las horas y la autonomía. Se saca la parada más lejana del
        # punto y se reintenta, hasta que el recorrido quepa o no queden
        # paradas. Es la relajación que convierte "no se pudo" en "esto sí,
        # esto no".
        #
        # Las dos restricciones comparten el bucle pero NO el motivo: la
        # descripción de HDU5.1 pide que el sistema "pueda distinguir cuál fue
        # el motivo en cada caso", así que cada una escribe el suyo.
        while point_stops:
            result = await _build_subroute(
                point, point_stops, payload.availableHours, payload.priorityWasteType
            )
            if result is None:
                # OSRM no respondió. Esto NO es una zona sin asignar: es un
                # servicio caído, y fingir un plan parcial escondería la causa.
                return RoutePlanInfeasibleOut(
                    message=(
                        f'El servicio de ruteo no respondió al calcular el recorrido desde '
                        f'"{point.get("name", "un punto")}". Intenta nuevamente en unos minutos.'
                    )
                )
            if (
                not result.get("excedeHoras")
                and not result.get("excedeAutonomia")
                and not result.get("sinVehiculoCompatible")
            ):
                sub_routes.append(result)
                break
            # Misma precedencia que en el recorte por capacidad: se saca la más
            # lejana DE LAS NO PRIORITARIAS, y solo se toca una marcada cuando no
            # queda ninguna otra.
            lejana = max(
                point_stops,
                key=lambda z: (
                    not z["prioritaria"],
                    _haversine((point["lat"], point["lng"]), (z["lat"], z["lng"])),
                ),
            )
            point_stops.remove(lejana)
            if result.get("sinVehiculoCompatible"):
                # AC4. Dos motivos distintos bajo la misma bandera, y se
                # distinguen: que ningún vehículo aguante el peso no es lo mismo
                # que no haber ninguno habilitado para esta ruta.
                peso = result.get("pesoTon") or 0
                if peso > 0:
                    motivo = (
                        f"Ningún vehículo disponible puede llevar las "
                        f"{_format_number(round(peso, 2))} toneladas de esta carga."
                    )
                else:
                    motivo = "Ningún vehículo disponible puede transportar este residuo."
                descartar(lejana, motivo)
            elif result.get("excedeAutonomia"):
                # AC3. Ningún ORDEN de visita cabía en el rango del vehículo, que
                # es lo que el criterio pide evaluar; recién cuando se agotaron
                # todos los órdenes se saca una zona.
                descartar(
                    lejana,
                    f"Ningún orden de visita cabe en la autonomía del vehículo "
                    f"({_format_number(result['autonomiaKm'])} km).",
                )
            else:
                descartar(
                    lejana,
                    f"No alcanza dentro de las {_format_number(payload.availableHours)} horas "
                    f"disponibles.",
                )

    if not sub_routes:
        return RoutePlanInfeasibleOut(
            message="No fue posible asignar ninguna zona cargada a un punto activo."
        )

    out_stops: list[RoutePlanStopOut] = []
    outbound_paths: list[list[list[float]]] = []
    disposal_paths: list[list[list[float]]] = []
    return_paths: list[list[list[float]]] = []
    segments: list[RouteSegmentOut] = []
    order = 1
    total_distance = 0.0
    total_volume_planificado = 0.0
    max_duration = 0.0  # sub-rutas de puntos distintos corren en paralelo (cuadrillas separadas)
    for sub in sub_routes:
        for s in sub["stops"]:
            out_stops.append(RoutePlanStopOut(
                order=order,
                lat=s["lat"],
                lng=s["lng"],
                label=s["name"],
                analysisId=s.get("analysisId"),
            ))
            order += 1
        outbound_paths.append(sub["outboundPath"])
        disposal_paths.append(sub["disposalPath"])
        return_paths.append(sub["returnPath"])

        # ── AC7 ──
        # Todos los camiones del tramo, cada uno con su identidad y su propia
        # dotación. Antes solo viajaba el vehículo cuando era UNO, y con varios
        # la vista decía "2 camiones" sin decir cuáles.
        camiones = sub.get("trucks", [])
        vehiculos = [
            RoutePlanVehicleOut(
                # La patente es lo que el criterio nombra, pero cuatro unidades
                # de la flota real no la traen cargada; en ese caso el N° de
                # equipo es el identificador que la municipalidad usa en sus
                # propias planillas, así que es el respaldo correcto.
                patente=c.get("patente") or c.get("numeroEquipo", ""),
                tipo=c.get("tipo", ""),
                resourceId=c.get("resourceId"),
                numeroEquipo=c.get("numeroEquipo"),
                capacityM3=c.get("capacity_m3"),
                foto=c.get("foto"),
                crew=_dotacion_de(c),
            )
            for c in camiones
        ]

        segments.append(RouteSegmentOut(
            originName=sub["originName"],
            trucksUsed=len(camiones),
            vehicles=vehiculos,
            disposalName=RELLENO_SANITARIO_NOMBRE,
            disposalDistanceKm=round(sub["disposalDistanceKm"], 2),
            disposalDurationHours=round(sub["disposalDurationHours"], 2),
            outboundDistanceKm=round(sub["outboundDistanceKm"], 2),
            outboundDurationHours=round(sub["outboundDurationHours"], 2),
            returnDistanceKm=round(sub["returnDistanceKm"], 2),
            returnDurationHours=round(sub["returnDurationHours"], 2),
        ))
        total_distance += sub["distanceKm"]
        # Se suma sobre las paradas que QUEDARON en la sub-ruta, no sobre las que
        # se eligieron por capacidad: la relajación por horas saca paradas
        # después de ese reparto, y sumar antes daría un volumen que el plan no
        # mueve.
        total_volume_planificado += sum(s["volumeM3"] for s in sub["stops"])
        max_duration = max(max_duration, sub["durationHours"])

    return RoutePlanSuccessOut(
        route=RoutePlanRouteOut(
            stops=out_stops,
            totalDistanceKm=round(total_distance, 2),
            totalDurationHours=round(max_duration, 2),
            totalVolumeM3=round(total_volume_planificado, 2),
            outboundPaths=outbound_paths,
            disposalPaths=disposal_paths,
            returnPaths=return_paths,
            segments=segments,
            unassignedZones=sin_asignar,
        )
    )
