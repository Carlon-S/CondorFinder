import json
import numpy as np
import rasterio
from rasterio.transform import rowcol
from rasterstats import zonal_stats
from shapely.geometry import Polygon, MultiPolygon, mapping
from shapely.ops import unary_union
import geopandas as gpd

from detecting.waste_classes import color_de, densidad_de


def pixels_to_geo(polygon_px, transform):
    """
    Convert [[x,y], ...] pixel coords to geographic coords
    using the rasterio affine transform of the orthomosaic.
    """
    geo_coords = []
    for (px, py) in polygon_px:
        # affine: geo = transform * (col, row)
        geo_x, geo_y = transform * (px, py)
        geo_coords.append((geo_x, geo_y))
    return geo_coords


def compute_ndsm(dsm_path, dtm_path, ndsm_path):
    """
    Compute DSM - DTM and save as nDSM raster.
    Only needs to run once per flight.
    """
    with rasterio.open(dsm_path) as dsm_f:
        dsm = dsm_f.read(1).astype(float)
        profile = dsm_f.profile
        nodata = dsm_f.nodata
        dsm[dsm == nodata] = np.nan

    with rasterio.open(dtm_path) as dtm_f:
        dtm = dtm_f.read(1).astype(float)
        dtm_nodata = dtm_f.nodata
        dtm[dtm == dtm_nodata] = np.nan

    # ODM ocasionalmente genera DSM y DTM con 1 píxel de diferencia — recortar al mínimo común
    rows = min(dsm.shape[0], dtm.shape[0])
    cols = min(dsm.shape[1], dtm.shape[1])
    ndsm = dsm[:rows, :cols] - dtm[:rows, :cols]
    ndsm = np.where(ndsm < 0, 0, ndsm)

    profile.update(dtype=rasterio.float32, nodata=np.nan, height=rows, width=cols)
    with rasterio.open(ndsm_path, "w", **profile) as out:
        out.write(ndsm.astype(np.float32), 1)

    return ndsm_path


def anillo_plano_a_pares(anillo_plano):
    """Convierte un anillo plano [x1, y1, x2, y2, ...] en pares [(x1, y1), (x2, y2), ...].

    Es el formato en que el modelo entrega cada pieza de una máscara. Un valor
    suelto al final (cantidad impar de números) se descarta."""
    return [
        (anillo_plano[i], anillo_plano[i + 1])
        for i in range(0, len(anillo_plano) - 1, 2)
    ]


def geometria_de_deteccion(det, png_scale, transform):
    """Superficie de una detección en coordenadas geográficas, o `None` si no tiene.

    Con máscara: cada anillo se convierte a coordenadas geográficas con la
    transformación del ortomosaico y los anillos se unen en una sola geometría.
    Sin máscara (JSON del modelo anterior o detección sin máscara): se usa el
    rectángulo de su caja.

    `png_scale` es el factor con que el PNG se redujo respecto del ortomosaico.
    La caja está en píxeles del PNG, así que se divide por ese factor para
    llevarla a píxeles del ortomosaico; los anillos ya están en esos píxeles."""
    anillos = det.get("polygon")
    if anillos:
        piezas = []
        for anillo in anillos:
            coords = pixels_to_geo(anillo_plano_a_pares(anillo), transform)
            if len(coords) < 3:
                continue
            pieza = Polygon(coords)
            # Una máscara con el contorno cruzado produce un polígono inválido;
            # buffer(0) lo reconstruye sin cruces.
            if not pieza.is_valid:
                pieza = pieza.buffer(0)
            if not pieza.is_empty:
                piezas.append(pieza)
        if piezas:
            return unary_union(piezas)

    b = det["bbox"]
    esquinas_png = [
        (b["minx"], b["miny"]),
        (b["maxx"], b["miny"]),
        (b["maxx"], b["maxy"]),
        (b["minx"], b["maxy"]),
    ]
    esquinas_ortho = [(x / png_scale, y / png_scale) for (x, y) in esquinas_png]
    return Polygon(pixels_to_geo(esquinas_ortho, transform))


def anillo_para_mapa(geometria, tolerancia):
    """Un solo anillo [[x, y], ...] que representa la geometría en el mapa.

    El mapa de rutas dibuja un anillo por detección. Si la geometría tiene
    varias piezas se toma la de mayor superficie. El anillo se simplifica con
    `tolerancia` (en unidades del CRS) para reducir la cantidad de vértices sin
    desviarse más que esa distancia, y se entrega sin repetir el primer punto al
    final."""
    if isinstance(geometria, MultiPolygon):
        geometria = max(geometria.geoms, key=lambda g: g.area)
    simplificada = geometria.simplify(tolerancia, preserve_topology=True)
    if simplificada.is_empty or not isinstance(simplificada, Polygon):
        simplificada = geometria
    return [list(punto) for punto in simplificada.exterior.coords][:-1]


def enrich(
    detections_json_path,
    ortho_path,
    ndsm_path,
    output_json_path,
):
    with open(detections_json_path) as f:
        data = json.load(f)

    # Factor de reducción del PNG respecto del ortomosaico. Los JSON generados
    # antes de este campo no lo traen: el PNG era del mismo tamaño (1.0).
    png_scale = data.get("png_scale") or 1.0

    with rasterio.open(ortho_path) as ortho:
        transform = ortho.transform
        crs = ortho.crs
        # Centro geográfico REAL del ortomosaico completo (extensión real
        # del mapa, dada por su propia georreferenciación) — a diferencia
        # del centroide de las detecciones, este valor es el mismo sin
        # importar qué encuentre YOLO en cada corrida: dos análisis del
        # mismo set de fotos deben ubicarse en el mismo lugar en /rutas
        # aunque sus detecciones (cantidad, tamaño) difieran entre sí.
        bounds = ortho.bounds
        ortho_center = [(bounds.left + bounds.right) / 2, (bounds.bottom + bounds.top) / 2]
        # Huella geográfica COMPLETA del ortomosaico (no solo el centro) —
        # HDU7 la usa para detectar duplicados comparando el rectángulo
        # completo entre análisis en vez de detecciones individuales de
        # basura: el centro/extensión del ortomosaico varía muy poco entre
        # corridas del mismo set de fotos (georreferenciado por GPS/EXIF),
        # mientras que detecciones puntuales de YOLO pueden correrse lo
        # suficiente como para romper el solapamiento en objetos chicos. Ver
        # analyses.py::_find_possible_duplicate.
        ortho_bounds = [bounds.left, bounds.bottom, bounds.right, bounds.top]

    pixel_area_m2 = abs(transform.a * transform.e)
    # Un píxel del ortomosaico, en unidades del CRS: es la desviación máxima
    # que se admite al simplificar el contorno que se dibuja en el mapa.
    tolerancia_contorno = abs(transform.a)

    enriched = []

    for det in data["detections"]:
        result = dict(det)

        # Una detección que el trabajador quitó no se mide: sigue en el archivo
        # (marcada) para poder volver si se reabre un análisis que sí la tenía,
        # pero no aporta volumen ni se dibuja.
        if det.get("quitada"):
            enriched.append(result)
            continue

        geometria = geometria_de_deteccion(det, png_scale, transform)

        if geometria is None or geometria.is_empty or geometria.area == 0:
            result.update({"volume_m3": None, "weight_kg": None})
            enriched.append(result)
            continue

        # Suma de la altura (nDSM) de todos los píxeles dentro de la geometría,
        # más la cantidad de píxeles, el promedio y el máximo.
        stats = zonal_stats(
            [mapping(geometria)],
            ndsm_path,
            stats=["sum", "mean", "max", "count"],
            nodata=np.nan,
            geojson_out=False,
        )[0]

        height_sum = stats["sum"] if stats["sum"] is not None else 0.0
        # Volumen = suma de alturas × superficie de un píxel.
        volume_m3 = round(height_sum * pixel_area_m2, 4)

        # Densidad de la detección; si el JSON no la trae (modelo anterior) se
        # busca por el nombre de su clase.
        densidad = det.get("density_kg_m3")
        if densidad is None:
            densidad = densidad_de(det["class"])
        weight_kg = round(volume_m3 * float(densidad), 2)

        area_m2 = round((stats["count"] or 0) * pixel_area_m2, 4)

        result.update({
            "geo_polygon":   anillo_para_mapa(geometria, tolerancia_contorno),
            "area_m2":       area_m2,
            "ndsm_mean_m":   round(stats["mean"] or 0, 3),
            "ndsm_max_m":    round(stats["max"]  or 0, 3),
            "volume_m3":     volume_m3,
            "density_kg_m3": float(densidad),
            "weight_kg":     weight_kg,
            "color":         det.get("color") or color_de(det["class"]),
        })

        enriched.append(result)

    output = {
        "crs": str(crs),
        "png_scale": png_scale,
        "ortho_center": ortho_center,
        "ortho_bounds": ortho_bounds,
        "detections": enriched,
    }
    with open(output_json_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Guardado Json: {output_json_path}")
    return output
