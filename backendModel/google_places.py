import os

import requests

# =============================================================================
# CONDORFINDER - DIRECCIONES CON GOOGLE (Places + Geocoding)
# Archivo: backendModel/google_places.py
#
# Tres operaciones para ubicar un punto de recurso:
#   - autocompletar(): sugerencias mientras se escribe   (Places Autocomplete)
#   - detalle():       la dirección elegida, con comuna  (Place Details)
#   - direccion_de():  dirección desde una coordenada    (Geocoding inverso)
#   - coordenada_de(): coordenada desde una dirección    (Geocoding directo)
#
# **Todo pasa por el backend, no por el navegador.** Podría llamarse desde el
# cliente y ahorrarse un salto, pero entonces la clave viajaría al navegador y
# habría que mantener una segunda clave restringida por referente. Crear un
# punto de recurso se hace un puñado de veces en la vida del sistema, así que
# la latencia extra no le importa a nadie y la clave se queda en la VM.
#
# **El FIELD MASK de Place Details decide el SKU**, y por eso pide exactamente
# tres campos y ni uno más. `addressComponents`, `formattedAddress` y
# `location` están en `Place Details Essentials` (10.000 gratis al mes, SKU
# 6E05-E1C3-8D85). Agregar reseñas, fotos o cualquier dato de "atmósfera" salta
# a Pro (5.000) o Enterprise (1.000) y triplica el precio por mil. Si alguien
# agrega un campo acá, que mire antes en qué nivel cae.
#
# Nada de esto es obligatorio: sin clave, las cuatro funciones devuelven None y
# `src/lib/geocoding.ts` se queda con Nominatim, que es gratis y no necesita
# cuenta. Mismo criterio que OSRM respaldando a Routes.
# =============================================================================

_AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete"
_DETALLE_URL = "https://places.googleapis.com/v1/places/"
_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
_TIMEOUT_SECONDS = 6

# Las mismas de src/lib/maipuBoundary.ts. Sesgan las sugerencias hacia la
# comuna sin excluir lo de afuera: un punto de recurso podría estar en el
# límite, y un filtro duro lo volvería imposible de encontrar.
_MAIPU_SO = (-33.57185, -70.92998)
_MAIPU_NE = (-33.45821, -70.71836)

# En Chile, Google etiqueta la comuna como administrative_area_level_3. Los
# otros dos son respaldo: algunas direcciones rurales solo traen `locality`, y
# `administrative_area_level_2` es la provincia, que es lo más cercano cuando
# falta todo lo demás. El orden importa y no es alfabético.
_TIPOS_COMUNA = ("administrative_area_level_3", "locality", "administrative_area_level_2")


def disponible() -> bool:
    return bool(os.getenv("GOOGLE_ROUTES_API_KEY"))


def _clave() -> str | None:
    return os.getenv("GOOGLE_ROUTES_API_KEY")


def _comuna_de(componentes: list[dict], campo_tipos: str, campo_texto: str) -> str:
    """La comuna, buscando por tipo en el orden de _TIPOS_COMUNA.

    Toma los nombres de campo por parámetro porque las dos APIs los escriben
    distinto: Places (New) usa camelCase (`types`/`longText`) y Geocoding usa
    snake_case (`types`/`long_name`). Es el mismo algoritmo sobre dos formas."""
    for tipo in _TIPOS_COMUNA:
        for c in componentes:
            if tipo in (c.get(campo_tipos) or []):
                return c.get(campo_texto) or ""
    return ""


def _calle_de(componentes: list[dict], campo_tipos: str, campo_texto: str) -> str:
    """Calle y número, que es como la municipalidad escribe una dirección.

    Se arma por componentes y no se usa `formattedAddress` porque ese trae
    además comuna, región y país, y la comuna ya va en su propio campo del
    formulario: pegarla dos veces daría "San Martín 2730, Maipú, Maipú"."""
    calle = numero = ""
    for c in componentes:
        tipos = c.get(campo_tipos) or []
        if "route" in tipos:
            calle = c.get(campo_texto) or ""
        elif "street_number" in tipos:
            numero = c.get(campo_texto) or ""
    return f"{calle} {numero}".strip()


def autocompletar(texto: str) -> list[dict] | None:
    """Sugerencias de dirección mientras se escribe.

    Devuelve [{"placeId": str, "texto": str}], o None si no se pudo. Se cobra
    POR SOLICITUD (SKU 4EF4-B17C-B31A, 10.000 gratis al mes), no por sesión, así
    que el antirrebote del lado del cliente es lo que mantiene el consumo bajo:
    sin él sería una solicitud por tecla."""
    clave = _clave()
    if not clave or len(texto.strip()) < 3:
        return None
    try:
        r = requests.post(
            _AUTOCOMPLETE_URL,
            json={
                "input": texto,
                # Solo Chile. Sin esto, "San Martín" trae resultados de
                # Argentina, que es donde más hay con ese nombre.
                "includedRegionCodes": ["cl"],
                "locationBias": {
                    "rectangle": {
                        "low": {"latitude": _MAIPU_SO[0], "longitude": _MAIPU_SO[1]},
                        "high": {"latitude": _MAIPU_NE[0], "longitude": _MAIPU_NE[1]},
                    }
                },
                "languageCode": "es",
            },
            headers={"X-Goog-Api-Key": clave},
            timeout=_TIMEOUT_SECONDS,
        )
        r.raise_for_status()
        salida = []
        for s in r.json().get("suggestions") or []:
            pred = s.get("placePrediction") or {}
            pid = pred.get("placeId")
            txt = (pred.get("text") or {}).get("text")
            if pid and txt:
                salida.append({"placeId": pid, "texto": txt})
        return salida
    except Exception:
        return None


def detalle(place_id: str) -> dict | None:
    """La dirección elegida: calle y número, comuna y coordenada.

    El field mask pide SOLO los tres campos de Essentials. Ver el comentario de
    cabecera antes de agregarle uno."""
    clave = _clave()
    if not clave or not place_id:
        return None
    try:
        r = requests.get(
            _DETALLE_URL + place_id,
            headers={
                "X-Goog-Api-Key": clave,
                "X-Goog-FieldMask": "addressComponents,formattedAddress,location",
            },
            params={"languageCode": "es"},
            timeout=_TIMEOUT_SECONDS,
        )
        r.raise_for_status()
        d = r.json()
        comps = d.get("addressComponents") or []
        loc = d.get("location") or {}
        if "latitude" not in loc or "longitude" not in loc:
            return None
        return {
            "address": _calle_de(comps, "types", "longText") or d.get("formattedAddress", ""),
            "comuna": _comuna_de(comps, "types", "longText"),
            "lat": loc["latitude"],
            "lng": loc["longitude"],
        }
    except Exception:
        return None


def direccion_de(lat: float, lng: float) -> dict | None:
    """Geocodificación INVERSA: qué dirección hay en esa coordenada.

    Es lo que se dispara al clickear el mapa. Devuelve {"address", "comuna"}."""
    clave = _clave()
    if not clave:
        return None
    try:
        r = requests.get(
            _GEOCODE_URL,
            params={"latlng": f"{lat},{lng}", "language": "es", "key": clave},
            timeout=_TIMEOUT_SECONDS,
        )
        r.raise_for_status()
        d = r.json()
        if d.get("status") != "OK" or not d.get("results"):
            return None
        comps = d["results"][0].get("address_components") or []
        address = _calle_de(comps, "types", "long_name")
        comuna = _comuna_de(comps, "types", "long_name")
        if not address and not comuna:
            return None
        return {"address": address, "comuna": comuna}
    except Exception:
        return None


def coordenada_de(direccion: str) -> dict | None:
    """Geocodificación DIRECTA: dónde queda esa dirección escrita a mano.

    Es el camino inverso, para cuando alguien escribe sin usar las sugerencias.
    Devuelve {"lat", "lng", "address", "comuna"}.

    **La comuna viaja en la MISMA respuesta y no cuesta nada**: Geocoding manda
    los `address_components` igual, y antes se descartaban. Sin eso, escribir
    una dirección movía el marcador pero dejaba la comuna como estuviera, y
    había que corregirla a mano aunque el servicio supiera cuál era."""
    clave = _clave()
    if not clave or not direccion.strip():
        return None
    try:
        r = requests.get(
            _GEOCODE_URL,
            params={
                "address": direccion,
                # Acota a Chile por el mismo motivo que el autocompletado.
                "components": "country:CL",
                "language": "es",
                "key": clave,
            },
            timeout=_TIMEOUT_SECONDS,
        )
        r.raise_for_status()
        d = r.json()
        if d.get("status") != "OK" or not d.get("results"):
            return None
        primero = d["results"][0]
        loc = (primero.get("geometry") or {}).get("location") or {}
        if "lat" not in loc or "lng" not in loc:
            return None
        comps = primero.get("address_components") or []
        return {
            "lat": loc["lat"],
            "lng": loc["lng"],
            "address": _calle_de(comps, "types", "long_name"),
            "comuna": _comuna_de(comps, "types", "long_name"),
        }
    except Exception:
        return None
