import math
import os

import requests

# =============================================================================
# CONDORFINDER - FOTO REAL DE UN PUNTO DE RECURSO (Street View Static)
# Archivo: backendModel/street_view.py
#
# La lista de puntos mostraba un marcador genérico donde debería estar el lugar.
# Esto trae la foto de la calle, que es lo que permite reconocer el patio sin
# ir a verlo.
#
# **UNA solicitud por punto, para toda la vida del sistema.** La imagen se pide
# al crear o mover el punto, se guarda en disco junto a las fotos de la flota, y
# la interfaz nunca vuelve a llamar a Google. Un punto de origen no se muda, así
# que no hay nada que refrescar. Esa es la diferencia entre 1 solicitud y 1 por
# cada vez que alguien abre la lista.
#
# Se pide al tamaño MÁXIMO (640x640 con scale=2) y el mismo archivo sirve para
# la miniatura y para el diálogo ampliado, escalado con CSS. Pedir una versión
# grande aparte sería otra URL y por lo tanto otra solicitud cobrada.
#
# La METADATA es gratis e ilimitada (SKU 3168-48A9-5C8C) y se consulta SIEMPRE
# primero: dice si hay cobertura en esa coordenada. Sin ese paso se paga una
# foto gris cada vez que alguien ubica un punto donde el auto de Google nunca
# pasó, que en un patio municipal o un camino rural es perfectamente posible.
#
# Vive en disco y no en GCS, igual que las 13 fotos de la flota (ver
# upload_resource_photo en resources.py): el directorio está montado desde el
# host en docker-compose.yml, así que sobrevive a los redespliegues. Y si
# alguna vez se perdiera, recuperarla cuesta una solicitud del tramo gratuito.
# =============================================================================

_METADATA_URL = "https://maps.googleapis.com/maps/api/streetview/metadata"
_IMAGEN_URL = "https://maps.googleapis.com/maps/api/streetview"
_TIMEOUT_SECONDS = 8

# El máximo que acepta la API sin firmar. scale=2 duplica la densidad de
# píxeles para pantallas retina sin cambiar el SKU.
_TAMANO = "640x640"
_FOV = 80  # grados; más abierto que el default de 90 encuadra mejor una fachada


def disponible() -> bool:
    """True si hay clave configurada. Sin ella el punto se crea igual, sin foto:
    esto es un adorno informativo, no un requisito para operar."""
    return bool(os.getenv("GOOGLE_ROUTES_API_KEY"))


def _rumbo(desde: tuple[float, float], hacia: tuple[float, float]) -> float:
    """Rumbo en grados desde un punto hacia otro, 0 = norte.

    Hace falta porque la panorámica NO está en la coordenada del punto sino en
    la calle más cercana, a veces a media cuadra. Sin orientar la cámara, la
    foto sale mirando hacia donde el auto de Google venía manejando, que puede
    ser la vereda de enfrente o un paredón. Con el rumbo calculado, mira al
    lugar."""
    lat1, lon1 = math.radians(desde[0]), math.radians(desde[1])
    lat2, lon2 = math.radians(hacia[0]), math.radians(hacia[1])
    dlon = lon2 - lon1
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def foto_de(lat: float, lng: float) -> bytes | None:
    """La foto de Street View del lugar, o None si no hay cobertura o falla algo.

    None NO es un error que haya que propagar: el llamador guarda el punto sin
    foto y la interfaz muestra el marcador genérico de siempre."""
    clave = os.getenv("GOOGLE_ROUTES_API_KEY")
    if not clave:
        return None

    try:
        # ── 1. Metadata, GRATIS ──
        meta = requests.get(
            _METADATA_URL,
            params={"location": f"{lat},{lng}", "key": clave},
            timeout=_TIMEOUT_SECONDS,
        )
        meta.raise_for_status()
        datos = meta.json()
        # "ZERO_RESULTS" cuando no hay panorámica cerca; "OK" es el único caso
        # en que vale la pena pagar la imagen.
        if datos.get("status") != "OK":
            return None

        # ── 2. Hacia dónde mirar ──
        pano = datos.get("location") or {}
        heading = None
        if "lat" in pano and "lng" in pano:
            heading = _rumbo((pano["lat"], pano["lng"]), (lat, lng))

        # ── 3. La imagen, lo único que se cobra ──
        params = {
            "location": f"{lat},{lng}",
            "size": _TAMANO,
            "scale": 2,
            "fov": _FOV,
            "pitch": 0,
            # Sin esto, cuando no hay imagen Google devuelve 200 con una foto
            # gris que dice "Sorry, we have no imagery here": se cobraría igual
            # y se guardaría un cartel como si fuera el patio.
            "return_error_code": "true",
            "key": clave,
        }
        if heading is not None:
            params["heading"] = round(heading, 1)

        img = requests.get(_IMAGEN_URL, params=params, timeout=_TIMEOUT_SECONDS)
        img.raise_for_status()
        contenido = img.content
        if not contenido or not img.headers.get("content-type", "").startswith("image/"):
            return None
        return contenido
    except Exception:
        # Clave inválida, cuota agotada, servicio caído, timeout: todo termina
        # acá. Que no haya foto nunca puede impedir crear un punto de recurso.
        return None
