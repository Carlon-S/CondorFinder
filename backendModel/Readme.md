# CondorFinder — Backend

API REST que orquesta el pipeline completo de procesamiento:

1. **Carga de imágenes** — recibe y persiste las imágenes JPG del drone en `joining/images/`
2. **Verificación de solapamiento** (`joining/Reconociemiento_solapamiento.py`) — comprueba que cada par de imágenes consecutivas tenga al menos un 60% de solapamiento usando datos GPS EXIF y el FOV del drone (82.1°)
3. **Unificación** (`joining/joinOrtho.py`) — genera un ortomosaico `.tif` y un modelo 3D completo (DSM, DTM, nube de puntos) usando OpenDroneMap
4. **Detección** (`detecting/detectingOrtho.py`) — detecta categorías de basura con YOLOv8 + SAHI, genera el PNG del mapa y un JSON con las detecciones y sus coordenadas en píxeles
5. **Análisis de volumen** (`detecting/volumeCalc.py`) — calcula volumen, peso y área real por detección usando el nDSM generado por ODM. Se ejecuta automáticamente al finalizar el pipeline
6. **Resultado** — expone el PNG del mapa, el JSON de detecciones enriquecido y las métricas de volumen al frontend

---

## Requisitos

- Python 3.12+ en WSL (Ubuntu)
- Docker instalado en WSL (Ubuntu)

---

## Estructura

```
backendModel/
├── orquestador.py        ← API FastAPI principal
├── requirements.txt      ← Dependencias Python
├── joining/
│   ├── joinOrtho.py                   ← Conecta con NodeODM y genera el ortomosaico + modelo 3D
│   ├── Reconociemiento_solapamiento.py ← Verifica solapamiento GPS entre imágenes
│   ├── images/                        ← Imágenes JPG de entrada
│   ├── finals/                        ← Ortomosaico .tif de salida
│   └── output/odm_dem/               ← DSM, DTM y nDSM generados por ODM
└── detecting/
    ├── detectingOrtho.py ← Ejecuta YOLOv8 + SAHI sobre el ortomosaico
    ├── volumeCalc.py     ← Calcula volumen/peso/área por detección usando nDSM
    ├── model/
    │   └── best.pt       ← Pesos del modelo YOLOv8 entrenado
    └── output/           ← PNG del mapa y JSON de detecciones por tarea
```

---

## Setup

Todos los comandos se ejecutan en **WSL**, desde la raíz del proyecto.

### 1. Crea el entorno virtual

```bash
python3 -m venv backendModel/joining/venv
source backendModel/joining/venv/bin/activate
```

### 2. Instala dependencias

```bash
pip install -r backendModel/requirements.txt
```

> Tarda varios minutos en la primera instalación. PyTorch, Ultralytics y Rasterio son los paquetes más pesados.

---

## Ejecución

### Paso 1 — Levanta NodeODM

```bash
docker run -ti -p 3000:3000 opendronemap/nodeodm
```

Espera hasta ver:
```
info: Server has started on port 3000
```

El orquestador verifica automáticamente que ODM esté corriendo antes de iniciar el pipeline. Si no está disponible retorna un error claro al frontend.

### Paso 2 — Levanta el orquestador

Abre una nueva terminal WSL, navega a la raíz del proyecto y ejecuta:

```bash
source backendModel/joining/venv/bin/activate
backendModel/joining/venv/bin/uvicorn backendModel.orquestador:app --port 8000
```

> **Importante:** no uses `--reload`. El flag de recarga automática reinicia el proceso al detectar cambios en archivos, lo que destruye el diccionario de tareas en memoria y hace que las tareas en ejecución retornen "Tarea no encontrada".

Espera hasta ver:
```
INFO: Application startup complete.
```

---

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/upload` | Recibe imágenes JPG y las guarda en `joining/images/` |
| `GET` | `/upload` | Lista los archivos actualmente en `joining/images/` |
| `DELETE` | `/upload/{filename}` | Elimina una imagen específica de `joining/images/` |
| `DELETE` | `/upload` | Elimina todas las imágenes de `joining/images/` |
| `POST` | `/generate` | Inicia el pipeline completo (solapamiento → ODM → YOLO → análisis de volumen) en background |
| `GET` | `/status/{task_id}` | Consulta el estado de la tarea y del análisis de volumen |
| `POST` | `/analyze/{task_id}` | Fuerza el cálculo de volumen si no se ejecutó automáticamente |
| `GET` | `/result/{filename}` | Sirve el PNG del mapa o el JSON de detecciones |

---

## Estados de una tarea (`/status/{task_id}`)

| Estado | Descripción |
|---|---|
| `running` | Tarea creada, iniciando pipeline |
| `checking_overlap` | Verificando solapamiento GPS entre imágenes consecutivas |
| `joining` | Unificando imágenes con ODM (fase más lenta) |
| `detecting` | Detectando basura con YOLOv8 + SAHI y calculando volúmenes |
| `done` | Proceso completado — mapa, detecciones y volúmenes disponibles |
| `error` | El proceso falló — `message` contiene el detalle |

### Respuesta cuando `status = "done"`

```json
{
  "status": "done",
  "message": "Proceso completado",
  "result_url": "http://localhost:8000/result/ortho_uuid.png",
  "result_json_url": "http://localhost:8000/result/ortho_uuid.json",
  "detection_count": 4,
  "analysis_status": "done",
  "analysis_message": "Análisis de volumen completado"
}
```

- `result_url`: URL del PNG del mapa limpio (el overlay SVG lo genera el frontend)
- `result_json_url`: URL del JSON con detecciones enriquecidas (coordenadas, volumen, área, peso)
- `detection_count`: número de detecciones. Si es `0`, el frontend muestra aviso de "sin basura detectada"
- `analysis_status`: `"done"` al terminar el pipeline, `"error"` si faltan los archivos DEM

### Respuesta cuando `status = "error"` por solapamiento insuficiente

```json
{
  "status": "error",
  "message": "Solapamiento insuficiente en 2 par(es) de imágenes.",
  "overlap_detail": [
    {
      "imagen_1": "DJI_0001.JPG",
      "imagen_2": "DJI_0002.JPG",
      "solape": 42.3,
      "distancia_m": 58.7
    }
  ],
  "overlap_total": 5
}
```

---

## Categorías de basura detectadas

| Clase | Color en overlay |
|---|---|
| `Residuo de construcción` | Rojo |
| `Muebles` | Naranja |
| `Metal` | Naranja oscuro |
| `Plástico` | Azul |
| `Residuo orgánico` | Verde |
| `Neumáticos` | Gris |
| `Tipo de basura indefinido` | Amarillo |
| `Varios tipos` | Morado |

---

## Notas

- El venv está en `joining/venv/` y está excluido del repositorio vía `.gitignore`.
- Las tareas se almacenan en memoria (`tasks: dict`) — se pierden al reiniciar uvicorn. Esto es esperado en el MVP.
- El análisis de volumen requiere que ODM haya generado `dsm.tif` y `dtm.tif` en `joining/output/odm_dem/`. Si no existen, el pipeline continúa pero `analysis_status` queda en `"error"`.
- Detecciones que se solapan en más del 50% (IoU ≥ 0.5) se fusionan en una zona "Varios tipos" en el frontend para evitar doble conteo de volumen.
- El color del relleno de cada polígono varía en un degradé verde → rojo según el volumen relativo entre todas las zonas detectadas.
