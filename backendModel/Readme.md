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
- Cuenta de MongoDB Atlas (free tier M0) — persiste usuarios, tareas del pipeline, puntos de origen (HDU6) y análisis guardados

---

## Estructura

```
backendModel/
├── orquestador.py        ← API FastAPI principal (pipeline + wiring de los demás routers)
├── auth.py                ← Login/logout/sesión (JWT en cookie httpOnly)
├── resources.py            ← Puntos de origen y recursos disponibles (HDU6)
├── routing.py               ← Base de POST /routes/generate (HDU5) — algoritmo real pendiente
├── analyses.py              ← Análisis guardados (HDU4) + fusión de duplicados (HDU7)
├── task_store.py             ← Persistencia de tareas del pipeline en MongoDB
├── requirements.txt      ← Dependencias Python
├── .env.example           ← Plantilla de variables de entorno (copiar a .env, gitignored)
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

### 3. Configura las variables de entorno

```bash
cp backendModel/.env.example backendModel/.env
```

Completa `MONGODB_URI` (connection string de Atlas), `MONGODB_DB_NAME`, `JWT_SECRET` y `SEED_ADMIN_USERNAME`/`SEED_ADMIN_PASSWORD` en `backendModel/.env`. Sin esto el proceso no arranca: el `lifespan` de `orquestador.py` necesita `MONGODB_URI` para conectar, y `auth.py` lanza `RuntimeError` si falta `JWT_SECRET`.

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

> **Importante:** no uses `--reload`. El flag de recarga automática mata el `threading.Thread` que corre `run_pipeline`/`run_analysis` a mitad de proceso — el estado de la tarea ya sobrevive un reinicio (ver sección "Notas" más abajo), pero un hilo interrumpido no se puede retomar solo.

Espera hasta ver:
```
INFO: Application startup complete.
```

---

## Endpoints

Todos los endpoints salvo `POST /auth/login` requieren una sesión válida (cookie `access_token`, ver `auth.py`) — sin ella devuelven `401`.

### Autenticación (`auth.py`)

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/auth/login` | Inicia sesión con usuario/contraseña, setea la cookie httpOnly. `401` si las credenciales son incorrectas |
| `POST` | `/auth/logout` | Cierra la sesión, borra la cookie |
| `GET` | `/auth/me` | Devuelve el usuario de la sesión actual |

### Pipeline (`orquestador.py`)

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/upload` | Recibe imágenes JPG y las guarda en `joining/images/`. `409` si hay otra tarea en curso |
| `GET` | `/upload` | Lista los archivos actualmente en `joining/images/` |
| `GET` | `/upload/{filename}` | Sirve una imagen ya subida (miniaturas al retomar una generación en curso) |
| `DELETE` | `/upload/{filename}` | Elimina una imagen específica de `joining/images/`. `409` si hay otra tarea en curso |
| `DELETE` | `/upload` | Elimina todas las imágenes de `joining/images/`. `409` si hay otra tarea en curso |
| `POST` | `/generate` | Inicia el pipeline completo (solapamiento → ODM → YOLO → análisis de volumen) en background |
| `POST` | `/cancel/{task_id}` | Solicita cancelar una tarea — inmediata entre fases, real en ODM durante "joining", best-effort durante "detecting" |
| `GET` | `/pipeline-status` | Indica si el servidor está ocupado con otra tarea (`{"busy": bool}`), sin depender del estado local del navegador |
| `GET` | `/status/{task_id}` | Consulta el estado de la tarea y del análisis de volumen |
| `DELETE` | `/status/{task_id}` | Elimina el documento de la tarea de Mongo — usado al eliminar una zona desde Vista Principal (guardada o no) |
| `GET` | `/tasks/pending` | Lista las tareas "en progreso" o "terminadas pero no guardadas" que Vista Principal debe mostrar — reemplaza el antiguo registro en `localStorage` (`taskRegistry.ts`, eliminado). Excluye tareas en `error` y tareas ya `reviewed` (ver más abajo) |
| `POST` | `/analyze/{task_id}` | Fuerza el cálculo de volumen si no se ejecutó automáticamente |
| `GET` | `/result/{filename}` | Sirve el PNG del mapa o el JSON de detecciones |
| `DELETE` | `/result/{filename}` | Elimina un archivo de resultado — usado al eliminar una zona guardada |
| `DELETE` | `/finals/{filename}` | Elimina el ortomosaico `.tif` de `joining/finals/` — usado al eliminar una zona guardada |
| `GET` | `/task-images/{task_id}` | Lista el nombre de las imágenes con las que arrancó una tarea puntual |
| `GET` | `/task-images/{task_id}/{filename}` | Sirve una imagen del snapshot de una tarea puntual |
| `DELETE` | `/task-images/{task_id}` | Elimina el snapshot de imágenes de una tarea |

### Recursos disponibles — HDU6 (`resources.py`)

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/resources/points` | Crea un punto de origen (tolvas/trucks con capacidad individual, retroexcavadoras/personal como cantidad, `active: bool`) |
| `GET` | `/resources/points` | Lista todos los puntos de origen guardados |
| `GET` | `/resources/points/{point_id}` | Consulta un punto puntual. `404` si no existe |
| `PUT` | `/resources/points/{point_id}` | Reemplaza la configuración de un punto existente |
| `DELETE` | `/resources/points/{point_id}` | Elimina un punto de origen |

### Generación de ruta — HDU5 (`routing.py`)

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/routes/generate` | Resuelve la capacidad real de los puntos de origen activos contra Mongo y devuelve una ruta óptima. **El algoritmo de optimización todavía no está implementado** (`TODO(HDU5/AC2)`) — siempre responde `{"status": "infeasible", "message": "..."}` mientras tanto, nunca inventa una ruta falsa |

### Análisis guardados — HDU4 + fusión de duplicados — HDU7 (`analyses.py`)

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/analyses` | Guarda un análisis nuevo (mapa, detecciones, resumen, `crs`, `orthoCenter`). Al guardar, marca la tarea de origen como `reviewed` (no la borra, ver Notas) y compara sus polígonos contra los análisis guardados previamente (HDU7/AC1) |
| `GET` | `/analyses` | Lista todos los análisis guardados (incluye los marcados `historical` — el frontend los filtra en el listado principal, ver `index.tsx`) |
| `GET` | `/analyses/{analysis_id}` | Consulta un análisis puntual. `404` si no existe |
| `PUT` | `/analyses/{analysis_id}` | Sobrescribe un análisis existente (mismo nombre, AC6 de HDU4). No vuelve a disparar la comparación de duplicados — una sobrescritura es la misma zona por definición |
| `DELETE` | `/analyses/{analysis_id}` | Elimina un análisis guardado |
| `POST` | `/analyses/{analysis_id}/confirm-duplicate` | HDU7/AC3 — confirma que es la misma zona que `possibleDuplicateOf`: el análisis **anterior** pasa a `historical: true` + `supersededBy: <id nuevo>`, este queda como `duplicateStatus: "confirmed_same"` |
| `POST` | `/analyses/{analysis_id}/reject-duplicate` | HDU7/AC4 — indica que son zonas distintas: ambos registros se mantienen por separado, solo se cierra el aviso (`duplicateStatus: "confirmed_different"`) |

---

## Estados de una tarea (`/status/{task_id}`)

| Estado | Descripción |
|---|---|
| `running` | Tarea creada, iniciando pipeline |
| `checking_overlap` | Verificando solapamiento GPS entre imágenes consecutivas |
| `joining` | Unificando imágenes con ODM (fase más lenta) |
| `detecting` | Detectando basura con YOLOv8 + SAHI y calculando volúmenes |
| `done` | Proceso completado — mapa, detecciones y volúmenes disponibles |
| `cancelled` | Tarea cancelada por el usuario — se aplica en el próximo punto de control del pipeline |
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

## Estado de Sprint 1

| Historia | Criterio de aceptación | Estado |
|---|---|---|
| HDU4 | Al guardar un análisis, el sistema solicita un nombre para identificarlo | ✅ Cumplido |
| HDU4 | El análisis se guarda con el nombre ingresado en el listado de análisis disponibles del sistema | ✅ Cumplido |
| HDU4 | El botón "Abrir análisis" muestra el listado de análisis disponibles, actualizado | ✅ Cumplido |
| HDU4 | Al seleccionar un análisis del listado, se muestran el mapa y las detecciones correspondientes a esa zona | ✅ Cumplido |
| HDU4 | Si el guardado falla, se notifica al usuario y el modal permite reintentar sin perder los datos ingresados | 🔲 Pendiente de verificar |
| HDU4 | Si el nombre ingresado ya existe, el sistema pide confirmar antes de sobrescribir el análisis existente | ✅ Cumplido |
| HDU5 | Generación de ruta óptima de recolección según ubicación/tipo/volumen de basurales priorizados y capacidad de camiones/tolvas — frontend completo, `POST /routes/generate` resuelve capacidad real desde Mongo | 🟡 Backend base listo, algoritmo pendiente (`routing.py`, `TODO(HDU5/AC2)`) |
| HDU6 | Definición de puntos de origen y cantidad/capacidad de tolvas, camiones, retroexcavadoras y personal disponibles, para planes de ruta dinámicos | ✅ Cumplido |
| HDU7 (Deseable, 5 pts) | Fusión de detecciones entre cargas de la misma zona — comparar polígonos georreferenciados de un nuevo análisis contra los guardados y marcar posibles duplicados (>50% superposición, IoU real con `shapely` sobre `geo_polygon` en metros) | ✅ Cumplido |
| SP1 (Spike, 21 pts) | Investigación e implementación de mejoras al modelo de reconocimiento de imágenes — precisión ≥75%, distinguir construcciones de basurales, mejorar el umbral de solapamiento. AC: elegir entre un modelo preciso/lento u óptimo/rápido al generar el mapa | ❌ No implementado |

Trabajo de backend agregado para soportar HDU4 de forma robusta (no son historias en sí, sino endurecimiento del pipeline existente):
- Lock de generación concurrente (`is_pipeline_busy()`, endpoints `/generate`, `/upload`, `/pipeline-status`) — evita que dos cargas/generaciones se pisen mientras `joining/images/` sea una carpeta compartida.
- Snapshot de imágenes por tarea (`/task-images/*`) — antes, retomar una tarea vieja mostraba las imágenes de la carga más reciente en vez de las propias.
- Limpieza de archivos huérfanos al cancelar una tarea después de "joining"/"detecting", y al eliminar una zona (`/result`, `/finals`, `/task-images`).

---

## Notas

- El venv está en `joining/venv/` y está excluido del repositorio vía `.gitignore`. `backendModel/.env` también está gitignored — solo `.env.example` (con placeholders) se versiona.
- Las tareas del pipeline se persisten en MongoDB (`task_store.py`, colección `tasks`) — sobreviven un reinicio de uvicorn. Al arrancar, `reconcile_orphaned_tasks()` marca como `error` cualquier tarea que haya quedado "en curso" de una vida anterior del proceso, en vez de dejarla colgada mostrando progreso que nunca va a avanzar. Lo único que NO sobrevive un reinicio es una tarea exactamente a mitad de pipeline (su `threading.Thread` desaparece igual) y el handle de cancelación de ODM (`odm_task`, objeto vivo no serializable, se mantiene aparte en memoria a propósito).
- Al guardar un análisis, su tarea de origen **no se borra** — `analyses.py` la marca con `reviewed: true` (`task_store.mark_reviewed()`) para que deje de listarse en `GET /tasks/pending`, pero el documento se conserva para que "Analizar volumen" pueda seguir recalculando sobre esa misma tarea después de reabrir el análisis guardado. Solo se borra (`DELETE /status/{task_id}`) cuando el trabajador elimina la zona explícitamente, o cuando `GET /tasks/pending` descubre una tarea `cancelled` (el frontend limpia sus archivos y la borra).
- Los archivos que genera el pipeline (imágenes subidas, ortomosaicos, PNG/JSON de resultado, snapshots por tarea) siguen en disco local, no en MongoDB — su limpieza depende de que el frontend dispare explícitamente la acción (cancelar o eliminar una zona); no hay proceso de limpieza propio del backend ni TTL en Mongo para documentos de tareas viejas.
- El análisis de volumen requiere que ODM haya generado `dsm.tif` y `dtm.tif` en `joining/output/odm_dem/`. Si no existen, el pipeline continúa pero `analysis_status` queda en `"error"`.
- Detecciones que se solapan en más del 50% (IoU ≥ 0.5) se fusionan en una zona "Varios tipos" en el frontend para evitar doble conteo de volumen **dentro de una misma imagen unificada**. Esto es distinto de HDU7, que compara detecciones **entre análisis guardados distintos** (recargas de la misma zona física) usando el mismo umbral pero corriendo en el backend con `shapely` sobre `geo_polygon` real.
- El color del relleno de cada polígono varía en un degradé verde → rojo según el volumen relativo entre todas las zonas detectadas.
- `volumeCalc.py` calcula además `geo_polygon`/`crs` (coordenadas reales en UTM, a partir de la georreferenciación de ODM) por detección, y `ortho_center` (centro geográfico del ortomosaico completo, independiente de las detecciones) — el frontend los reproyecta a WGS84 client-side (`src/lib/projection.ts`) para HDU5. `ortho_center` es la fuente preferida para ubicar el círculo de una zona en `/rutas`, porque es determinístico entre corridas de análisis del mismo set de fotos (las detecciones de YOLO no lo son necesariamente).
- Un análisis marcado `historical: true` (HDU7/AC3) sigue existiendo en Mongo y sigue siendo consultable por id — solo deja de aparecer en el listado principal del frontend (`GET /analyses` no filtra, el filtro es responsabilidad de `index.tsx`/`rutas.tsx`).
