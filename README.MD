# CondorFinder

Sistema web municipal para el monitoreo automatizado de basurales mediante imágenes aéreas capturadas con drones. Desarrollado para la Municipalidad de Maipú como parte del proyecto de Ingeniería de Software de la Universidad Técnica Federico Santa María.

---

## Requisitos previos

| Herramienta | Versión mínima | Plataforma |
|---|---|---|
| Node.js | 18+ | Windows |
| pnpm | 8+ | Windows |
| Python | 3.12+ | WSL (Ubuntu) |
| Docker | cualquiera | WSL (Ubuntu) |
| Git | cualquiera | Windows + WSL |
| MongoDB Atlas | cuenta gratuita (M0) | servicio externo, no requiere instalación local |

> El frontend se levanta en **Windows**. El backend y Docker se ejecutan en **WSL (Ubuntu)**. El backend usa MongoDB Atlas para persistir usuarios, tareas del pipeline, puntos de origen y análisis — crea un cluster gratuito en https://www.mongodb.com/cloud/atlas antes de continuar.

### Instalar Node.js y pnpm (Windows)

Descarga e instala Node.js desde https://nodejs.org (versión LTS).

Luego instala pnpm:

```powershell
npm install -g pnpm
```

### Instalar Docker en WSL (Ubuntu)

Abre WSL y ejecuta:

```bash
sudo apt update
sudo apt install -y docker.io
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker $USER
```

Cierra y vuelve a abrir WSL para que el grupo `docker` tome efecto. Verifica con:

```bash
docker --version
```

---

## Instalación

### 1. Clona el repositorio

En Windows (PowerShell):

```powershell
git clone https://github.com/Carlon-S/CondorFinder.git
cd CondorFinder
```

### 2. Instala dependencias del frontend

En Windows (PowerShell), dentro de la raíz del proyecto:

```powershell
pnpm.cmd install
```

Luego ejecuta:

```powershell
pnpm.cmd approve-builds
```

Se abrirá un selector interactivo. Usa `Space` para seleccionar `esbuild` (el círculo debe verse relleno `●`) y luego presiona `Enter`. Cuando pregunte `Do you approve? (y/N)`, escribe `y` y presiona `Enter`.

### 3. Crea el entorno virtual del backend

Abre WSL y navega a la raíz del proyecto:

```bash
cd /mnt/c/ruta/al/proyecto/CondorFinder
```

> Reemplaza `ruta/al/proyecto` con la ruta real en tu equipo. Por ejemplo:
> `cd /mnt/c/Users/tuusuario/Desktop/CondorFinder`

Crea el entorno virtual e instala dependencias:

```bash
python3 -m venv backendModel/joining/venv
source backendModel/joining/venv/bin/activate
pip install -r backendModel/requirements.txt
```

> La instalación puede tardar varios minutos porque incluye PyTorch, Ultralytics y Rasterio.

### 4. Configura las variables de entorno del backend

Copia la plantilla y complétala con valores reales:

```bash
cp backendModel/.env.example backendModel/.env
```

Edita `backendModel/.env` y completa:

| Variable | Descripción |
|---|---|
| `MONGODB_URI` | Connection string del cluster de Atlas (Database → Connect → Drivers) |
| `MONGODB_DB_NAME` | Nombre de la base dentro del cluster (se crea sola en el primer insert, ej. `condorfinder`) |
| `JWT_SECRET` | Secreto para firmar la sesión — genera uno con `python -c "import secrets; print(secrets.token_hex(32))"` |
| `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` | Credenciales del usuario admin que el backend siembra automáticamente al arrancar (solo si no existe ya en Mongo) |

> `backendModel/.env` está en `.gitignore` — nunca se sube al repositorio. Solo `.env.example` (con placeholders) se versiona.

---

## Ejecución

El sistema requiere **tres terminales corriendo simultáneamente**.

### Terminal 1 — NodeODM (WSL)

```bash
docker run -ti -p 3000:3000 opendronemap/nodeodm
```

Espera hasta ver:
```
info: Server has started on port 3000
```

Mantén esta terminal abierta durante todo el uso del sistema.

### Terminal 2 — Backend (WSL)

Abre una nueva terminal WSL, navega a la raíz del proyecto y ejecuta:

```bash
source backendModel/joining/venv/bin/activate
backendModel/joining/venv/bin/uvicorn backendModel.orquestador:app --port 8000
```

> **Importante:** no uses `--reload`. El flag de recarga automática mata el hilo que corre el pipeline a mitad de proceso — el estado de la tarea sobrevive un reinicio (se persiste en MongoDB), pero un hilo interrumpido no se puede retomar solo.

Espera hasta ver:
```
INFO: Application startup complete.
```

### Terminal 3 — Frontend (Windows PowerShell)

Desde la raíz del proyecto:

```powershell
pnpm.cmd dev
```

La aplicación estará disponible en **http://localhost:8080**

---

## Uso

### Inicio de sesión (`/login`)

1. Abre http://localhost:8080 — sin sesión activa, redirige automáticamente a `/login`
2. Ingresa el usuario y contraseña sembrados en `backendModel/.env` (`SEED_ADMIN_USERNAME`/`SEED_ADMIN_PASSWORD`). La sesión se guarda en una cookie httpOnly y persiste aunque se reinicie el backend

### Vista Principal (`/`)

Dashboard con las zonas guardadas, las tareas del pipeline en curso o pendientes de análisis (consultadas directo al backend, ya no dependen de que el mismo navegador las haya iniciado), y el panel **"Recursos disponibles"** con el resumen de tolvas/retroexcavadoras/camiones/puntos de origen/personal. Las zonas reemplazadas por un análisis más reciente de la misma zona física (HDU7) no aparecen en los filtros normales ni se cuentan en los totales — quedan disponibles aparte bajo el filtro **"Historial"**, con un subtítulo indicando por cuál análisis fueron reemplazadas.

### Vista de Carga (`/carga`)

1. Arrastra o selecciona las imágenes JPG tomadas con drone (mínimo 16)
2. Las imágenes se suben automáticamente al backend mientras se generan sus thumbnails — el bloque de imágenes adjuntas muestra un spinner por imagen hasta que el thumbnail esté listo
3. El sistema valida el formato y la cantidad antes de habilitar la generación
4. Presiona **Generar mapa unificado** — el proceso pasa por cuatro fases secuenciales: verificación de solapamiento (~60%), unificación con ODM, detección con YOLOv8 y cálculo automático de volúmenes
5. Al terminar, el mapa aparece en el visor con los polígonos de detección superpuestos:
   - Si se detectó basura: el mapa es clicable y navega a la vista de análisis
   - Si no se detectó basura: el mapa igual se muestra con un aviso informativo

> El estado de la tarea persiste en MongoDB. Si navegas a otra vista, recargas la página o incluso reinicias el backend durante la generación, el estado se sincroniza al volver (una tarea que estaba a mitad de pipeline exactamente cuando el backend se reinició queda marcada como error, con mensaje claro, en vez de mostrar progreso colgado).

### Vista de Análisis (`/analysis`)

6. Accede desde el mapa generado o directamente desde la barra de navegación
7. Las zonas detectadas aparecen en la lista — puedes activar o desactivar cada una antes de analizar
8. Presiona **Analizar volumen** para revelar los resultados ya calculados durante la generación
9. Los polígonos se colorean con un degradé **verde → rojo** según su volumen relativo (más rojo = mayor volumen)
10. Zonas solapadas se fusionan automáticamente como **"Varios tipos"** mostrando el desglose por cada clase contenida
11. Si el mapa no contenía basura detectada, el botón de análisis queda deshabilitado y se muestra un aviso
12. **Guardar análisis** le pide un nombre y lo agrega al listado de análisis disponibles del sistema (pide confirmación antes de sobrescribir si el nombre ya existe)
13. **Fusión de duplicados (HDU7)**: si el análisis recién guardado (o uno reabierto desde el listado) se superpone más de un 50% en área con un análisis guardado anteriormente, aparece un aviso comparando el volumen de ambos — "Es la misma zona" vincula ambos registros y envía el anterior al historial de Vista Principal; "Son zonas distintas" cierra el aviso y mantiene ambos registros por separado

### Vista de Recursos Disponibles (`/recursos`) — HDU6

13. **Definir punto de origen**: clickea un punto en el mapa (o escribe una dirección) para ubicar el origen de vehículos y maquinaria — dirección y comuna se completan solas vía geocodificación (Nominatim/OpenStreetMap), o puedes escribirlas a mano y el punto se reubica en el mapa automáticamente
14. Configura cantidad y capacidad individual de tolvas y camiones (no un valor agregado), y cantidad de retroexcavadoras y personal disponible
15. **Modificar puntos de origen** lista todos los puntos guardados con opciones para editar o eliminar (con confirmación)
16. Cada punto tiene un switch de **punto activo** — solo los puntos activos participan en la generación de ruta (HDU5)

### Vista de Generación de Ruta (`/rutas`) — HDU5

17. **Cargar archivo de análisis** abre un listado de análisis guardados (HDU4) para seleccionar uno o más — cada fila completa es clickable y muestra si el análisis ya está cargado o no es ubicable; los análisis reemplazados por uno más reciente de la misma zona (HDU7, ver Vista Principal) no aparecen en este listado
18. Los análisis seleccionados se agregan al mapa como un círculo grande de color, ubicado en la posición geográfica real del ortomosaico (no depende de las detecciones puntuales, así dos análisis del mismo set de fotos caen siempre en el mismo lugar); un círculo **sólido** indica que ese análisis está cargado en la ruta actual, **hueco** que no lo está — click en un círculo ya cargado, o en su fila en la lista lateral "Análisis cargados", lo descarga
19. Pasar el mouse sobre un círculo muestra una miniatura del mapa real de esa zona con sus polígonos de detección superpuestos; hacer click abre una vista ampliada con el mapa completo, sus polígonos en precisión de píxel, y el resumen de volumen/peso/área
20. **Generar ruta** queda deshabilitado sin ningún análisis cargado
21. Al presionar, se pide confirmar los puntos de origen activos, las horas disponibles y el tipo de basura prioritario — "Cancelar" cierra la confirmación sin tocar el mapa
22. El sistema genera la ruta óptima, o informa que no fue posible generarla y sugiere revisar los recursos disponibles (`/recursos`)

> El algoritmo real de optimización de ruta todavía no está implementado (`backendModel/routing.py`) — hoy `/rutas` siempre reporta que no fue posible generar una ruta. El resto del flujo (confirmación, carga de análisis, validaciones) está completo y verificado.

---

## Estructura del proyecto

```
CondorFinder/
├── src/
│   ├── assets/                     ← Imágenes estáticas y logo
│   ├── components/
│   │   ├── AppSidebar.tsx          ← Navegación colapsable + logout
│   │   ├── GeoMap.tsx              ← Wrapper SSR-safe (lazy-carga Leaflet solo en cliente)
│   │   ├── GeoMapImpl.tsx          ← Mapa Leaflet real (puntos, polígonos, overlays de imagen)
│   │   ├── ResourcesSummaryPanel.tsx ← Panel "Recursos disponibles" (compartido / y /recursos)
│   │   └── ui/                     ← Componentes shadcn/ui
│   ├── lib/                        ← Servicios y utilidades del frontend
│   │   ├── unify.ts                ← Cliente del pipeline de generación + tareas pendientes
│   │   ├── analysis.ts             ← Servicio de análisis de volumen
│   │   ├── analysisStore.ts        ← Cliente de análisis guardados (HDU4) + fusión de duplicados (HDU7)
│   │   ├── auth.ts                 ← Login/logout/usuario actual
│   │   ├── geocoding.ts            ← Geocodificación bidireccional (Nominatim/OSM)
│   │   ├── imageState.ts           ← Estado de carga/generación (sessionStorage)
│   │   ├── mapState.ts             ← Handoff de la URL del mapa entre vistas
│   │   ├── notify.tsx              ← Wrapper de toasts (sonner)
│   │   ├── projection.ts           ← Reproyección UTM → WGS84 (proj4)
│   │   ├── resources.ts            ← Cliente de puntos de origen (HDU6)
│   │   └── routePlan.ts            ← Contrato de generación de ruta (HDU5)
│   ├── routes/                     ← Vistas principales (file-based routing)
│   │   ├── __root.tsx              ← Shell de la app (layout, temas, anti-flash)
│   │   ├── login.tsx               ← Login (única ruta sin sesión)
│   │   └── _authed/                ← Rutas protegidas (redirige a /login sin sesión)
│   │       ├── index.tsx           ← Vista Principal
│   │       ├── carga.tsx           ← HDU1: Carga de imágenes + pipeline
│   │       ├── analysis.tsx        ← HDU2/HDU3/HDU4: Análisis de volumen + guardado
│   │       ├── recursos.tsx        ← HDU6: Recursos disponibles
│   │       └── rutas.tsx           ← HDU5: Generación de ruta óptima
│   └── styles.css                  ← Estilos globales, tokens de los 4 temas, overlays de mapa
├── backendModel/
│   ├── orquestador.py       ← API FastAPI principal (pipeline + wiring de routers)
│   ├── auth.py               ← Login/sesión (JWT en cookie httpOnly)
│   ├── resources.py          ← Puntos de origen y recursos (HDU6)
│   ├── routing.py            ← Base de generación de ruta (HDU5) — algoritmo pendiente
│   ├── analyses.py           ← Análisis guardados (HDU4) + fusión de duplicados (HDU7)
│   ├── task_store.py         ← Persistencia de tareas del pipeline en MongoDB
│   ├── requirements.txt      ← Dependencias Python
│   ├── .env.example          ← Plantilla de variables de entorno (ver Instalación)
│   ├── joining/
│   │   ├── joinOrtho.py                    ← Unificación de imágenes con ODM
│   │   ├── Reconociemiento_solapamiento.py ← Verificación de solapamiento GPS
│   │   ├── images/                         ← Imágenes JPG cargadas por el usuario
│   │   └── finals/                         ← Ortomosaico .tif generado por ODM
│   └── detecting/
│       ├── detectingOrtho.py ← Detección de basura con YOLOv8 + SAHI
│       ├── volumeCalc.py     ← Cálculo de volumen/peso/área usando nDSM de ODM
│       ├── model/best.pt     ← Pesos del modelo entrenado
│       └── output/           ← PNG del mapa y JSON de detecciones por tarea
├── package.json
└── README.MD
```

---

## Estado del MVP

| Historia | Criterio de aceptación | Estado |
|---|---|---|
| HDU1 | Se verifica que las imágenes sean del formato correcto (JPG) | ✅ Cumplido |
| HDU1 | Se revisa si las imágenes entregadas son suficientes y/o cumplen un margen de superposición (~60% de solapamiento) | ✅ Cumplido |
| HDU1 | El sistema genera un mapa unificando todas las imágenes | ✅ Cumplido |
| HDU2 | El sistema calcula el volumen asociado a cada polígono | ✅ Cumplido |
| HDU2 | Se muestra un resumen del volumen estimado total del área | ✅ Cumplido |
| HDU2 | Se muestra un mensaje de "No hay basura detectada en el área" | ✅ Cumplido |
| HDU3 | Se muestra un resumen relevante para el análisis: volumen estimado, área estimada y tipos de residuo | ✅ Cumplido |
| HDU3 | El sistema informa que no se encontraron basurales registrados | ✅ Cumplido |
| HDU3 | Se destaca visualmente la zona en base a su volumen estimado | ✅ Cumplido |
| HDU3 | El sistema muestra un mensaje de "Tipo de basura indefinido" | ✅ Cumplido |

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
| HDU5 | Dado un mapa interactivo con polígonos georreferenciados, cuando presione el botón de generar ruta, entonces aparecerá una pantalla de confirmación pidiendo el estado de los puntos de referencia, las horas disponibles y el tipo de basura prioritario, y preguntando si desea continuar o no | ✅ Cumplido |
| HDU5 | Dada una pantalla de confirmación, cuando se presione el botón de generar ruta, entonces el sistema generará una ruta óptima | 🔲 Pendiente (falta el algoritmo real de optimización en `backendModel/routing.py`) |
| HDU5 | Dado un mapa georreferenciado sin polígonos, cuando se esté visualizando el mapa, entonces el botón de generar ruta se encontrará deshabilitado | ✅ Cumplido |
| HDU5 | Dado un mapa georreferenciado, cuando se presione el botón de cargar archivo de análisis y se seleccione uno de los archivos guardados (HDU4), entonces el sistema cargará los polígonos asociados en el mapa junto con su metadata | ✅ Cumplido |
| HDU5 | Dada una pantalla de confirmación, cuando el trabajador presione "No" o cancele, entonces el sistema cerrará la pantalla de confirmación sin generar la ruta y sin perder el estado actual del mapa | ✅ Cumplido |
| HDU5 | Dada una pantalla de confirmación con los datos ingresados, cuando el sistema no logre generar una ruta factible con los recursos y restricciones indicadas, entonces mostrará un mensaje informando que no fue posible generar una ruta y sugerirá revisar los recursos disponibles (HDU6) | ✅ Cumplido |
| HDU6 | Al presionar "Definir punto de origen" con el mapa georreferenciado, se puede ubicar un punto concreto que el sistema considera origen de vehículos y maquinaria | ✅ Cumplido |
| HDU6 | Al escoger la ubicación se muestra una pantalla de configuración para definir cantidad y capacidad de tolvas, retroexcavadoras, camiones y personal disponibles | ✅ Cumplido |
| HDU6 | Al presionar "Guardar punto" en la configuración, el sistema lo guarda en el perfil del usuario actual (persistencia en MongoDB) | ✅ Cumplido |
| HDU6 | Al presionar "Modificar puntos de origen" se enlistan todos los puntos guardados con su ubicación y opciones modificar/eliminar | ✅ Cumplido |
| HDU6 | Al presionar modificar sobre un punto de la lista, se muestra su configuración guardada y permite editarla | ✅ Cumplido |
| HDU6 | Al presionar eliminar sobre un punto de la lista, se muestra una pantalla de confirmación | ✅ Cumplido |
| HDU6 | Al confirmar la eliminación, el punto se borra de la lista del perfil | ✅ Cumplido |
| HDU6 | El recurso "camiones" permite ingresar cantidad y capacidad de carga individual de cada camión (no un valor agregado) | ✅ Cumplido |
| HDU6 | El recurso "personal" permite ingresar la cantidad de trabajadores disponibles | ✅ Cumplido |
| HDU7 (Deseable) | Fusión de detecciones entre cargas de la misma zona: al guardar un nuevo análisis, el sistema compara sus polígonos georreferenciados contra los análisis guardados y, si detecta >50% de superposición con uno anterior, permite marcarlos como duplicados o mantenerlos por separado | ✅ Cumplido |
| SP1 (Spike, 21 pts) | Investigación e implementación de mejoras al modelo de reconocimiento de imágenes: precisión ≥75% en detección/volumen, distinguir construcciones de basurales, mejorar el umbral de solapamiento. AC: dado un set de imágenes, cuando el trabajador genere el mapa georreferenciado, el sistema le dará la opción de elegir un modelo preciso y lento o uno más óptimo y rápido | ❌ No implementado |

**Detalles adicionales de HDU6** (más allá del texto literal de los AC): el recurso "tolvas" también permite capacidad individual por unidad, con el mismo modelo que camiones (no un valor de capacidad único compartido). Los puntos de origen incluyen dirección y comuna, con geocodificación bidireccional vía Nominatim/OpenStreetMap: al ubicar un punto en el mapa se completan solas, y al escribir/corregir la dirección a mano el punto se reubica en el mapa automáticamente. Cada punto tiene además un switch de "punto activo" que HDU5 consume en la pantalla de confirmación.

**Detalles adicionales de HDU5** (más allá del texto literal de los AC): los polígonos de un análisis cargado no se dibujan literalmente sobre Leaflet (ilegibles a la escala de toda la comuna) — cada análisis se representa como un círculo grande de color, sólido si está cargado en la ruta actual y hueco si no, ubicado en el centro geográfico real del ortomosaico (`orthoCenter`, determinístico entre corridas del mismo set de fotos — ver HDU7 más abajo); al pasar el mouse se ve una miniatura con los polígonos superpuestos, y al hacer click se abre una vista ampliada con el mapa real en precisión de píxel. Esto sigue cumpliendo el AC4 literal ("cargará los polígonos asociados en el mapa junto con su metadata") sin perder precisión geográfica — el `geo_polygon` real (en su CRS UTM original) es el que efectivamente resuelve `POST /routes/generate` a partir de los `analysisIds` seleccionados, no algo que arme el navegador.

**Detalles adicionales de HDU7** (más allá del texto literal de los AC): la comparación de superposición corre en el backend (`shapely`, IoU real sobre polígonos en metros — no en el navegador ni sobre bounding boxes en píxeles), comparando cada detección del análisis nuevo contra cada detección de cada análisis guardado anterior con el mismo CRS, quedándose con el mejor candidato si supera el 50%. El "historial" del AC3 no es una vista aparte con datos duplicados: el análisis anterior se marca `historical` y sigue siendo el mismo documento, accesible desde Vista Principal bajo el filtro "Historial" — funciona igual con cadenas de varias zonas iguales encadenadas (A reemplazada por B, B reemplazada por C) y con múltiples pares de duplicados independientes coexistiendo, verificado en ambos casos.

---

## Tecnologías

| Capa | Tecnología |
|---|---|
| Frontend | React 19 + TanStack Start (SSR) + TanStack Router |
| Lenguaje frontend | TypeScript |
| Estilos | Tailwind CSS v4 + sistema de 4 temas (Verde tierra, Negro clásico, Azul oscuro, Modo claro) |
| Componentes UI | shadcn/ui + Radix UI |
| Mapas geográficos | Leaflet + react-leaflet |
| Bundler / servidor SSR | Vinxi + Nitro |
| Gestor de paquetes | pnpm |
| Backend API | FastAPI + Uvicorn |
| Base de datos | MongoDB Atlas (pymongo, cliente async + sync) |
| Autenticación | JWT en cookie httpOnly (PyJWT + pwdlib) |
| Unificación de imágenes | OpenDroneMap (NodeODM vía Docker) |
| Detección de basura | YOLOv8 (Ultralytics) + SAHI |
| Cálculo de volumen | RasterStats + GeoPandas sobre nDSM de ODM |
| Detección de duplicados (HDU7) | Shapely (IoU real entre polígonos georreferenciados, backend) |
| Geodesia / reproyección | proj4 (UTM → WGS84, cliente) |
| Geocodificación | Nominatim (OpenStreetMap) |

---

## Equipo

| Nombre | Rol | Contacto |
|---|---|---|
| Diego Carlon Soto | CPO | +56 9 3785 2772 |
| Bastian Kretschme | CEO | +56 9 7379 8753 |
| Nicolaz Muñoz | CMO / COO | +56 9 9044 4894 |
| Francisco González | CTO | +56 9 7537 9965 |

**Cliente:** Paloma Valenzuela, Directora de Aseo, Ornato y Gestión Ambiental — Municipalidad de Maipú.

**Institución:** Universidad Técnica Federico Santa María — Departamento de Informática — Ingeniería de Software 2026
