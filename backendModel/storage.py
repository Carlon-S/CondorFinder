import os
from typing import Any

from google.cloud import storage

# =============================================================================
# CONDORFINDER — ALMACENAMIENTO DE RESULTADOS EN GOOGLE CLOUD STORAGE
# Archivo: backendModel/storage.py
#
# Reemplaza el disco local de OUTPUT_DIR (backendModel/detecting/output/)
# como fuente de verdad para /result/{filename} EN LA VM — es lo único que
# un análisis GUARDADO (analyses.mapUrl/detectionJsonUrl) referencia para
# siempre, así que necesita sobrevivir a un redeploy o pérdida de disco de
# la VM. UPLOAD_DIR/FINALS_DIR/TASK_IMAGES_DIR/DSM/DTM siguen en disco local
# a propósito (ver el plan de despliegue) — son archivos de trabajo del
# pipeline, no algo que un compañero necesite ver desde otra máquina.
#
# MODO LOCAL: si GCS_BUCKET_NAME no está seteado (nadie tiene por qué tener
# ya una cuenta/bucket de GCP solo para correr el backend en su WSL), este
# módulo cae solo a leer/escribir en OUTPUT_DIR igual que antes de GCS — el
# backend sigue funcionando 100% local sin ninguna dependencia de GCP. Solo
# la VM (con GCS_BUCKET_NAME seteado en su .env) usa el bucket de verdad.
#
# Autenticación en modo GCS vía Application Default Credentials — en la VM,
# la service account adjunta a la instancia; si alguien quisiera probar el
# modo GCS en su propia máquina, `gcloud auth application-default login`.
# Nunca un JSON key file que gestionar/filtrar.
#
# Bucket privado (uniform bucket-level access, sin allUsers): el acceso
# sigue pasando por GET/DELETE /result/{filename} en orquestador.py, que ya
# exige sesión válida — mismo control de acceso que existía con disco local.
# =============================================================================

_bucket: Any | None = None
_local_dir: str | None = None


def set_bucket(bucket_name: str | None) -> None:
    """bucket_name=None (GCS_BUCKET_NAME sin setear, el caso de desarrollo
    local de todo el equipo hoy) => modo local, ver docstring del módulo."""
    global _bucket
    _bucket = storage.Client().bucket(bucket_name) if bucket_name else None


def set_local_fallback_dir(path: str) -> None:
    global _local_dir
    _local_dir = path


def _local_path(blob_name: str) -> str:
    if _local_dir is None:
        raise RuntimeError("El directorio local no fue inicializado — set_local_fallback_dir() debe llamarse en el lifespan.")
    return os.path.join(_local_dir, blob_name)


def upload_result_file(local_path: str, blob_name: str, content_type: str) -> None:
    """En modo GCS, sube el archivo y borra la copia local (no acumular
    disco en la VM indefinidamente). En modo local no hay nada que "subir"
    — local_path ya ES el resultado final, se deja tal cual."""
    if _bucket is not None:
        _bucket.blob(blob_name).upload_from_filename(local_path, content_type=content_type)
        os.remove(local_path)


def result_file_exists(blob_name: str) -> bool:
    if _bucket is not None:
        return _bucket.blob(blob_name).exists()
    return os.path.exists(_local_path(blob_name))


def download_result_file(blob_name: str) -> bytes | None:
    if _bucket is not None:
        blob = _bucket.blob(blob_name)
        return blob.download_as_bytes() if blob.exists() else None
    path = _local_path(blob_name)
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        return f.read()


def delete_result_file(blob_name: str) -> None:
    if _bucket is not None:
        blob = _bucket.blob(blob_name)
        if blob.exists():
            blob.delete()
        return
    path = _local_path(blob_name)
    if os.path.exists(path):
        os.remove(path)
