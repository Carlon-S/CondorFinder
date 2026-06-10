# CondorFinder — Backend

API REST que orquesta el pipeline completo de procesamiento:

1. **Carga de imágenes** — recibe y persiste las imágenes JPG del drone en `joining/images/`
2. **Unificación** (`joining/joinOrtho.py`) — genera un ortomosaico `.tif` usando OpenDroneMap
3. **Detección** (`detecting/detectingOrtho.py`) — detecta categorías de basura con YOLOv8 + SAHI y genera una imagen anotada en `detecting/output/`
4. **Resultado** — expone la imagen anotada y el conteo de detecciones al frontend

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
├── main.py               ← Script CLI alternativo (uso directo sin API)
├── joining/
│   ├── joinOrtho.py      ← Conecta con NodeODM y genera el ortomosaico
│   ├── images/           ← Imágenes JPG de entrada
│   └── finals/           ← Ortomosaico .tif de salida
└── detecting/
    ├── detectingOrtho.py ← Ejecuta YOLOv8 + SAHI sobre el ortomosaico
    ├── model/
    │   └── best.pt       ← Pesos del modelo YOLOv8 entrenado
    └── output/           ← Imágenes anotadas con detecciones
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

> Tarda varios minutos en la primera instalación.

---

## Ejecución

### Paso 1 — Levanta NodeODM

```bash
docker run -ti -p 3000:3000 webodm/nodeodm
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
| `POST` | `/generate` | Inicia el pipeline join + detect en background |
| `GET` | `/status/{task_id}` | Consulta el estado de una tarea en curso |
| `GET` | `/result/{filename}` | Sirve la imagen anotada generada por YOLOv8 |

---

## Estados de una tarea (`/status/{task_id}`)

| Estado | Descripción |
|---|---|
| `running` | Tarea creada, iniciando pipeline |
| `joining` | Unificando imágenes con ODM (fase más lenta) |
| `detecting` | Detectando basura con YOLOv8 + SAHI |
| `done` | Proceso completado — `result_url` y `detection_count` disponibles |
| `error` | El proceso falló — `message` contiene el detalle |

### Respuesta cuando `status = "done"`

```json
{
  "status": "done",
  "message": "Proceso completado",
  "result_url": "http://localhost:8000/result/nombre_archivo.png",
  "detection_count": 12
}
```

- `result_url`: URL de la imagen anotada con bounding boxes
- `detection_count`: número de detecciones encontradas por YOLOv8. Si es `0`, el frontend muestra el aviso de "sin basura detectada" en ambas vistas (HDU2 CA3 y HDU3 CA2)

---

## Categorías de basura detectadas

| Clase | Color en imagen |
|---|---|
| `construction_waste` | Rojo |
| `furniture` | Naranja |
| `metal` | Gris |
| `plastic` | Azul |
| `organic_waste` | Verde |
| `tyres` | Negro |
| `other` | Morado |

---

## Notas

- El venv está en `joining/venv/` y está excluido del repositorio vía `.gitignore`.
- Las tareas se almacenan en memoria (`tasks: dict`) — se pierden al reiniciar uvicorn. Esto es esperado en el MVP; una versión futura debería persistirlas en base de datos.
- Para forzar el escenario de "sin basura detectada" durante pruebas, se puede agregar temporalmente `detection_count = 0` después de la llamada a `detectingOrtho.detect()` en `run_pipeline`. 
