# CondorFinder — Backend

API REST que orquesta el pipeline completo de procesamiento:

1. **Carga de imágenes** — recibe y persiste las imágenes JPG del drone en `joining/images/`
2. **Unificación** (`joining/joinOrtho.py`) — genera un ortomosaico `.tif` usando OpenDroneMap
3. **Detección** (`detecting/detectingOrtho.py`) — detecta categorías de basura con YOLOv8 y genera una imagen anotada en `detecting/output/`

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
    ├── detectingOrtho.py ← Ejecuta YOLOv8 sobre el ortomosaico
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
backendModel/joining/venv/bin/uvicorn backendModel.orquestador:app --reload --port 8000
```

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

### Estados de una tarea (`/status/{task_id}`)

| Estado | Descripción |
|---|---|
| `running` | Iniciando pipeline |
| `joining` | Unificando imágenes con ODM (toma tiempo) |
| `detecting` | Detectando basura con YOLOv8 |
| `done` | Proceso completado, `result_url` disponible |
| `error` | El proceso falló, `message` contiene el detalle |

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