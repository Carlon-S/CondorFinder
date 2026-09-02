import os

import requests

# =============================================================================
# CONDORFINDER — CLIENTE OSRM (HDU5/AC2)
# Archivo: backendModel/osrm_client.py
#
# Cliente HTTP para OSRM (Open Source Routing Machine) — el mismo motor que
# usa Leaflet Routing Machine en el navegador (ver Mapa.html de referencia),
# pero llamado directo desde el backend: routing.py es la única fuente de
# verdad de la ruta, nunca se calcula en el cliente (mismo criterio que el
# resto del proyecto — el frontend solo dibuja lo que el backend resuelve).
#
# Sync (usa `requests`, ya dependencia del proyecto vía joining/detecting)
# en vez de sumar httpx/aiohttp solo para esto — routing.py lo llama
# envuelto en asyncio.to_thread() para no bloquear el event loop de FastAPI.
#
# Dos servicios distintos, a propósito:
#   - table_matrix(): UNA llamada trae la matriz completa de duraciones/
#     distancias entre todos los puntos — es lo que usa la búsqueda del
#     mejor orden de paradas (probar cada permutación es aritmética sobre
#     esta matriz, sin más red).
#   - route_geometry(): la polilínea real (calles) de un tramo YA decidido
#     — se llama una sola vez por tramo final (ida/vuelta), no durante la
#     búsqueda, para no multiplicar llamadas HTTP a un servidor público.
#
# OSRM_BASE_URL apunta al servidor demo público (router.project-osrm.org)
# por default — sin SLA ni garantía de uptime, aceptable para el alcance de
# este sprint. Ver .env.example para overridearlo con un servidor propio.
# =============================================================================

OSRM_BASE_URL = os.getenv("OSRM_BASE_URL", "https://router.project-osrm.org").rstrip("/")
_TIMEOUT_SECONDS = 8


def _coords_param(points: list[tuple[float, float]]) -> str:
    # points viene como (lat, lng) — OSRM espera "lon,lat" por punto.
    return ";".join(f"{lng},{lat}" for lat, lng in points)


def table_matrix(points: list[tuple[float, float]]) -> dict | None:
    """Matriz de duraciones (segundos) y distancias (metros) entre TODOS
    los pares de `points` (lat, lng), en el mismo orden que se pasaron.
    None si OSRM no responde bien (servidor caído, sin ruta terrestre entre
    los puntos, etc.) — el llamador debe tratar esto como "no se pudo
    calcular la ruta", no reintentar solo."""
    if len(points) < 2:
        return None
    url = f"{OSRM_BASE_URL}/table/v1/driving/{_coords_param(points)}"
    try:
        resp = requests.get(url, params={"annotations": "duration,distance"}, timeout=_TIMEOUT_SECONDS)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != "Ok":
            return None
        return {"durations": data["durations"], "distances": data["distances"]}
    except Exception:
        return None


def route_geometry(points: list[tuple[float, float]]) -> dict | None:
    """Ruta real (calles) que pasa por `points` EN ORDEN — geometría
    decodificada (lista de [lat, lng]) más distancia/duración totales de
    ese tramo. Pensado para llamarse una sola vez, sobre el orden ya
    elegido por table_matrix()."""
    if len(points) < 2:
        return None
    url = f"{OSRM_BASE_URL}/route/v1/driving/{_coords_param(points)}"
    try:
        resp = requests.get(
            url, params={"overview": "full", "geometries": "geojson"}, timeout=_TIMEOUT_SECONDS
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != "Ok" or not data.get("routes"):
            return None
        route = data["routes"][0]
        coords = route["geometry"]["coordinates"]  # [[lng, lat], ...]
        return {
            "path": [[lat, lng] for lng, lat in coords],
            "distanceKm": route["distance"] / 1000,
            "durationHours": route["duration"] / 3600,
        }
    except Exception:
        return None
