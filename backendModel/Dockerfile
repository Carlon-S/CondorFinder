# Se construye con contexto en la RAÍZ del repo (ver docker-compose.yml:
# build.context: . / build.dockerfile: backendModel/Dockerfile) para poder
# copiar backendModel/ completo y correr uvicorn exactamente como en WSL:
# `uvicorn backendModel.orquestador:app`. orquestador.py:21 hace
# sys.path.insert(0, BASE_DIR) él mismo, así que los imports planos
# (import task_store, etc.) funcionan igual sin tocar nada.
FROM python:3.12-slim

# libgl1/libglib2.0-0: opencv-python (no headless) los necesita para
# importar en una imagen sin entorno gráfico — sin esto falla con
# "libGL.so.1: cannot open shared object file" al arrancar.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backendModel/requirements.txt backendModel/requirements.txt

# torch/torchvision se instalan aparte con el índice CPU-only: el índice
# default de PyPI trae wheels con CUDA embebido (varios GB de más),
# inútiles en una VM sin GPU.
RUN pip install --no-cache-dir torch==2.12.0 torchvision==0.27.0 \
        --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r backendModel/requirements.txt

COPY backendModel/ backendModel/

EXPOSE 8000

CMD ["uvicorn", "backendModel.orquestador:app", "--host", "0.0.0.0", "--port", "8000"]
