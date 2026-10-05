import os

import requests

# =============================================================================
# CONDORFINDER - CLIENTE GOOGLE ROUTES (HDU5.1 / AC5)
# Archivo: backendModel/google_routes_client.py
#
# El AC5 pide que los tiempos del plan consideren el tráfico actual. OSRM
# calcula a flujo libre por diseño (no tiene datos de tráfico), así que ningún
# ajuste local lo arregla: hace falta un proveedor que los tenga.
#
# UNA llamada por recorrido, no tres. `computeRoutes` acepta paradas
# intermedias y devuelve `legs[]` con duración, distancia y polilínea POR
# TRAMO, así que `origen -> zonas -> relleno -> origen` vuelve con los tres
# tramos separados en una sola petición. Eso es lo que el mapa necesita para
# pintarlos distinto y lo que _LOADED_SPEED_FACTOR necesita para aplicarse solo
# a la descarga. Son 5.000 generaciones gratis al mes en vez de 1.666, y además
# es más correcto: un cálculo de ruta en vez de tres tramos calculados por
# separado.
#
# SIN REINTENTOS, a propósito. Si Google falla, routes_provider.py cae a OSRM.
# Un reintento automático es justo el mecanismo por el que el consumo se dispara
# cuando el servicio del otro lado está lento, y acá cada llamada se cobra.
#
# El techo de costo NO lo pone este archivo: lo pone la cuota diaria de 160
# solicitudes configurada en GCP (160 x 31 = 4.960 < 5.000 del tramo gratuito).
# Es externa al código justo para que ningún bug pueda superarla.
#
# `routingPreference: TRAFFIC_AWARE` es lo que activa el tráfico, y es también
# lo que sube la petición al SKU `Compute Routes Pro` (5.000 gratis/mes en vez
# de los 10.000 de Essentials).
# =============================================================================

_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes"
# El mismo que OSRM: si el proveedor con tráfico tarda más que el de flujo
# libre, el trabajador espera igual, y la respuesta ya no sirve.
_TIMEOUT_SECONDS = 8
# Tope de la API para paradas intermedias. Por encima de esto no se intenta
# (devuelve None y se usa OSRM) en vez de gastar una llamada que va a fallar.
_MAX_INTERMEDIOS = 25


def disponible() -> bool:
    """True si hay clave configurada. Sin ella este módulo no se usa nunca y el
    sistema sigue funcionando con OSRM, que es lo que permite que cualquiera del
    equipo corra el backend sin tener una clave de Google."""
    return bool(os.getenv("GOOGLE_ROUTES_API_KEY"))


def _waypoint(punto: tuple[float, float]) -> dict:
    lat, lng = punto
    return {"location": {"latLng": {"latitude": lat, "longitude": lng}}}


def _decodificar_polilinea(encoded: str) -> list[list[float]]:
    """Decodifica el formato de polilínea codificada de Google a [[lat, lng], ...].

    Se escribe a mano en vez de sumar una dependencia: son treinta líneas y el
    algoritmo está congelado desde 2006. Cada coordenada viene como diferencia
    respecto de la anterior, en incrementos de 1e-5 grados, codificada en base64
    de a 5 bits con el bit más alto indicando continuación, y con el signo en el
    bit más bajo (complemento a uno si es negativo)."""
    coords: list[list[float]] = []
    indice = 0
    lat = 0
    lng = 0
    largo = len(encoded)

    while indice < largo:
        for eje in range(2):
            resultado = 0
            desplazamiento = 0
            while True:
                if indice >= largo:
                    # Cadena truncada: se devuelve lo que se pudo leer en vez de
                    # reventar, porque el llamador ya sabe tratar una geometría
                    # vacía como "no se pudo calcular".
                    return coords
                byte = ord(encoded[indice]) - 63
                indice += 1
                resultado |= (byte & 0x1F) << desplazamiento
                desplazamiento += 5
                if byte < 0x20:
                    break
            delta = ~(resultado >> 1) if resultado & 1 else (resultado >> 1)
            if eje == 0:
                lat += delta
            else:
                lng += delta
        coords.append([lat / 1e5, lng / 1e5])

    return coords


def _tramo(leg: dict) -> dict | None:
    """Un `leg` de la respuesta al mismo dict que devuelve osrm_client.route_geometry,
    para que routing.py no sepa de dónde vino la geometría.

    **Un tramo de longitud CERO llega con los campos AUSENTES, no en cero.** La
    respuesta es protobuf serializado a JSON y proto3 omite los valores por
    omisión, así que `{"distanceMeters": 0}` viaja como nada. Pasa de verdad:
    dos zonas capturadas sobre el mismo terreno quedan en la misma coordenada y
    el salto entre ellas mide cero.

    Leerlo con `leg["distanceMeters"]` levantaba KeyError, esta función devolvía
    None y el llamador descartaba la respuesta ENTERA de Google, cayendo a OSRM.
    El síntoma era desconcertante: el plan salía bien pero con tiempos sin
    tráfico, idénticos a los de OSRM, sin ningún error a la vista."""
    try:
        # La duración llega como un Duration de protobuf serializado: "1234s".
        segundos = float(str(leg.get("duration") or "0s").rstrip("s"))
        metros = float(leg.get("distanceMeters") or 0)
    except (TypeError, ValueError):
        return None

    encoded = (leg.get("polyline") or {}).get("encodedPolyline") or ""
    path = _decodificar_polilinea(encoded) if encoded else []

    # Sin geometría pero CON cifras es una respuesta rota y hay que rechazarla.
    # Sin geometría y sin cifras es un salto nulo, que es legítimo: aporta cero
    # al trazo y mantiene una fila por parada en la línea de tiempo.
    if not path and (metros > 0 or segundos > 0):
        return None

    return {
        "path": path,
        "distanceKm": metros / 1000,
        "durationHours": segundos / 3600,
    }


def _unir(tramos: list[dict]) -> dict:
    """Varios legs consecutivos en uno. La ida son N legs (uno por parada) y el
    mapa la pinta como un solo trazo, así que se concatenan las geometrías y se
    suman las cifras. El primer punto de cada leg repite el último del anterior,
    y se descarta para no dejar vértices duplicados en la línea."""
    path: list[list[float]] = []
    for t in tramos:
        # El corte del primer vértice depende de si YA hay trazo acumulado, no
        # de la posición del tramo en la lista: un salto nulo al principio deja
        # el acumulado vacío, y ahí cortarle el primer punto al siguiente
        # perdería el vértice donde empieza el recorrido.
        path.extend(t["path"] if not path else t["path"][1:])
    return {
        "path": path,
        "distanceKm": sum(t["distanceKm"] for t in tramos),
        "durationHours": sum(t["durationHours"] for t in tramos),
    }


def route_tramos(
    origin: tuple[float, float],
    stops: list[tuple[float, float]],
    disposal: tuple[float, float],
) -> dict | None:
    """Los tres tramos de `origen -> stops (en orden) -> relleno -> origen`, con
    tiempos que consideran el tráfico del momento (AC5).

    Devuelve {"outbound": t, "disposal": t, "return": t} donde cada `t` tiene la
    misma forma que osrm_client.route_geometry (path/distanceKm/durationHours),
    o None si no se pudo. None significa "usá OSRM": no se reintenta."""
    clave = os.getenv("GOOGLE_ROUTES_API_KEY")
    if not clave or not stops:
        return None

    # Las paradas más el relleno. El origen es también el destino.
    intermedios = [*stops, disposal]
    if len(intermedios) > _MAX_INTERMEDIOS:
        return None

    cuerpo = {
        "origin": _waypoint(origin),
        "destination": _waypoint(origin),
        "intermediates": [_waypoint(p) for p in intermedios],
        "travelMode": "DRIVE",
        # Lo que hace que los tiempos sean con tráfico. Sin esto la respuesta
        # sería flujo libre, o sea lo mismo que OSRM pero pagando.
        "routingPreference": "TRAFFIC_AWARE",
        # El orden lo decide _best_stop_order con la matriz de OSRM, que es
        # gratis. Dejar que Google lo reordene además cambiaría el SKU y
        # descartaría el filtro de autonomía del AC3, que se aplica sobre el
        # orden elegido.
        "optimizeWaypointOrder": False,
        "languageCode": "es-CL",
        "units": "METRIC",
    }

    # La máscara de campos es obligatoria y acota la respuesta a lo que se usa.
    # Sin `routes.legs.steps`, que son las indicaciones giro por giro: no se
    # muestran en ninguna parte y multiplican el tamaño de la respuesta.
    mascara = ",".join(
        [
            "routes.legs.duration",
            "routes.legs.distanceMeters",
            "routes.legs.polyline.encodedPolyline",
        ]
    )

    try:
        resp = requests.post(
            _ENDPOINT,
            json=cuerpo,
            headers={"X-Goog-Api-Key": clave, "X-Goog-FieldMask": mascara},
            timeout=_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        rutas = resp.json().get("routes") or []
        if not rutas:
            return None
        legs = rutas[0].get("legs") or []
    except Exception:
        # Clave inválida, cuota agotada (429), servicio caído, timeout: todo
        # termina acá y el llamador usa OSRM. No se distingue el motivo porque
        # la respuesta es la misma, y reintentar es exactamente lo que no se
        # quiere hacer contra una API que se cobra por llamada.
        return None

    # origen -> stop1 .. stopN -> relleno -> origen son N+2 tramos.
    if len(legs) != len(stops) + 2:
        return None

    tramos = [_tramo(leg) for leg in legs]
    if any(t is None for t in tramos):
        return None

    return {
        "outbound": _unir(tramos[: len(stops)]),
        "disposal": tramos[len(stops)],
        "return": tramos[len(stops) + 1],
        # Los saltos de la ida SIN fusionar: origen->z1, z1->z2, ... Son los
        # mismos legs que acaban de unirse para el trazo del mapa, pero la línea
        # de tiempo necesita el detalle y venía en la misma respuesta. Fusionar
        # sin conservarlos era tirar el dato por el que ya se pagó, y es lo que
        # dejaba las conexiones entre zonas sin tiempo.
        "hops": [
            {"distanceKm": t["distanceKm"], "durationHours": t["durationHours"]}
            for t in tramos[: len(stops)]
        ],
    }
