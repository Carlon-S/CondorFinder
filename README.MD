# CondorFinder

Sistema web municipal para el monitoreo automatizado de basurales mediante imágenes aéreas capturadas con drones. Desarrollado para la Municipalidad de Maipú como parte del proyecto de Ingeniería de Software de la Universidad Técnica Federico Santa María.

---

## Producción

El sistema está desplegado y funcionando en la nube, sin depender de `localhost`:

- **Frontend**: [https://condorfinder.cl](https://condorfinder.cl) — Cloudflare Workers, desplegado automáticamente con cada `git push` a `main`.
- **Backend**: `https://api.condorfinder.cl` — VM de Google Cloud (`southamerica-west1`, Santiago) con Docker Compose; el despliegue **no** es automático, requiere entrar por SSH y correr `git pull && docker compose up -d --build`.

Todo lo que sigue en este documento (Requisitos, Instalación, Ejecución) describe cómo levantar el sistema **en local para desarrollo** — no es necesario para usar la aplicación ya desplegada. Cómo subir cambios a producción está en la sección [Despliegue a producción](#despliegue-a-producción) más abajo; detalles adicionales de la infraestructura están en `CLAUDE.md`.

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

> El frontend se levanta en **Windows**. El backend y Docker se ejecutan en **WSL (Ubuntu)**. El backend usa MongoDB Atlas para persistir usuarios, tareas del pipeline, puntos y análisis — crea un cluster gratuito en https://www.mongodb.com/cloud/atlas antes de continuar.

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

### Alternativa: frontend local + backend en la nube

No siempre hace falta levantar las 3 terminales. Si solo quieres probar un cambio de **frontend** (y no tienes o no necesitas el backend local corriendo), puedes apuntar tu frontend local al backend real de producción:

1. Edita `.env` (raíz del proyecto) y deja activa la línea de producción en vez de la de `localhost`:
   ```
   VITE_BACKEND_URL=https://api.condorfinder.cl
   #VITE_BACKEND_URL=http://localhost:8000
   ```
2. Corre solo la **Terminal 3**:
   ```powershell
   pnpm.cmd dev
   ```

La app en `http://localhost:8080` va a hablar con el backend real (login, zonas guardadas, recursos — todo con datos reales de producción) sin necesitar NodeODM ni el backend local. **No sirve para probar cambios de backend que todavía no subiste a la VM** — para eso, el modo 100% local de arriba es el único que funciona, porque ahí sí estás corriendo tu propio código modificado.

> Recuerda volver a comentar la línea de producción y descomentar la de `localhost` cuando quieras volver al modo 100% local — es fácil olvidarlo y quedar sin querer apuntando siempre a producción.

---

## Despliegue a producción

El sistema vive en `https://condorfinder.cl` (frontend) y `https://api.condorfinder.cl` (backend). **Frontend y backend se despliegan de formas completamente distintas** — no asumas que un `git push` alcanza para todo.

### Frontend — automático

Cloudflare Workers está conectado directamente a este repositorio de GitHub. Cada `git push origin main` dispara un build y deploy automático — no hay que hacer nada más ahí:

```powershell
git add <archivos-modificados>
git commit -m "..."
git push origin main
```

**Cuidado con el botón "Retry build"** en el dashboard de Cloudflare (Compute → `condorfinder` → Deployments): repite el build de un commit **específico que ya existía**, no trae el código más reciente del repo. Si un build falla y quieres reintentarlo, primero confirma en "Recent builds" que ese build corresponda al commit que esperas — si el push más reciente ya generó su propio build (aunque sea en paralelo), usar "Retry build" sobre uno viejo puede terminar sirviendo código desactualizado sin ningún error visible.

Para confirmar qué versión está realmente activa: **Deployments → Version History** — la fila de arriba (100% de tráfico) debe corresponder al commit más reciente que esperas.

Las variables de entorno del build (`VITE_BACKEND_URL`, `VITE_CLIENT_BACKEND_URL`) se configuran en Cloudflare, **no** en este repo: **Settings → Builds → Variables and secrets**.

### Backend — manual

El backend en la VM **no se actualiza solo** con un push. Hay que entrar y hacerlo a mano cada vez:

```bash
# SSH desde la consola de GCP (botón "SSH" en la fila de la VM), o:
ssh <usuario>@<IP_de_la_VM>

cd ~/CondorFinder
git pull
docker compose up -d --build
```

`docker compose up -d --build` reconstruye la imagen del backend con el código nuevo y reinicia ese contenedor (NodeODM no necesita reconstruirse, no cambió). Verifica que haya quedado bien:

```bash
docker compose ps                              # ambos servicios "Up"
docker compose logs backend --tail 50          # sin errores al arrancar
curl http://localhost:8000/pipeline-status     # {"busy":false}
```

`backendModel/.env` vive **solo en la VM** (nunca se sube al repo). Si tu cambio necesita una variable de entorno nueva o distinta, edítala ahí a mano antes del `docker compose up`:

```bash
nano backendModel/.env
```

#### Variables de entorno exclusivas de producción

Ninguna de estas existe en tu `backendModel/.env` local — todas tienen un valor por defecto seguro para desarrollo cuando faltan, así que no rompen nada en local si nunca las agregas ahí:

| Variable | Dónde vive | Para qué sirve |
|---|---|---|
| `PUBLIC_BASE_URL` | VM | Base de las URLs que el backend arma en sus respuestas (`result_url`, `thumbnail_url`, etc.) |
| `GCS_BUCKET_NAME` | VM | Activa la subida de resultados a Google Cloud Storage en vez de solo disco local |
| `NODEODM_HOST` | VM | Nombre del servicio de NodeODM dentro de la red de Docker (`nodeodm`, no `localhost`) |
| `EXTRA_CORS_ORIGINS` | VM | Orígenes del frontend desplegado que CORS debe permitir, además de `localhost:8080` |
| `COOKIE_SECURE` / `COOKIE_DOMAIN` | VM | Necesarias porque el frontend real no comparte host con el backend real (cross-origin de verdad) |
| `VITE_BACKEND_URL` / `VITE_CLIENT_BACKEND_URL` | Cloudflare (variable de build, no en el repo) | A qué backend le habla el frontend ya desplegado |

### Checklist para un cambio que toca frontend y backend a la vez

1. Verifica en local primero (ver "Ejecución" arriba — modo 100% local para cambios de backend).
2. `git push origin main` — espera a que el build de Cloudflare termine solo (Deployments → Recent builds), sin usar "Retry build".
3. SSH a la VM → `git pull && docker compose up -d --build`.
4. Prueba en `https://condorfinder.cl` con datos reales.

---

## Uso

### Inicio de sesión (`/login`)

1. Abre http://localhost:8080 — sin sesión activa, redirige automáticamente a `/login`
2. Ingresa el usuario y contraseña sembrados en `backendModel/.env` (`SEED_ADMIN_USERNAME`/`SEED_ADMIN_PASSWORD`). La sesión se guarda en una cookie httpOnly y persiste aunque se reinicie el backend

### Vista Principal (`/`)

Dashboard con las zonas guardadas, las tareas del pipeline en curso o pendientes de análisis (consultadas directo al backend, ya no dependen de que el mismo navegador las haya iniciado), y el panel **"Recursos disponibles"** con el resumen de tolvas/retroexcavadoras/camiones/puntos/personal. Las zonas reemplazadas por un análisis más reciente de la misma zona física (HDU7) no aparecen en los filtros normales ni se cuentan en los totales — quedan disponibles aparte bajo el filtro **"Historial"**, con un subtítulo indicando por cuál análisis fueron reemplazadas.

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

13. **Definir punto**: clickea un punto en el mapa (o escribe una dirección) para ubicar un punto que el sistema usará como origen o destino de vehículos y maquinaria — dirección y comuna se completan solas vía geocodificación (Nominatim/OpenStreetMap), o puedes escribirlas a mano y el punto se reubica en el mapa automáticamente
14. Configura cantidad y capacidad individual de tolvas y camiones (no un valor agregado), y cantidad de retroexcavadoras y personal disponible
15. **Modificar puntos** lista todos los puntos guardados con opciones para editar o eliminar (con confirmación)
16. Cada punto tiene un switch de **punto activo** — solo los puntos activos participan en la generación de ruta (HDU5)

### Vista de Generación de Ruta (`/rutas`) — HDU5

17. **Cargar archivo de análisis** abre un listado de análisis guardados (HDU4) para seleccionar uno o más — cada fila completa es clickable y muestra si el análisis ya está cargado o no es ubicable; los análisis reemplazados por uno más reciente de la misma zona (HDU7, ver Vista Principal) no aparecen en este listado
18. Los análisis seleccionados se agregan al mapa como un círculo grande de color, ubicado en la posición geográfica real del ortomosaico (no depende de las detecciones puntuales, así dos análisis del mismo set de fotos caen siempre en el mismo lugar); un círculo **sólido** indica que ese análisis está cargado en la ruta actual, **hueco** que no lo está — click en un círculo ya cargado, o en su fila en la lista lateral "Análisis cargados", lo descarga
19. Pasar el mouse sobre un círculo muestra una miniatura del mapa real de esa zona con sus polígonos de detección superpuestos; hacer click abre una vista ampliada con el mapa completo, sus polígonos en precisión de píxel, y el resumen de volumen/peso/área
20. **Generar ruta** queda deshabilitado sin ningún análisis cargado
21. Al presionar, se pide confirmar los puntos activos, las horas disponibles y el tipo de basura prioritario — "Cancelar" cierra la confirmación sin tocar el mapa
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
│   │   ├── resources.ts            ← Cliente de puntos (HDU6)
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
│   ├── resources.py          ← Puntos y recursos (HDU6)
│   ├── routing.py            ← Base de generación de ruta (HDU5) — algoritmo pendiente
│   ├── analyses.py           ← Análisis guardados (HDU4) + fusión de duplicados (HDU7)
│   ├── task_store.py         ← Persistencia de tareas del pipeline en MongoDB
│   ├── storage.py            ← Cliente de Google Cloud Storage (resultados guardados en producción)
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
| HDU4 | Si el guardado falla, se notifica al usuario y el modal permite reintentar sin perder los datos ingresados | ✅ Cumplido (verificado simulando corte de red vía DevTools, con video) |
| HDU4 | Si el nombre ingresado ya existe, el sistema pide confirmar antes de sobrescribir el análisis existente | ✅ Cumplido |
| HDU5 | Dado un mapa interactivo con polígonos georreferenciados, cuando presione el botón de generar ruta, entonces aparecerá una pantalla de confirmación pidiendo el estado de los puntos de referencia, las horas disponibles y el tipo de basura prioritario, y preguntando si desea continuar o no | ✅ Cumplido |
| HDU5 | Dada una pantalla de confirmación, cuando se presione el botón de generar ruta, entonces el sistema generará una ruta óptima | 🔲 Pendiente (falta el algoritmo real de optimización en `backendModel/routing.py`) |
| HDU5 | Dado un mapa georreferenciado sin polígonos, cuando se esté visualizando el mapa, entonces el botón de generar ruta se encontrará deshabilitado | ✅ Cumplido |
| HDU5 | Dado un mapa georreferenciado, cuando se presione el botón de cargar archivo de análisis y se seleccione uno de los archivos guardados (HDU4), entonces el sistema cargará los polígonos asociados en el mapa junto con su metadata | ✅ Cumplido |
| HDU5 | Dada una pantalla de confirmación, cuando el trabajador presione "No" o cancele, entonces el sistema cerrará la pantalla de confirmación sin generar la ruta y sin perder el estado actual del mapa | ✅ Cumplido |
| HDU5 | Dada una pantalla de confirmación con los datos ingresados, cuando el sistema no logre generar una ruta factible con los recursos y restricciones indicadas, entonces mostrará un mensaje informando que no fue posible generar una ruta y sugerirá revisar los recursos disponibles (HDU6) | ✅ Cumplido |
| HDU6 | Al presionar "Definir punto" con el mapa georreferenciado, se puede ubicar un punto concreto que el sistema considera origen o destino de vehículos y maquinaria | ✅ Cumplido |
| HDU6 | Al escoger la ubicación se muestra una pantalla de configuración para definir cantidad y capacidad de tolvas, retroexcavadoras, camiones y personal disponibles | ✅ Cumplido |
| HDU6 | Al presionar "Guardar punto" en la configuración, el sistema lo guarda en el perfil del usuario actual (persistencia en MongoDB) | ✅ Cumplido |
| HDU6 | Al presionar "Modificar puntos" se enlistan todos los puntos guardados con su ubicación y opciones modificar/eliminar | ✅ Cumplido |
| HDU6 | Al presionar modificar sobre un punto de la lista, se muestra su configuración guardada y permite editarla | ✅ Cumplido |
| HDU6 | Al presionar eliminar sobre un punto de la lista, se muestra una pantalla de confirmación | ✅ Cumplido |
| HDU6 | Al confirmar la eliminación, el punto se borra de la lista del perfil | ✅ Cumplido |
| HDU6 | El recurso "camiones" permite ingresar cantidad y capacidad de carga individual de cada camión (no un valor agregado) | ✅ Cumplido |
| HDU6 | El recurso "personal" permite ingresar la cantidad de trabajadores disponibles | ✅ Cumplido |
| HDU7 (Deseable) | Fusión de detecciones entre cargas de la misma zona: al guardar un nuevo análisis, el sistema compara sus polígonos georreferenciados contra los análisis guardados y, si detecta >50% de superposición con uno anterior, permite marcarlos como duplicados o mantenerlos por separado | ✅ Cumplido |
| SP1 (Spike, 21 pts) | Investigación e implementación de mejoras al modelo de reconocimiento de imágenes: precisión ≥75% en detección/volumen, distinguir construcciones de basurales, mejorar el umbral de solapamiento. AC: dado un set de imágenes, cuando el trabajador genere el mapa georreferenciado, el sistema le dará la opción de elegir un modelo preciso y lento o uno más óptimo y rápido | ✅ Cumplido el AC del selector (verificado en vivo); el resto del spike (investigación de precisión ≥75%, distinguir construcciones de basurales) es de otros integrantes del equipo, estado a confirmar con ellos |

**Detalles adicionales de HDU4** (más allá del texto literal de los AC): reabrir un análisis ya guardado sobrevive a un F5 — antes, la identidad del análisis (`currentAnalysisId`/`currentAnalysisName`, de dónde sale si el botón dice "Guardar cambios" o "Guardar análisis") vivía solo en memoria de React, así que un F5 la perdía y ofrecía guardar el mismo análisis de nuevo como si fuera uno nuevo (duplicándolo), pese a que `mapUrl`/`thumbnailUrl` sí sobrevivían por estar en `sessionStorage`. Se corrigió persistiendo esa identidad también, y — en vez de intentar sincronizar cada campo derivado (estado, detecciones, resumen del banner de HDU7) por separado — un F5 sobre un análisis guardado simplemente vuelve a pedir el registro completo a Mongo con el mismo `id` persistido, la misma ruta que ya usa "Abrir análisis" desde Vista Principal.

**Detalles adicionales de HDU6** (más allá del texto literal de los AC): el recurso "tolvas" también permite capacidad individual por unidad, con el mismo modelo que camiones (no un valor de capacidad único compartido). Los puntos incluyen dirección y comuna, con geocodificación bidireccional vía Nominatim/OpenStreetMap: al ubicar un punto en el mapa se completan solas, y al escribir/corregir la dirección a mano el punto se reubica en el mapa automáticamente. Cada punto tiene además un switch de "punto activo" que HDU5 consume en la pantalla de confirmación.

**Detalles adicionales de HDU5** (más allá del texto literal de los AC): los polígonos de un análisis cargado no se dibujan literalmente sobre Leaflet (ilegibles a la escala de toda la comuna) — cada análisis se representa como un círculo grande de color, sólido si está cargado en la ruta actual y hueco si no, ubicado en el centro geográfico real del ortomosaico (`orthoCenter`, determinístico entre corridas del mismo set de fotos — ver HDU7 más abajo); al pasar el mouse se ve una miniatura con los polígonos superpuestos, y al hacer click se abre una vista ampliada con el mapa real en precisión de píxel. Esto sigue cumpliendo el AC4 literal ("cargará los polígonos asociados en el mapa junto con su metadata") sin perder precisión geográfica — el `geo_polygon` real (en su CRS UTM original) es el que efectivamente resuelve `POST /routes/generate` a partir de los `analysisIds` seleccionados, no algo que arme el navegador.

**Detalles adicionales de HDU7** (más allá del texto literal de los AC): la comparación de superposición corre en el backend (`shapely`, IoU real en metros — no en el navegador ni sobre bounding boxes en píxeles), comparando la **huella geográfica completa del ortomosaico** (`orthoBounds`) del análisis nuevo contra la de cada análisis guardado anterior con el mismo CRS, quedándose con el mejor candidato si supera el 50%. No compara las detecciones de basura individuales — se probó ese enfoque primero y resultó frágil: el mismo set de fotos produce un ortomosaico casi idéntico entre corridas (georreferenciado por GPS/EXIF, variación de un par de metros), pero las detecciones puntuales de YOLO pueden correrse esos mismos metros, suficiente para tirar el IoU muy por debajo de 50% en objetos chicos aunque sea la misma basura real. Comparando la imagen completa (decenas de metros de lado en vez de unos pocos m² por detección), esa misma variación de GPS queda como una fracción mínima, dejando el umbral de 50% con margen real. El "historial" del AC3 no es una vista aparte con datos duplicados: el análisis anterior se marca `historical` y sigue siendo el mismo documento, accesible desde Vista Principal bajo el filtro "Historial" — funciona igual con cadenas de varias zonas iguales encadenadas (A reemplazada por B, B reemplazada por C) y con múltiples pares de duplicados independientes coexistiendo, verificado en ambos casos.

**Detalles adicionales de SP1** (más allá del texto literal del AC): el selector de modelo se presenta como un modal (mismo patrón visual que "Agregar zona" en Vista Principal) que se abre al presionar "Generar mapa unificado" — elegir "Óptimo" o "Preciso" ahí cierra el modal y arranca la generación de inmediato con ese modo, en vez de un control aparte que hubiera que configurar antes. Verificar esto en vivo destapó un bug real preexistente en `backendModel/joining/joinOrtho.py`: el preset `presethigh` (modo "Preciso") nunca le pedía a NodeODM generar los modelos de elevación (`dtm`/`dsm`), a diferencia de `presetfast` que sí lo hacía — el mapa y las detecciones salían bien igual (no dependen de esos archivos), pero "Analizar volumen" fallaba siempre con "Archivos DEM no disponibles" en modo Preciso. Quedó dormido hasta esta verificación porque `opc` estaba hardcodeado a 0 (siempre `presetfast`) antes de que este AC lo conectara a la elección real del trabajador.

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
| Detección de duplicados (HDU7) | Shapely (IoU real entre huellas de ortomosaico georreferenciadas, backend) |
| Geodesia / reproyección | proj4 (UTM → WGS84, cliente) |
| Geocodificación | Nominatim (OpenStreetMap) |
| Despliegue frontend | Cloudflare Workers (dominio propio, deploy automático por push) |
| Despliegue backend | Docker Compose sobre GCP Compute Engine (deploy manual) |
| Almacenamiento de resultados | Google Cloud Storage |
| Base de datos en producción | MongoDB Atlas (mismo cluster que en desarrollo local) |

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
