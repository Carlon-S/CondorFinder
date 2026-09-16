# CondorFinder: Backend

API REST que orquesta el pipeline completo de procesamiento:

1. **Carga de imágenes**, recibe y persiste las imágenes JPG del drone en `joining/images/`
2. **Verificación de solapamiento** (`joining/Reconociemiento_solapamiento.py`), comprueba que cada par de imágenes consecutivas tenga al menos un 60% de solapamiento usando datos GPS EXIF y el FOV del drone (82.1°)
3. **Unificación** (`joining/joinOrtho.py`), genera un ortomosaico `.tif` y un modelo 3D completo (DSM, DTM, nube de puntos) usando OpenDroneMap
4. **Detección** (`detecting/detectingOrtho.py`), detecta categorías de basura con YOLOv8 + SAHI, genera el PNG del mapa y un JSON con las detecciones y sus coordenadas en píxeles
5. **Resultado**, expone el PNG del mapa y el JSON de detecciones al frontend. La tarea queda en "pendiente de análisis"

El **análisis de volumen** (`detecting/volumeCalc.py`) ya NO es parte del pipeline. Se dispara aparte, con `POST /analyze/{task_id}`, cuando el trabajador entra a la vista de análisis y lo pide. Cada llamada es una medición nueva que se guarda con su propia fecha: es lo que le da historia a una zona. Antes corría solo al final del pipeline, y por eso todo reanálisis devolvía exactamente el mismo número.

---

## Requisitos

- Python 3.12+ en WSL (Ubuntu)
- Docker instalado en WSL (Ubuntu)
- Cuenta de MongoDB Atlas (free tier M0), persiste usuarios, tareas del pipeline, puntos (HDU6) y análisis guardados

---

## Estructura

```
backendModel/
├── orquestador.py        ← API FastAPI principal (pipeline + wiring de los demás routers)
├── auth.py                ← Login/logout/sesión (JWT en cookie httpOnly)
├── resources.py            ← Puntos y recursos disponibles (HDU6)
├── routing.py               ← Base de POST /routes/generate (HDU5), algoritmo real pendiente
├── analyses.py              ← Análisis guardados (HDU4) + fusión de duplicados (HDU7)
├── task_store.py             ← Persistencia de tareas del pipeline en MongoDB
├── scripts/
│   └── migrar_zonas.py   ← Agrupa en zonas los análisis previos al modelo nuevo
├── requirements.txt      ← Dependencias Python
├── .env.example           ← Plantilla de variables de entorno (copiar a .env, gitignored)
├── joining/
│   ├── joinOrtho.py                   ← Conecta con NodeODM y genera el ortomosaico + modelo 3D
│   ├── Reconociemiento_solapamiento.py ← Verifica solapamiento GPS entre imágenes
│   ├── images/                        ← Imágenes JPG de entrada
│   ├── finals/                        ← Por vuelo: ortho_<uuid>.tif, dsm_<uuid>.tif, dtm_<uuid>.tif
│   └── output/                        ← Salida cruda de ODM, se vacía al terminar cada unificación
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

### Paso 1: Levanta NodeODM

```bash
docker run -ti -p 3000:3000 opendronemap/nodeodm
```

Espera hasta ver:
```
info: Server has started on port 3000
```

El orquestador verifica automáticamente que ODM esté corriendo antes de iniciar el pipeline. Si no está disponible retorna un error claro al frontend.

### Paso 2: Levanta el orquestador

Abre una nueva terminal WSL, navega a la raíz del proyecto y ejecuta:

```bash
source backendModel/joining/venv/bin/activate
backendModel/joining/venv/bin/uvicorn backendModel.orquestador:app --port 8000
```

> **Importante:** no uses `--reload`. El flag de recarga automática mata el `threading.Thread` que corre `run_pipeline`/`run_analysis` a mitad de proceso, el estado de la tarea ya sobrevive un reinicio (ver sección "Notas" más abajo), pero un hilo interrumpido no se puede retomar solo.

Espera hasta ver:
```
INFO: Application startup complete.
```

---

## Endpoints

Todos los endpoints salvo `POST /auth/login` requieren una sesión válida (cookie `access_token`, ver `auth.py`), sin ella devuelven `401`.

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
| `POST` | `/generate` | Inicia el pipeline en background: solapamiento, ODM, YOLO. **No calcula volumen**: eso ocurre después, desde la vista de análisis |
| `POST` | `/cancel/{task_id}` | Solicita cancelar una tarea, inmediata entre fases, real en ODM durante "joining", best-effort durante "detecting" |
| `GET` | `/pipeline-status` | Indica si el servidor está ocupado con otra tarea (`{"busy": bool}`), sin depender del estado local del navegador |
| `GET` | `/status/{task_id}` | Estado de la tarea y del análisis. Incluye `capture_date` y `capture_date_estimated` (fecha del vuelo, del EXIF), `algorithm_version`, `stage_progress` (avance real de ODM durante `joining`) y `can_analyze` (falso cuando los modelos de elevación de este vuelo ya se liberaron) |
| `DELETE` | `/status/{task_id}` | Elimina el documento de la tarea de Mongo, usado al eliminar una zona desde Vista Principal (guardada o no) |
| `GET` | `/tasks/pending` | Lista las tareas "en progreso" o "terminadas pero no guardadas" que Vista Principal debe mostrar, reemplaza el antiguo registro en `localStorage` (`taskRegistry.ts`, eliminado). Excluye tareas en `error` y tareas ya `reviewed` (ver más abajo) |
| `POST` | `/analyze/{task_id}` | Calcula el volumen. **Recalcula siempre**: cada llamada es una medición nueva que el frontend guarda como un análisis con su propia fecha. Responde `unavailable` con el motivo si este vuelo ya no es el más reciente de su zona |
| `GET` | `/result/{filename}` | Sirve el PNG del mapa o el JSON de detecciones |
| `DELETE` | `/result/{filename}` | Elimina un archivo de resultado, usado al eliminar una zona guardada |
| `DELETE` | `/finals/{filename}` | Elimina el ortomosaico `.tif` de `joining/finals/`, usado al eliminar una zona guardada |
| `GET` | `/task-images/{task_id}` | Lista el nombre de las imágenes con las que arrancó una tarea puntual |
| `GET` | `/task-images/{task_id}/{filename}` | Sirve una imagen del snapshot de una tarea puntual |
| `DELETE` | `/task-images/{task_id}` | Elimina el snapshot de imágenes de una tarea |

### Recursos disponibles: HDU6 (`resources.py`)

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/resources/points` | Crea un punto (tolvas/trucks con capacidad individual, retroexcavadoras/personal como cantidad, `active: bool`) |
| `GET` | `/resources/points` | Lista todos los puntos guardados |
| `GET` | `/resources/points/{point_id}` | Consulta un punto puntual. `404` si no existe |
| `PUT` | `/resources/points/{point_id}` | Reemplaza la configuración de un punto existente |
| `DELETE` | `/resources/points/{point_id}` | Elimina un punto |

### Generación de ruta: HDU5 (`routing.py`)

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/routes/generate` | Resuelve la capacidad real de los puntos activos contra Mongo y devuelve una ruta óptima. **El algoritmo de optimización todavía no está implementado** (`TODO(HDU5/AC2)`), siempre responde `{"status": "infeasible", "message": "..."}` mientras tanto, nunca inventa una ruta falsa |

### Análisis guardados: HDU4 + fusión de duplicados: HDU7 (`analyses.py`)

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/analyses` | Guarda un análisis nuevo (mapa, detecciones, resumen, `crs`, `orthoCenter`, `orthoBounds`). Al guardar, marca la tarea de origen como `reviewed` (no la borra, ver Notas) y compara la huella del ortomosaico (`orthoBounds`) contra los análisis guardados previamente (HDU7/AC1) |
| `GET` | `/analyses` | Lista todos los análisis guardados (incluye los marcados `historical`, el frontend los filtra en el listado principal, ver `index.tsx`) |
| `GET` | `/analyses/{analysis_id}` | Consulta un análisis puntual. `404` si no existe |
| `PUT` | `/analyses/{analysis_id}` | Sobrescribe un análisis existente (mismo nombre, AC6 de HDU4). No vuelve a disparar la comparación de duplicados, una sobrescritura es la misma zona por definición |
| `DELETE` | `/analyses/{analysis_id}` | Elimina un análisis guardado |
| `POST` | `/analyses/{analysis_id}/confirm-duplicate` | HDU7/AC3, confirma que es la misma zona que `possibleDuplicateOf`: el análisis **anterior** pasa a `historical: true` + `supersededBy: <id nuevo>`, este queda como `duplicateStatus: "confirmed_same"` |
| `POST` | `/analyses/{analysis_id}/reject-duplicate` | HDU7/AC4, indica que son zonas distintas: ambos registros se mantienen por separado, solo se cierra el aviso (`duplicateStatus: "confirmed_different"`) |
| `GET` | `/analyses/zones/all` | Lista las zonas. La ruta lleva `/all` porque `/analyses/{analysis_id}` ya captura cualquier segmento suelto |
| `PUT` | `/analyses/zones/{zone_id}` | Renombra una zona |
| `POST` | `/analyses/versions/{sourceTaskId}/reassign` | Separa una versión completa en una zona nueva. Existe porque agrupar por HDU7 es una heurística y, con el modelo de zonas, una confirmación equivocada fusionaría dos historias de forma permanente |

---

## Estados de una tarea (`/status/{task_id}`)

| Estado | Descripción |
|---|---|
| `running` | Tarea creada, iniciando pipeline |
| `checking_overlap` | Verificando solapamiento GPS entre imágenes consecutivas |
| `joining` | Unificando imágenes con ODM (fase más lenta) |
| `detecting` | Detectando basura con YOLOv8 + SAHI y calculando volúmenes |
| `done` | Proceso completado, mapa, detecciones y volúmenes disponibles |
| `cancelled` | Tarea cancelada por el usuario, se aplica en el próximo punto de control del pipeline |
| `error` | El proceso falló, `message` contiene el detalle |

### Respuesta cuando `status = "done"`

```json
{
  "status": "done",
  "message": "Proceso completado",
  "result_url": "http://localhost:8000/result/ortho_uuid.png",
  "result_json_url": "http://localhost:8000/result/ortho_uuid.json",
  "detection_count": 4,
  "analysis_status": "done",
  "analysis_message": "Análisis de volumen completado",
  "algorithm_version": 1,
  "capture_date": "2026-09-15 10:32:04",
  "capture_date_estimated": false,
  "can_analyze": true
}
```

- `result_url`: URL del PNG del mapa limpio (el overlay SVG lo genera el frontend)
- `result_json_url`: URL del JSON con detecciones enriquecidas (coordenadas, volumen, área, peso)
- `detection_count`: número de detecciones. Si es `0`, el frontend muestra aviso de "sin basura detectada"
- `analysis_status`: ausente hasta que alguien pida el cálculo. `"done"` tras un análisis exitoso, `"error"` si faltan los modelos de elevación de este vuelo
- `algorithm_version`: con qué versión del cálculo se midió (`VOLUME_ALGORITHM_VERSION`). Permite distinguir un cambio real del basural de una mejora en la medición
- `capture_date` / `capture_date_estimated`: fecha del vuelo, leída del EXIF. Si ninguna foto la traía, se usa la de carga y el segundo campo queda en `true`
- `can_analyze`: `false` cuando los modelos de elevación de este vuelo ya se liberaron porque existe una captura más reciente de la zona. La vista de análisis deshabilita el botón con el motivo
- `stage_progress`: solo durante `joining`, es el porcentaje real que reporta NodeODM

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

## Estado de los sprints

El estado por criterio de aceptación vive en un solo lugar, el [README principal](../README.MD#estado-de-sprint-1). Duplicarlo acá garantizaba que una de las dos copias quedara mintiendo, y de hecho pasó: esta tabla daba SP1 por no implementado mucho después de que estuviera listo.

### Trabajo de backend que no es una historia en sí

Endurecimiento del pipeline que hizo falta para sostener las historias, sin ser ninguna de ellas:

- Lock de generación concurrente (`is_pipeline_busy()`, endpoints `/generate`, `/upload`, `/pipeline-status`), evita que dos cargas se pisen mientras `joining/images/` sea una carpeta compartida.
- Snapshot de imágenes por tarea (`/task-images/*`). Antes, retomar una tarea vieja mostraba las imágenes de la carga más reciente en vez de las propias.
- Limpieza de archivos huérfanos al cancelar una tarea después de "joining" o "detecting", y al eliminar una zona (`/result`, `/finals`, `/task-images`).
- Retención automática de disco, ver la sección de modelos de elevación más abajo.

---

### Zona, versión y análisis

Modelo de tres niveles, introducido en el Sprint 2 junto con HDU9 y HDU10:

```
Zona                   nombre, identidad estable en el tiempo (colección `zones`)
 └─ Versión            un set de imágenes = un vuelo = un mapa unificado (`sourceTaskId`)
     └─ Análisis       un cálculo de volumen, con su fecha y su algoritmo
```

- **Una versión nace cuando se guarda su primer análisis**, no al generar el mapa. Por construcción no puede existir una versión sin cifras, así que la evolución de una zona nunca tiene tramos vacíos.
- Las versiones se ordenan por `captureDate` (EXIF de las fotos, leído por `Reconociemiento_solapamiento.fecha_captura_set()`). Si ninguna foto la trae, se cae a la fecha de carga y se marca `captureDateEstimated`. Empate: desempata `uploadedAt`.
- `algorithmVersion` sella cada análisis con `orquestador.VOLUME_ALGORITHM_VERSION`. Cuando SP2 mejore la precisión, sin ese sello un salto de volumen sería indistinguible de un cambio real en el basural.
- `changeKind` dice qué cambió respecto al análisis anterior del mismo vuelo: `primero`, `seleccion`, `algoritmo` o `sin-cambios`. Los marcados `sin-cambios` repiten la cifra anterior por construcción, así que el gráfico y el informe los agrupan en vez de dibujar un punto redundante.
- Reanalizar el **mismo** vuelo calza consigo mismo con superposición perfecta. Ese caso hereda la zona pero **no** levanta el aviso de duplicado: no es otra zona, es otra medición de la misma versión.

### Modelos de elevación y retención de disco

Cada vuelo guarda los suyos en `joining/finals/` como `dsm_<uuid>.tif` y `dtm_<uuid>.tif`, junto a su ortomosaico. `orquestador.dem_paths_for(task)` los deriva del `ortho_path` de la tarea.

Antes vivían en `joining/output/odm_dem/`, una carpeta compartida que cada vuelo sobrescribía. Era inofensivo mientras el volumen se calculaba dentro del pipeline, porque se usaban en el acto. Con el cálculo ocurriendo después, una ruta compartida significaría medir un vuelo con el terreno de otro y devolver cifras incorrectas sin ningún error visible.

Dos limpiezas automáticas, para que esto no sea mantención manual del servidor:

- `joinOrtho.limpiar_salida_cruda()` vacía `joining/output/` al terminar cada unificación, una vez rescatado lo que el sistema usa. El resto (modelo texturizado, nube de puntos, informe) no lo lee nadie y ocupaba unos 100 MB de forma permanente.
- `orquestador.liberar_archivos_de_vuelos_previos()` borra de `finals/` los modelos de elevación **y el ortomosaico** de los vuelos que dejaron de ser el más reciente. El `.tif` solo lo lee `volumeCalc.enrich()`, o sea el cálculo de volumen; lo que se ve en pantalla es el PNG que vive en GCS.

### Migración

`scripts/migrar_zonas.py` agrupa en zonas los análisis ya guardados, usando las cadenas de `supersededBy` de HDU7 como semilla. **Corre en simulación por defecto**; `--aplicar` escribe. Es idempotente.


---

## Notas

- El venv está en `joining/venv/` y está excluido del repositorio vía `.gitignore`. `backendModel/.env` también está gitignored, solo `.env.example` (con placeholders) se versiona.
- Las tareas del pipeline se persisten en MongoDB (`task_store.py`, colección `tasks`), sobreviven un reinicio de uvicorn. Al arrancar, `reconcile_orphaned_tasks()` marca como `error` cualquier tarea que haya quedado "en curso" de una vida anterior del proceso, en vez de dejarla colgada mostrando progreso que nunca va a avanzar. Lo único que NO sobrevive un reinicio es una tarea exactamente a mitad de pipeline (su `threading.Thread` desaparece igual) y el handle de cancelación de ODM (`odm_task`, objeto vivo no serializable, se mantiene aparte en memoria a propósito).
- Al guardar un análisis, su tarea de origen **no se borra**, `analyses.py` la marca con `reviewed: true` (`task_store.mark_reviewed()`) para que deje de listarse en `GET /tasks/pending`, pero el documento se conserva para que "Analizar volumen" pueda seguir recalculando sobre esa misma tarea después de reabrir el análisis guardado. Solo se borra (`DELETE /status/{task_id}`) cuando el trabajador elimina la zona explícitamente, o cuando `GET /tasks/pending` descubre una tarea `cancelled` (el frontend limpia sus archivos y la borra).
- Los archivos que genera el pipeline (imágenes subidas, ortomosaicos, PNG/JSON de resultado, snapshots por tarea) siguen en disco local, no en MongoDB, su limpieza depende de que el frontend dispare explícitamente la acción (cancelar o eliminar una zona); no hay proceso de limpieza propio del backend ni TTL en Mongo para documentos de tareas viejas.
- El análisis de volumen requiere los modelos de elevación **de ese vuelo** (`finals/dsm_<uuid>.tif` y `finals/dtm_<uuid>.tif`). Si no existen, `POST /analyze/{task_id}` responde `unavailable` con el motivo en vez de fallar con un error técnico: el caso normal es que ese vuelo ya no sea el más reciente de su zona.
- Detecciones que se solapan en más del 50% (IoU ≥ 0.5) se fusionan en una zona "Varios tipos" en el frontend para evitar doble conteo de volumen **dentro de una misma imagen unificada**. Esto es distinto de HDU7, que compara **entre análisis guardados distintos** (recargas de la misma zona física) usando el mismo umbral pero corriendo en el backend con `shapely`, y comparando la **huella completa del ortomosaico** (`orthoBounds`), no las detecciones individuales. Se probó con detecciones reales y el enfoque por detección resultó frágil: aunque el mismo set de fotos produce un `orthoCenter`/`orthoBounds` casi idéntico entre corridas (georreferenciado por GPS/EXIF, variación de un par de metros), las detecciones puntuales de YOLO pueden correrse esos mismos metros, suficiente para tirar el IoU muy por debajo de 50% en objetos chicos, aunque sea la misma basura real. Comparando la imagen completa (decenas de metros de lado), esa misma variación de GPS queda como una fracción mínima del tamaño total, dejando el umbral de 50% con margen real en vez de al límite.
- El color del relleno de cada polígono varía en un degradé verde → rojo según el volumen relativo entre todas las zonas detectadas.
- `volumeCalc.py` calcula además `geo_polygon`/`crs` (coordenadas reales en UTM, a partir de la georreferenciación de ODM) por detección, y `ortho_center` (centro geográfico del ortomosaico completo, independiente de las detecciones), el frontend los reproyecta a WGS84 client-side (`src/lib/projection.ts`) para HDU5. `ortho_center` es la fuente preferida para ubicar el círculo de una zona en `/rutas`, porque es determinístico entre corridas de análisis del mismo set de fotos (las detecciones de YOLO no lo son necesariamente).
- Un análisis marcado `historical: true` (HDU7/AC3) sigue existiendo en Mongo y sigue siendo consultable por id, solo deja de aparecer en el listado principal del frontend (`GET /analyses` no filtra, el filtro es responsabilidad de `index.tsx`/`rutas.tsx`).
