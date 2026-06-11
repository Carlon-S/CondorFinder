import os
from detecting.detectingOrtho import detect
from joining.joinOrtho import join
from detecting.volumeCalc import enrich, compute_ndsm

BASE_DIR = os.path.dirname(os.path.abspath(__file__))  # project root
FINALS_DIR  = os.path.join(BASE_DIR, "joining", "finals")
ORTHO_NAME = join(0)

filename = join(0)
ORTHO_NAME = os.path.join(FINALS_DIR, filename)

ORTHO_PATH = os.path.join(BASE_DIR,"joining","finals", join(0))

DSM_PATH   = os.path.join(BASE_DIR, "joining","output","odm_dem","dsm.tif")
DTM_PATH   = os.path.join(BASE_DIR, "joining","output","odm_dem","dtm.tif")
NDSM_PATH  = os.path.join(BASE_DIR, "joining","output","odm_dem","ndsm.tif")
FINAL, _ , DETECTIONS_JSON = detect(ORTHO_PATH)
ENRICHED_JSON = os.path.join(BASE_DIR, f"{DETECTIONS_JSON}")

if not os.path.exists(NDSM_PATH):
    compute_ndsm(DSM_PATH, DTM_PATH, NDSM_PATH)

enrich(
    DETECTIONS_JSON,
    ORTHO_PATH,
    NDSM_PATH,
    ENRICHED_JSON,
)

