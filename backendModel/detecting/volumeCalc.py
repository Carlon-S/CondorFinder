import json
import numpy as np
import rasterio
from rasterio.transform import rowcol
from rasterstats import zonal_stats
from shapely.geometry import Polygon, mapping
import geopandas as gpd

# kg/m³ bulk density estimates per class
DENSITY_MAP = {
    "Plástico":                 80,
    "Metal":                   600,
    "Residuo orgánico":        300,
    "Neumáticos":              400,
    "Muebles":                 200,
    "Residuo de construcción": 400,
    "Tipo de basura indefinido": 200,
}

COLORS_MAP = {
    "Residuo de construcción":   "#ff1100",
    "Muebles":                   "#ff8400",
    "Metal":                     "#696969",
    "Plástico":                  "#0228c2",
    "Residuo orgánico":          "#02c218",
    "Neumáticos":                "#262626",
    "Tipo de basura indefinido": "#8404b3",
}


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


def enrich(
    detections_json_path,
    ortho_path,
    ndsm_path,
    output_json_path,
):
    with open(detections_json_path) as f:
        data = json.load(f)

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

    pixel_area_m2 = abs(transform.a * transform.e)

    enriched = []

    for det in data["detections"]:
        result = dict(det)

        if det["polygon"] is None:
            b = det["bbox"]
            pixel_polygon = [
                [b["minx"], b["miny"]],
                [b["maxx"], b["miny"]],
                [b["maxx"], b["maxy"]],
                [b["minx"], b["maxy"]],
            ]
        else:
            pixel_polygon = det["polygon"]

        geo_coords = pixels_to_geo(pixel_polygon, transform)

        if len(geo_coords) < 3:
            result.update({"volume_m3": None, "weight_kg": None})
            enriched.append(result)
            continue

        shapely_poly = Polygon(geo_coords)
        if not shapely_poly.is_valid:
            shapely_poly = shapely_poly.buffer(0)

        stats = zonal_stats(
            [mapping(shapely_poly)],
            ndsm_path,
            stats=["sum", "mean", "max", "count"],
            nodata=np.nan,
            geojson_out=False,
        )[0]

        height_sum = stats["sum"] if stats["sum"] is not None else 0.0
        volume_m3 = round(height_sum * pixel_area_m2, 4)

        cls = det["class"]
        density = DENSITY_MAP.get(cls, 200)
        color = COLORS_MAP.get(cls,"#000000")
        weight_kg = round(volume_m3 * density, 2)

        area_m2 = round((stats["count"] or 0) * pixel_area_m2, 4)

        result.update({
            "geo_polygon":   geo_coords,
            "area_m2":       area_m2,
            "ndsm_mean_m":   round(stats["mean"] or 0, 3),
            "ndsm_max_m":    round(stats["max"]  or 0, 3),
            "volume_m3":     volume_m3,
            "density_kg_m3": density,
            "weight_kg":     weight_kg,
            "color":         color
        })

        enriched.append(result)

    output = {"crs": str(crs), "ortho_center": ortho_center, "detections": enriched}
    with open(output_json_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Guardado Json: {output_json_path}")
    return output