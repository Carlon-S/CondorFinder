# CondorFinder

Sistema web municipal para el monitoreo automatizado de basurales mediante imágenes aéreas capturadas con drones. Desarrollado para la Municipalidad de Maipú como parte del proyecto de Ingeniería de Software de la Universidad Técnica Federico Santa María.

---

## Producción

El sistema está desplegado y funcionando en la nube, sin depender de `localhost`:

- **Frontend**: [https://condorfinder.cl](https://condorfinder.cl), Cloudflare Workers, desplegado automáticamente con cada `git push` a `main`.
- **Backend**: `https://api.condorfinder.cl`, VM de Google Cloud (`southamerica-west1`, Santiago) con Docker Compose; el despliegue **no** es automático, requiere entrar por SSH y correr `git pull && docker compose up -d --build`.

Todo lo que sigue en este documento (Requisitos, Instalación, Ejecución) describe cómo levantar el sistema **en local para desarrollo**, no es necesario para usar la aplicación ya desplegada. Cómo subir cambios a producción está en la sección [Despliegue a producción](#despliegue-a-producción) más abajo; detalles adicionales de la infraestructura están en `CLAUDE.md`.

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
| Cliente OAuth de Google | gratuito | servicio externo, necesario para poder iniciar sesión |

> El frontend se levanta en **Windows**. El backend y Docker se ejecutan en **WSL (Ubuntu)**. El backend usa MongoDB Atlas para persistir usuarios, tareas del pipeline, zonas, puntos, recursos, itinerario y análisis: crea un cluster gratuito en https://www.mongodb.com/cloud/atlas antes de continuar.

> **El sistema no tiene usuarios propios.** La identidad la emite un proveedor externo por OpenID Connect, así que para entrar hace falta al menos un cliente OAuth configurado. Para desarrollo local existe una salida sin eso (`ALLOW_PASSWORD_LOGIN`), descrita más abajo.

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

**Obligatorias**, sin ellas el backend no arranca:

| Variable | Descripción |
|---|---|
| `MONGODB_URI` | Connection string del cluster de Atlas (Database → Connect → Drivers) |
| `MONGODB_DB_NAME` | Nombre de la base dentro del cluster (se crea sola en el primer insert, ej. `condorfinder`) |
| `JWT_SECRET` | Secreto para firmar la sesión, genera uno con `python -c "import secrets; print(secrets.token_hex(32))"` |

**Para poder iniciar sesión.** Cada proveedor necesita sus **dos** credenciales: con una sola, ese botón no se ofrece, para que un `.env` a medio llenar no deje el login en un estado que nadie quiso.

| Variable | Descripción |
|---|---|
| `GOOGLE_OIDC_CLIENT_ID` / `GOOGLE_OIDC_CLIENT_SECRET` | Cliente OAuth de tipo **Aplicación web** (console.cloud.google.com → Google Auth Platform → Clientes) |
| `AUTH_EMAILS_PERMITIDOS` | Correos autorizados a entrar por Google, separados por coma |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | Registro **multiinquilino** en Microsoft Entra ID (opcional en desarrollo) |
| `AUTH_MS_TENANTS` | Identificadores de directorio (`tid`) autorizados, separados por coma |

En la consola de cada proveedor hay que registrar la URI de retorno, y tiene que coincidir **exacta**:

```
http://localhost:8000/auth/oidc/google/callback
http://localhost:8000/auth/oidc/microsoft/callback
```

**Alternativa sin cuentas externas.** Para levantar el proyecto sin configurar nada de esto:

```
ALLOW_PASSWORD_LOGIN=true
SEED_ADMIN_USERNAME=admin
SEED_ADMIN_PASSWORD=<una contraseña>
```

Devuelve el login por contraseña y siembra ese usuario al arrancar. **Sin esa bandera, `/auth/login` responde 404 y no se siembra nada.** No se usa en producción: ahí está SSH, que es mejor puerta de emergencia que un usuario con contraseña expuesto en internet.

> `backendModel/.env` está en `.gitignore`, nunca se sube al repositorio. Solo `.env.example` (con placeholders) se versiona.

---

## Ejecución

El sistema requiere **tres terminales corriendo simultáneamente**.

### Terminal 1: NodeODM (WSL)

```bash
docker run -ti -p 3000:3000 opendronemap/nodeodm
```

Espera hasta ver:
```
info: Server has started on port 3000
```

Mantén esta terminal abierta durante todo el uso del sistema.

### Terminal 2: Backend (WSL)

Abre una nueva terminal WSL, navega a la raíz del proyecto y ejecuta:

```bash
source backendModel/joining/venv/bin/activate
backendModel/joining/venv/bin/uvicorn backendModel.orquestador:app --port 8000
```

> **Importante:** no uses `--reload`. El flag de recarga automática mata el hilo que corre el pipeline a mitad de proceso, el estado de la tarea sobrevive un reinicio (se persiste en MongoDB), pero un hilo interrumpido no se puede retomar solo.

Espera hasta ver:
```
INFO: Application startup complete.
```

### Terminal 3: Frontend (Windows PowerShell)

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

La app en `http://localhost:8080` va a hablar con el backend real (login, zonas guardadas, recursos, todo con datos reales de producción) sin necesitar NodeODM ni el backend local. **No sirve para probar cambios de backend que todavía no subiste a la VM**, para eso, el modo 100% local de arriba es el único que funciona, porque ahí sí estás corriendo tu propio código modificado.

> Recuerda volver a comentar la línea de producción y descomentar la de `localhost` cuando quieras volver al modo 100% local, es fácil olvidarlo y quedar sin querer apuntando siempre a producción.

---

## Despliegue a producción

El sistema vive en `https://condorfinder.cl` (frontend) y `https://api.condorfinder.cl` (backend). **Frontend y backend se despliegan de formas completamente distintas**, no asumas que un `git push` alcanza para todo.

### Frontend: automático

Cloudflare Workers está conectado directamente a este repositorio de GitHub. Cada `git push origin main` dispara un build y deploy automático, no hay que hacer nada más ahí:

```powershell
git add <archivos-modificados>
git commit -m "..."
git push origin main
```

**Cuidado con el botón "Retry build"** en el dashboard de Cloudflare (Compute → `condorfinder` → Deployments): repite el build de un commit **específico que ya existía**, no trae el código más reciente del repo. Si un build falla y quieres reintentarlo, primero confirma en "Recent builds" que ese build corresponda al commit que esperas, si el push más reciente ya generó su propio build (aunque sea en paralelo), usar "Retry build" sobre uno viejo puede terminar sirviendo código desactualizado sin ningún error visible.

Para confirmar qué versión está realmente activa: **Deployments → Version History**, la fila de arriba (100% de tráfico) debe corresponder al commit más reciente que esperas.

Las variables de entorno del build (`VITE_BACKEND_URL`, `VITE_CLIENT_BACKEND_URL`) se configuran en Cloudflare, **no** en este repo: **Settings → Builds → Variables and secrets**.

### Backend: manual

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

Ninguna de estas existe en tu `backendModel/.env` local, todas tienen un valor por defecto seguro para desarrollo cuando faltan, así que no rompen nada en local si nunca las agregas ahí:

| Variable | Dónde vive | Para qué sirve |
|---|---|---|
| `PUBLIC_BASE_URL` | VM | Base de las URLs que el backend arma en sus respuestas (`result_url`, `thumbnail_url`, etc.) |
| `GCS_BUCKET_NAME` | VM | Activa la subida de resultados a Google Cloud Storage en vez de solo disco local |
| `NODEODM_HOST` | VM | Nombre del servicio de NodeODM dentro de la red de Docker (`nodeodm`, no `localhost`) |
| `EXTRA_CORS_ORIGINS` | VM | Orígenes del frontend desplegado que CORS debe permitir, además de `localhost:8080` |
| `COOKIE_SECURE` / `COOKIE_DOMAIN` | VM | Necesarias porque el frontend real no comparte host con el backend real (cross-origin de verdad) |
| `VITE_BACKEND_URL` / `VITE_CLIENT_BACKEND_URL` | Cloudflare (variable de build, no en el repo) | A qué backend le habla el frontend ya desplegado |

### Checklist para un cambio que toca frontend y backend a la vez

1. Verifica en local primero (ver "Ejecución" arriba, modo 100% local para cambios de backend).
2. `git push origin main`, espera a que el build de Cloudflare termine solo (Deployments → Recent builds), sin usar "Retry build".
3. SSH a la VM → `git pull && docker compose up -d --build`.
4. Prueba en `https://condorfinder.cl` con datos reales.

---

## Uso

### Inicio de sesión (`/login`)

1. Abre http://localhost:8080, sin sesión activa, redirige automáticamente a `/login`
2. **Nadie escribe una contraseña en este sistema.** La identidad la emite un proveedor externo por OpenID Connect y el backend solo decide quién entra:
   - **Microsoft**, la entrada del cliente: se acepta a quien venga del directorio de la Municipalidad de Maipú, comparando el `tid` del token. Un funcionario nuevo entra el día que su TI le crea la cuenta, y deja de entrar el día que se la cierran, sin que nadie toque el sistema
   - **Google**, la entrada del equipo de desarrollo, por lista nominal de correos. Está detrás de un enlace discreto al pie: el funcionario municipal tiene que ver **un** camino, y con los dos botones a la vista el de Google es el que no le sirve y el que reconoce
3. La sesión se guarda en una cookie httpOnly y persiste aunque se reinicie el backend

> La pantalla no nombra al cliente ni explica cómo está organizado el acceso: eso le contaría a cualquiera que abra la página quién es el cliente y por dónde se entra.

### Vista Principal (`/`)

Dashboard con todo lo que la municipalidad administra: las zonas con análisis guardado, las tareas del pipeline en curso o pendientes (consultadas directo al backend, ya no dependen de que el mismo navegador las haya iniciado), y **los puntos permanentes todavía sin vuelo**, bajo el filtro "Sin vuelo".

Cada fila muestra el mapa, el nombre de la zona, su **dirección**, la **fecha y hora** de creación, y volumen, peso y área cuando hay medición. Una zona sin vuelo muestra `-` en las tres cifras y no suma a los totales, pero sí cuenta como zona registrada: hasta HDU14 la tabla decía que la municipalidad administra dos lugares, cuando conoce 54 microbasurales y le voló el dron a dos.

El lápiz del nombre abre el **formulario completo** de la zona (nombre, dirección, barrio, tipo, frecuencia), que es el mismo de la vista de itinerario.

Las zonas reemplazadas por un análisis más reciente de la misma zona física (HDU7) no aparecen en los filtros normales ni se cuentan en los totales, quedan aparte bajo el filtro **"Historial"**, con un subtítulo indicando por cuál análisis fueron reemplazadas.

> El panel **"Recursos disponibles"** ya no está acá, ni como columna ni como panel deslizante: HDU6 tiene su propia página completa y este resumen era una tercera copia de las mismas cifras compitiendo con lo único que esta vista tiene que mostrar.

### Vista de Carga (`/carga`)

1. Arrastra o selecciona las imágenes JPG tomadas con drone (mínimo 16)
2. Las imágenes se suben automáticamente al backend mientras se generan sus thumbnails, el bloque de imágenes adjuntas muestra un spinner por imagen hasta que el thumbnail esté listo
3. El sistema valida el formato y la cantidad antes de habilitar la generación
4. Presiona **Generar mapa unificado**, el proceso pasa por cuatro fases secuenciales: verificación de solapamiento (~60%), unificación con ODM, detección con YOLOv8 y cálculo automático de volúmenes
5. Al terminar, el mapa aparece en el visor con los polígonos de detección superpuestos:
   - Si se detectó basura: el mapa es clicable y navega a la vista de análisis
   - Si no se detectó basura: el mapa igual se muestra con un aviso informativo

> El estado de la tarea persiste en MongoDB. Si navegas a otra vista, recargas la página o incluso reinicias el backend durante la generación, el estado se sincroniza al volver (una tarea que estaba a mitad de pipeline exactamente cuando el backend se reinició queda marcada como error, con mensaje claro, en vez de mostrar progreso colgado).

### Vista de Análisis (`/analysis`)

6. Accede desde el mapa generado o directamente desde la barra de navegación
7. Las zonas detectadas aparecen en la lista, puedes activar o desactivar cada una antes de analizar
8. Presiona **Analizar volumen** para revelar los resultados ya calculados durante la generación
9. Los polígonos se colorean con un degradé **verde → rojo** según su volumen relativo (más rojo = mayor volumen)
10. Zonas solapadas se fusionan automáticamente como **"Varios tipos"** mostrando el desglose por cada clase contenida
11. Si el mapa no contenía basura detectada, el botón de análisis queda deshabilitado y se muestra un aviso
12. **Guardar análisis** le pide un nombre y lo agrega al listado de análisis disponibles del sistema (pide confirmación antes de sobrescribir si el nombre ya existe)
13. **Fusión de duplicados (HDU7)**: si el análisis recién guardado (o uno reabierto desde el listado) se superpone más de un 50% en área con un análisis guardado anteriormente, aparece un aviso comparando el volumen de ambos, "Es la misma zona" vincula ambos registros y envía el anterior al historial de Vista Principal; "Son zonas distintas" cierra el aviso y mantiene ambos registros por separado

### Vista de Recursos (`/planificacion/recursos`): HDU6 + HDU8

13. El formulario de alta está **abierto desde el principio**: ubicar el punto es un campo más, no un modo detrás de un botón. Clickea en el mapa o escribe la dirección con el autocompletado, y la comuna y la coordenada se completan solas
14. El mapa dibuja además **las zonas guardadas** como círculos violeta: un punto de origen no se ubica en el vacío sino respecto de los basurales que hay que ir a retirar
15. La **tabla de puntos al pie** reemplazó el modo "Modificar puntos": un punto se compara con otro por sus cifras, y eso necesita filas
16. Cada punto tiene un switch de **punto activo**, y es el único lugar del sistema donde ese interruptor cambia un resultado: un punto inactivo no participa en la generación de ruta
17. Entrando a un punto se abre **su flota** (HDU8): las unidades individuales con tipo, patente, capacidad, dotación requerida y disponibilidad, con acciones para poner todas disponibles o ninguna de una vez

> Los contadores agregados de HDU6 (tolvas, retroexcavadoras, camiones) **ya no existen**: eran otra forma de declarar lo mismo que los recursos individuales, sin manera de saber cuál mandaba.

### Vista de Generación de Ruta (`/rutas`): HDU5

17. **Cargar archivo de análisis** abre un listado de análisis guardados (HDU4) para seleccionar uno o más, cada fila completa es clickable y muestra si el análisis ya está cargado o no es ubicable; los análisis reemplazados por uno más reciente de la misma zona (HDU7, ver Vista Principal) no aparecen en este listado
18. Los análisis seleccionados se agregan al mapa como un círculo grande de color, ubicado en la posición geográfica real del ortomosaico (no depende de las detecciones puntuales, así dos análisis del mismo set de fotos caen siempre en el mismo lugar); un círculo **sólido** indica que ese análisis está cargado en la ruta actual, **hueco** que no lo está, click en un círculo ya cargado, o en su fila en la lista lateral "Análisis cargados", lo descarga
19. Pasar el mouse sobre un círculo muestra una miniatura del mapa real de esa zona con sus polígonos de detección superpuestos; hacer click abre una vista ampliada con el mapa completo, sus polígonos en precisión de píxel, y el resumen de volumen/peso/área
20. **Generar ruta** queda deshabilitado sin ningún análisis cargado
21. Al presionar, se pide confirmar los puntos activos, las horas disponibles y el tipo de basura prioritario, "Cancelar" cierra la confirmación sin tocar el mapa
22. El sistema genera la ruta óptima, o informa que no fue posible generarla y sugiere revisar los recursos disponibles (`/recursos`)

23. El plan se muestra como una **línea de tiempo** por recorrido: salida, cada parada con su volumen, peso y tipos de residuo, el tramo cargado hacia el relleno sanitario, y el regreso vacío. Cada vehículo del tramo aparece con su patente, capacidad, dotación y foto

> **El algoritmo está implementado** (`backendModel/routing.py` + `osrm_client.py`): elige origen por capacidad, reparte paradas por cercanía, ordena contra una matriz real de OSRM y rutea `base → zonas → relleno sanitario → base`. El relleno es el Relleno Sanitario Santiago Poniente, confirmado por escrito por la municipalidad.
>
> Desde HDU5.1 el plan **no se rinde entero**: una zona que no cabe se retira a medias, y las que quedan fuera viajan con su motivo en texto. La estrella de cada zona cargada la marca como prioritaria, que es el único lugar donde una persona puede decirle al algoritmo algo que él no puede saber (una denuncia, un colegio al lado, un riesgo sanitario).

### Vista de Itinerario (`/planificacion/itinerario`): HDU14

24. Un **calendario semanal** de lunes a sábado, con el mes a la izquierda para elegir qué semana se planifica
25. **Crear punto permanente** abre el formulario con nombre, dirección, barrio, tipo (Microbasural o VIRS) y frecuencia de atención
26. El `+` de cada columna abre el catálogo de puntos, con buscador y selección múltiple; también se puede **arrastrar** una fila de la tabla del pie a un día, o una tarjeta de un día a otro
27. El orden dentro de la columna es la **secuencia del recorrido**, y se reordena arrastrando
28. **Copiar semana anterior** trae el reparto de la semana previa, mostrando antes qué llega y qué se pierde
29. La tabla del pie lista todos los puntos con sus campos y **en cuántos días está cada uno esta semana**, que es lo que permite contrastar el reparto contra la frecuencia declarada

> **Un día que ya pasó no se planifica**: se dibuja atenuado, sin `+` ni arrastre, y el backend además rechaza la escritura. Una semana cuyo sábado quedó atrás se marca como "Cerrada". El reparto de una jornada terminada es el registro de lo que se hizo, no un plan.

### Puntos diarios de retiro (`/planificacion/rutas`): HDU15

30. **Crear punto diario** pide primero el tipo: **escombros** (fono escombros, con tipo de residuo y cantidad declarada) o **extras** (retiros a requerimiento, con el programa y el solicitante)
31. Los 17 programas vienen de la hoja `SOLICITUDES` de la planilla municipal, y se pueden agregar más
32. Aparecen en el mapa como círculos ámbar, fuera de la escala de las zonas y del navy de los puntos de origen
33. **Editar puntos** lista los del día y permite modificarlos o eliminarlos

> La cantidad que declara quien llama **no** es el volumen retirado. La planilla trae las dos columnas y en sus hojas coinciden porque se llenan al final del día, pero son dos hechos distintos: acá solo se captura el primero.

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
│   │   ├── GoogleMapImpl.tsx       ← Mapa de Google (misma interfaz que el de Leaflet)
│   │   ├── ResourcesSummaryPanel.tsx ← Panel "Recursos disponibles" (/recursos y /rutas)
│   │   ├── PuntoPermanenteDialog.tsx ← HDU14: alta y edición de un punto permanente
│   │   ├── PuntoDiarioDialog.tsx   ← HDU15: alta y edición de un retiro del día
│   │   ├── ConfirmarBorrado.tsx    ← Confirmación compartida de las acciones que no se deshacen
│   │   ├── Obligatorio.tsx         ← El asterisco de campo obligatorio, con su texto para lectores
│   │   ├── RenameDialog.tsx        ← Renombrar una zona o una versión
│   │   ├── RouteTimeline.tsx       ← HDU5: el recorrido como secuencia de tramos y paradas
│   │   ├── ZoneZoomDialog.tsx      ← Vista ampliada de una zona, compartida entre vistas
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
│   │   ├── resources.ts            ← Cliente de puntos y flota (HDU6 + HDU8)
│   │   ├── routePlan.ts            ← Contrato de generación de ruta (HDU5)
│   │   ├── itinerario.ts           ← Cliente del itinerario semanal (HDU14)
│   │   ├── puntosDiarios.ts        ← Cliente de retiros del día (HDU15)
│   │   ├── crewState.ts            ← La cuadrilla declarada al generar (HDU5.1, localStorage)
│   │   ├── volumeReport.ts         ← Aritmética compartida del informe y la evolución
│   │   └── pdfReport.ts            ← Informe PDF con gráficos vectoriales (HDU9)
│   ├── routes/                     ← Vistas principales (file-based routing)
│   │   ├── __root.tsx              ← Shell de la app (layout, temas, anti-flash)
│   │   ├── login.tsx               ← Login (única ruta sin sesión)
│   │   └── _authed/                ← Rutas protegidas (redirige a /login sin sesión)
│   │       ├── index.tsx           ← Vista Principal
│   │       ├── carga.tsx           ← HDU1: Carga de imágenes + pipeline
│   │       ├── analysis.tsx        ← HDU2/HDU3/HDU4: Análisis de volumen + guardado
│   │       ├── planificacion.recursos.tsx          ← HDU6: puntos de origen
│   │       ├── planificacion.recursos_.$pointId.tsx ← HDU8: la flota de un punto
│   │       ├── planificacion.itinerario.tsx        ← HDU14: itinerario semanal
│   │       └── planificacion.rutas.tsx             ← HDU5 + HDU15: ruta óptima y retiros del día
│   └── styles.css                  ← Estilos globales, tokens del tema, overlays de mapa
├── backendModel/
│   ├── orquestador.py       ← API FastAPI principal (pipeline + wiring de routers)
│   ├── auth.py               ← Login/sesión (JWT en cookie httpOnly)
│   ├── resources.py          ← Puntos y recursos (HDU6)
│   ├── routing.py            ← Generación de ruta (HDU5 + HDU5.1)
│   ├── osrm_client.py        ← Matriz de tiempos y geometría de calles (OSRM)
│   ├── routes_provider.py    ← Elige entre OSRM y Google Routes sin que routing.py lo sepa
│   ├── google_routes_client.py ← Tiempos con tráfico (HDU5.1/AC5, apagado por omisión)
│   ├── google_places.py      ← Autocompletado y geocodificación, con la clave del lado servidor
│   ├── street_view.py        ← La foto real del lugar de cada punto de origen
│   ├── analyses.py           ← Zonas y análisis guardados (HDU4 + HDU14) + duplicados (HDU7)
│   ├── itinerario.py         ← Itinerario semanal de puntos permanentes (HDU14)
│   ├── puntos_diarios.py     ← Retiros de escombros y extras del día (HDU15)
│   ├── oidc.py               ← Protocolo OpenID Connect, común a los dos proveedores
│   ├── auditoria.py          ← Bitácora de acciones destructivas
│   ├── rate_limit.py         ← Límite de peticiones por ventana deslizante
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
├── docs/
│   └── unificacion-puntos-zonas.md  ← Plan de entrada a HDU5.2 (ver Sprint 3)
├── docker-compose.yml        ← Despliegue en la VM: backend, NodeODM y Caddy
├── Caddyfile                 ← TLS real en el origen (Let's Encrypt)
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
| HDU5 | Dada una pantalla de confirmación, cuando se presione el botón de generar ruta, entonces el sistema generará una ruta óptima | ✅ Cumplido (`routing.py` + `osrm_client.py`: ruta real por calles, `base → zonas → relleno → base`) |
| HDU5 | Dado un mapa georreferenciado sin polígonos, cuando se esté visualizando el mapa, entonces el botón de generar ruta se encontrará deshabilitado | ✅ Cumplido |
| HDU5 | Dado un mapa georreferenciado, cuando se presione el botón de cargar archivo de análisis y se seleccione uno de los archivos guardados (HDU4), entonces el sistema cargará los polígonos asociados en el mapa junto con su metadata | ✅ Cumplido (el botón se llama **"Cargar zona"**, no "Cargar archivo de análisis": ver nota abajo) |
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

> **HDU7 cambió de ROL, no de código.** Desde que un vuelo declara su punto antes de subir las imágenes (unificación de puntos y zonas, Fase 0), dos vuelos del mismo lugar ya no pueden crear zonas distintas por accidente: la zona viene dicha. La detección de duplicados por IoU de huellas deja entonces de ser *lo que evita el problema* y pasa a cubrir el caso en que alguien declaró mal. **Su implementación no se tocó y no hay que borrarla**: sigue siendo la única red para una declaración equivocada, y se anota acá justamente para que nadie la lea como redundante.
| SP1 (Spike, 21 pts) | Investigación e implementación de mejoras al modelo de reconocimiento de imágenes: precisión ≥75% en detección/volumen, distinguir construcciones de basurales, mejorar el umbral de solapamiento. AC: dado un set de imágenes, cuando el trabajador genere el mapa georreferenciado, el sistema le dará la opción de elegir un modelo preciso y lento o uno más óptimo y rápido | ✅ Cumplido el AC del selector (verificado en vivo); el resto del spike (investigación de precisión ≥75%, distinguir construcciones de basurales) es de otros integrantes del equipo, estado a confirmar con ellos |

> **Tres criterios de HDU5 y HDU6 ya no describen la pantalla, y es evolución deliberada.** Se anotan acá en vez de dejarlos divergir en silencio:
>
> - **"Cargar archivo de análisis" ahora se llama "Cargar zona"**. Lo que se elige no es un archivo (nada se sube ni se descarga: son registros en la base) ni un análisis suelto, sino la zona cuyos basurales entran a la ruta. El criterio sigue cumpliéndose en lo que pide, cargar los polígonos con su metadata.
> - **"Definir punto" desapareció** (el formulario está abierto desde el principio) y **"Modificar puntos" también** (la tabla de puntos al pie reemplazó ese modo).
> - **El campo `personal` del punto se quitó del formulario.** La pregunta que importa no es cuánta gente tiene el punto sino quién va en cada tramo, y eso es HDU5.1. El valor sigue guardado y se conserva al editar.

---

## Estado de Sprint 2

Historias comprometidas: HDU5.1 (13), HDU8 (5), HDU9 (5), HDU10 (5) y SP2 (13). Suman 41 puntos sobre un mínimo de 40, porque el ramo comunicó un cambio respecto al plan y bajó el mínimo del Sprint 2 de 50 a 40.

> **HDU9 y HDU10 verificadas end to end** (2026-09-20), recorriendo los ocho criterios sobre tres zonas reales: una con dos capturas de la misma zona y otra con una sola. El recorrido destapó cinco defectos, todos corregidos y vueltos a probar:
>
> - El archivo de detecciones se borraba del disco al subirse a la nube, así que el análisis ya no lo encontraba. Al calcularse dentro del pipeline se enriquecía antes de subir y el problema no existía.
> - El modo solo lectura se derivaba de la presencia de los modelos de elevación, pero la poda solo corre al generar y respeta los vuelos sin análisis guardado: una versión reemplazada podía conservarlos y quedaba medible. Ahora se deriva de `historical`.
> - Rechazar un duplicado no deshacía la zona ya heredada, así que la evolución de una zona mostraba la historia de otra.
> - El mensaje del AC4 de HDU9 colgaba de un elemento deshabilitado, que no emite eventos de puntero: existía y era inalcanzable.
> - El botón de evolución se ocultaba con una sola captura, lo que dejaba el AC3 de HDU10 sin forma de alcanzarse.

> **HDU8 verificada end to end** (2026-10-01), sobre la flota real del punto Gral. José San Martín 2730: 21 unidades en 9 tipos. Los cinco criterios, diez casos borde y tres regresiones, con los datos definitivos cargados.
>
> Las capacidades que faltaban las **confirmó la Municipalidad de Maipú por escrito** (respuesta del 30-09-2026 a la consulta del equipo): AMPLIROLL `1151` y `1179` con 20 m³, MINICARGADOR `1861` y `1865` con balde de 0,5 m³, RETRO `1993` con balde de 1 m³, y CARRO RECICLAJE `659` y `660` con 30 m³. La capacidad de transporte del punto pasó de 60 a **100 m³**.
>
> El recorrido destapó dos defectos y un supuesto equivocado:
>
> - **Las detecciones desactivadas se contaban en los dos lados.** En la vista de rutas, el volumen de una zona podía no coincidir con el que muestran Vista Principal y la vista de análisis, que sí respetan la bandera `enabled`. Y `routing.py::_load_route_stops` tenía exactamente el mismo defecto, así que el plan tampoco estaba bien: el ruteo decidía qué cabía con un volumen mayor al que el propio sistema mostraba en pantalla. Corregido en los dos.
> - El total de volumen no cuadraba con su propio detalle: sumaba los valores sin redondear y redondeaba después, mientras cada fila redondeaba antes. Con dos zonas de 3,33 y 3,61 la cabecera decía 6,9. Ahora suma lo que las filas muestran.
> - La validación de recursos impedía que una unidad de familia `arrastre` declarara capacidad de carga, confundiendo **transportar** con **moverse solo**. Un carro de reciclaje lleva 30 m³ y necesita que alguien lo tire: las dos cosas son ciertas. La regla ahora acepta `carga` y `arrastre`, y el ruteo sigue filtrando solo por `carga`, así que un carro declara su capacidad sin sumarla a ninguna ruta.
>
> **HDU8 queda cerrada con la segunda ronda de respuestas** (02-10-2026), que entregó el único dato que faltaba y obligó a un cambio de modelo.
>
> La capacidad del CAMION 3/4 PLANO `1163` y `1429` es de **1 tonelada**, no un volumen, y vino con una instrucción explícita: *"este vehículo no tiene fines de retiro de escombros, sino más bien de reciclaje (cajas y embalajes, colchones), por lo que no sería prudente incorporarlo a las rutas que estamos trabajando"*. En la misma ronda dieron el límite del AMPLIROLL, **15 toneladas**, por la maniobra de descarga.
>
> Eso descubrió que el sistema modelaba un solo límite. Un camión tiene **dos**: cuánto le entra y cuánto peso aguanta. Se agregó `capacidad_ton` al recurso, con la misma regla de familia que el volumen. No cambia ninguna ruta todavía, porque el reparto es por m³; es el campo que el AC4 de HDU5.1 va a contrastar contra el `weight_kg` que el sistema ya calcula por detección.
>
> Con eso, los dos camiones dejan de reportarse como un hueco: **declaran su capacidad, solo que en otra magnitud**. `motivoFueraDeRuta()` tiene ahora un motivo propio para ese caso, y el desglose del punto pasa a reconciliar como 8 cuentan + 2 declaran toneladas + 4 se remolca + 7 no transporta = 21, con la capacidad de transporte intacta en 100 m³.
>
> **Dos cosas quedan anotadas y sin resolver, y no se puede repreguntar.** Primero, una contradicción: el 30-09 dieron 30 m³ para los CARRO RECICLAJE `659` y `660`, y el 02-10 respondieron que *"no existen carros de reciclaje, los camiones PLANOS ¾ son los de reciclaje"*. Las dos unidades están en la planilla oficial, así que se dejan registradas; no afectan ninguna ruta porque son familia `arrastre`. Segundo, el **convoy**: que el AMPLIROLL remolque los carros, que el minicargador necesite uno y que la retroexcavadora y el frontal se trasladen por su cuenta. Nada de eso está en ningún criterio de ninguna historia, así que es alcance a acordar con el equipo y no algo que HDU8 pueda cerrar.

### HDU5.1: qué falta en cada criterio, y con qué API

Mapa de los siete criterios contra lo que hay que escribir y lo que cuesta. **Seis de los siete no necesitan ninguna API externa**, y el único que sí es el de tráfico.

**Estado: los 7 implementados.** AC1, AC2, AC3, AC4, AC6 y AC7 verificados end to end. **AC5 está implementado y apagado por omisión**: su código está escrito y probado, pero depende de una clave de Google que se cobra por llamada, así que mientras `ROUTES_PROVIDER` no diga `google` el sistema calcula a flujo libre y se comporta igual que antes. Lo que falta para encenderlo no es programar, es configurar la cuota y la clave en GCP.

> **AC3 y AC4 verificados end to end** (2026-10-04), con sus casos borde y regresiones. La verificación encontró cinco defectos, todos corregidos: el plan salía con capacidad insuficiente cuando ninguna combinación de vehículos cubría la carga; el peso estaba modelado como filtro por vehículo en vez de restricción del conjunto, así que dos amplirolls nunca se complementaban; el campo de peso no dejaba escribir decimales menores a uno; la tabla de flota quedó desalineada al agregar la columna de autonomía; y el `infeasible` por "ninguna zona sobrevivió" descartaba los motivos ya calculados.
>
> **Dos puntos quedan declarados como no verificables con los datos actuales**, y es deliberado: el filtro de ÓRDENES de AC3 (las zonas guardadas están demasiado próximas para que dos recorridos difieran en distancia) y la autonomía en producción, que no corta nada porque la municipalidad respondió que ese límite no existe en su flota. El criterio está implementado y es demostrable declarando una autonomía baja.

| # | Criterio | Estado | Qué falta implementar | API | Costo |
|---|---|---|---|---|---|
| AC1 | Personal completo | ✅ | — | Ninguna | $0 |
| AC2 | Un perfil no cubre dos vehículos a la vez | ✅ | — | Ninguna | $0 |
| AC3 | Autonomía | ✅ | — | Ninguna | $0 |
| AC4 | Tipo de residuo | ✅ | — | Ninguna | $0 |
| AC5 | Tráfico vigente | ✅ apagado | — (implementado; falta habilitar la clave) | **Routes API** (`Compute Routes Pro`) | $0 con cuota |
| AC6 | Zonas sin asignar con motivo | ✅ | — | OSRM (ya en uso) | $0 |
| AC7 | Vehículo y personal por tramo | ✅ | — | Ninguna | $0 |

**Por qué solo el AC5 necesita una API.** La pregunta que lo decide es dónde vive el dato que falta. El rango de un camión es un dato de la flota municipal y la distancia del recorrido ya la devuelve OSRM; el residuo de una zona lo produce el propio detector y lo que puede llevar cada vehículo lo respondió la municipalidad por escrito. En cambio, **a qué velocidad se avanza por una avenida ahora mismo** no lo tiene el sistema ni la municipalidad, y no se deduce de nada: solo puede medirlo quien tiene millones de dispositivos reportando posición. OSRM calcula a flujo libre, asume la calle vacía siempre. Se paga una API cuando el dato está afuera y no se puede producir.

**Las APIs que el sistema ya usa**: OSRM (`osrm_client.py`, matriz de tiempos y geometría de calles) y Nominatim (`geocoding.ts`, dirección ↔ coordenada). Las dos gratuitas y sin clave.

#### Por qué el AC5 no puede resolverse con lo que hay

OSRM calcula a **flujo libre**: no sabe que hay taco. Ningún ajuste local lo arregla.

Los números verificados contra la documentación de Google (02-10-2026):

| SKU | ID | Gratis/mes | Tras el tope | Unidad |
|---|---|---|---|---|
| Compute Routes Essentials | `9EFF-679A-9B16` | 10.000 | $5,00 / 1.000 | por llamada |
| **Compute Routes Pro** | `02F7-1B55-DC90` | **5.000** | $10,00 / 1.000 | por llamada |
| Compute Routes Enterprise | `6EBD-08E5-319A` | 1.000 | $15,00 / 1.000 | por llamada |
| Compute Route Matrix Pro | `2E25-887A-DAD4` | 5.000 | $10,00 / 1.000 | **por elemento** |
| RouteOptimization FleetRouting | — | 1.000 | $30,00 / 1.000 | por solicitud |

**El SKU lo decide la función más cara de cada solicitud**, no un cargo aparte. `TRAFFIC_AWARE` y `TRAFFIC_AWARE_OPTIMAL` suben la petición a **Pro**, así que el techo gratis del AC5 es 5.000 y no 10.000. El antiguo crédito recurrente de 200 USD/mes **ya no existe**: lo reemplazaron por estos topes por SKU.

Qué activa cada nivel, según la página de detalles de SKU:

| Nivel | Lo activa |
|---|---|
| Pro | `TRAFFIC_AWARE` / `TRAFFIC_AWARE_OPTIMAL`, 11 a 25 paradas intermedias, `optimizeWaypointOrder`, modificadores de ubicación |
| Enterprise | Vehículos de dos ruedas, cálculo de peajes, **información de tráfico sobre las polilíneas** |

Esa última fila es la que descarta los colores de congestión sobre el trazo: ver "Colores de congestión, evaluados y descartados" más abajo.

**La decisión que define el costo es dónde queda la matriz**, y la segunda es cómo se piden los tres tramos:

| Reparto | Consumo por generación | Generaciones gratis/mes |
|---|---|---|
| **Una llamada con paradas intermedias, matriz en OSRM** | **1 llamada** | **5.000** |
| Tres llamadas (un tramo cada una), matriz en OSRM | 3 llamadas | 1.666 |
| Todo en Google, 2 zonas cargadas | 1 llamada + 16 elementos | 312 |
| Todo en Google, 5 zonas cargadas | 1 llamada + 49 elementos | **102** |

Route Matrix se cobra **por elemento** (orígenes × destinos), así que crece al cuadrado con las zonas. Por eso la matriz se queda en OSRM, y por eso `osrm_client.py` mantiene `table_matrix()` y `route_geometry()` separadas: permite migrar una mitad sin la otra.

La primera fila es la que está implementada, y la segunda era el plan original: espejar `route_geometry()` habría significado una llamada por tramo. `computeRoutes` acepta paradas intermedias y devuelve `legs[]` con duración, distancia y polilínea **por tramo**, así que `origen → zonas → relleno → origen` vuelve completo en una sola petición. Triplica el techo gratuito y además es más correcto: es un cálculo de ruta, no tres tramos calculados por separado que podrían no empalmar.

**El consumo está acotado por la estructura del código, no por prudencia.** Las salidas baratas de `_build_subroute` (sin dotación, sin vehículo compatible, servicio caído, y excede autonomía u horas **según la matriz**) ocurren antes de pedir la geometría, así que el bucle de relajación descarta lo groseramente imposible gastando cero llamadas.

Después de la geometría hay dos salidas más, las que vuelven a medir horas y autonomía contra las cifras reales, y esas sí consumen la llamada que se acaba de hacer. El costo es **1 llamada en el caso normal, más 1 por cada zona que haya que sacar porque el recorrido medido no cumplió**, con techo en la cantidad de zonas. En la práctica la matriz aproxima bien (3% de diferencia en el total medido), así que el extra es casi siempre cero.

| Escenario | Llamadas | Generaciones gratis/mes |
|---|---|---|
| Caso normal | 1 | 5.000 |
| Una zona descartada por medición | 2 | 2.500 |
| Peor caso con 5 zonas | 5 | 1.000 |

Incluso el peor caso deja 1.000 generaciones mensuales contra las ~600 del uso previsible.

**Por qué se pagó ese precio.** La comprobación de la jornada se hacía contra la matriz, o sea a flujo libre, mientras lo mostrado venía con tráfico: el plan podía aceptarse como que cabe en 4 h y anunciar 4 h 30. Un plan que se contradice a sí mismo no se puede usar para coordinar a nadie. La misma corrección arregla la autonomía, que ahora se mide contra los kilómetros efectivamente recorridos y no contra los que la matriz supuso.

La comprobación barata **no se puede borrar** y quedarse solo con la medida: sin ella habría que pedir geometría en cada iteración de la relajación. Y tampoco es redundante, porque la matriz no acota por un lado: OSRM sobreestima la velocidad en ciudad y la subestima en vía rápida, así que puede dar más o menos que el tráfico real.

#### Qué protege el tramo gratuito

El crédito de prueba de Google Cloud **sí se puede gastar en Maps Platform**, así que pasarse del tramo gratuito no sale de un bolsillo aparte: sale del mismo crédito que sostiene la VM. Por eso el objetivo es no pasarse nunca, y eso se garantiza así:

1. **Cuota diaria de 160 solicitudes** en la Routes API (GCP → APIs y servicios → Cuotas). 160 × 31 = 4.960 < 5.000: es una garantía aritmética, no un cuidado. Con una llamada por generación equivale a **160 rutas generadas por día**, unas ocho veces el uso previsible. Se configura **antes** de crear la clave, para no dejar una ventana con la API habilitada y sin tope.
2. **Cuota por minuto en ~10**, que frena una ráfaga antes de que se coma el día entero en treinta segundos. El tope diario protege el presupuesto; el tope por minuto protege el día.
3. **Clave restringida por IP de la VM**, no por referente HTTP: las llamadas salen del backend, no del navegador.
4. **Alerta de presupuesto** en la cuenta de facturación, como red de respaldo.

Lo importante es que el tope vive **afuera del código**: si un error de programación llamara a la API en un bucle, Google responde `429` en la solicitud 161 del día, el backend cae a OSRM y la cuenta no se mueve. Ningún bug puede generar un cobro, porque el límite no depende de que el código esté bien.

#### Cómo está implementado el AC5

Tres piezas, y la que importa es la del medio:

| Archivo | Qué hace |
|---|---|
| `backendModel/google_routes_client.py` | Habla con `computeRoutes`: una petición con paradas intermedias, `routingPreference: TRAFFIC_AWARE`, y el reparto de `legs[]` en los tres tramos. Decodifica la polilínea a mano, sin sumar dependencias |
| `backendModel/routes_provider.py` | Expone **una** función, `route_tramos(origen, paradas, relleno)`, y elige proveedor según `ROUTES_PROVIDER` |
| `backendModel/routing.py` | Llama a esa función y **no sabe cuántas peticiones HTTP costó** |

Esa indirección no es ceremonia. Antes `_build_subroute` hacía tres `route_geometry()` en paralelo, que es lo correcto contra un servicio gratuito y lo incorrecto contra uno que se cobra por llamada y devuelve los tres tramos en una. El que sabe cuántas llamadas hacen falta tiene que ser el mismo que sabe cuánto cuesta cada una.

**Si Google falla, se cae a OSRM y no se reintenta.** Clave inválida, cuota agotada, timeout: todo devuelve `None`, el plan sale con tiempos a flujo libre y la municipalidad puede seguir planificando. Un reintento automático es justamente el mecanismo por el que el consumo se dispara cuando el servicio del otro lado está lento.

**El plan dice si sus tiempos son con tráfico.** La respuesta lleva `trafficAware`, y el detalle del recorrido imprime "Tiempos ajustados al tráfico de las HH:MM" solo cuando es verdad. El criterio pide que el ajuste ocurra *"sin requerir que el trabajador lo indique"*, y eso solo se puede comprobar si el trabajador ve que está pasando. Es una propiedad de **ese** plan y no del sistema: lo que importa es cómo se calculó, no cómo se calcularía ahora.

**Qué cubre exactamente.** El criterio habla de *"los tiempos estimados de cada tramo"*, y esos son los que pasan a venir con tráfico: los que se muestran y los que calculan las horas de llegada de la línea de tiempo.

Dos cosas siguen decidiéndose a flujo libre, y las dos son consecuencia de dejar la matriz en OSRM por costo. El **orden** de las paradas, que el criterio no pide. Y el **chequeo de horas disponibles**, que compara contra los tiempos de la matriz y no contra los de la geometría: un plan puede aceptarse como que cabe en la jornada y mostrarse después más largo que ella. Cerrar eso obligaría a pedir la geometría antes de decidir, o sea una llamada por cada iteración de la relajación en vez de una por plan, que es justamente la garantía que sostiene el costo. Cerrar eso también costaría 3 llamadas por generación (pedirle a Google las tres mejores permutaciones que OSRM ya enumeró, y quedarse con la de menor tiempo real), o sea 1.666 generaciones mensuales. Queda anotado como mejora con su costo calculado, no como deuda.

**Verificado en producción el 05-10-2026**, y con un hallazgo que conviene registrar: **comparar el total del plan no sirve para comprobar este criterio**. Mismo recorrido, 37,8 km en los dos casos:

| Tramo | Distancia | OSRM (flujo libre) | Google (con tráfico) |
|---|---|---|---|
| origen → zona | 4,32 km | 7,3 min (35 km/h) | **12,6 min (21 km/h)** |
| zona → relleno | 18,40 km | 28,3 min (39 km/h) | **23,6 min (47 km/h)** |
| relleno → origen | 15,08 km | 26,5 min (34 km/h) | 27,7 min (33 km/h) |
| **Total** | 37,8 km | 62,1 min | 64,0 min |

La distancia es idéntica, o sea son las mismas calles a otra velocidad. Pero **los tramos se mueven en direcciones opuestas y casi se cancelan**: OSRM sobreestima la velocidad en ciudad y la subestima en vía rápida, así que el total apenas se mueve (1,9 min) mientras el tramo urbano cambia un 73%. Lo que hay que mirar son las filas de la línea de tiempo y las horas de llegada de cada parada. Es también la razón de negocio del criterio: a la cuadrilla no le sirve saber cuánto dura la jornada, le sirve saber a qué hora está en cada zona.

**Consumo medido**: 4 solicitudes para 2 generaciones más 2 pruebas por `curl`, o sea exactamente **1 llamada por ruta generada**, como predecía la estructura del código.

**Para encenderlo**, en este orden: habilitar `Routes API` en el proyecto que ya tiene la VM (no uno nuevo: el tope se agrega por cuenta de facturación, así que un proyecto aparte no da otros 5.000); configurar las cuotas; crear la clave restringida; y recién entonces `ROUTES_PROVIDER=google` y `GOOGLE_ROUTES_API_KEY` en el `.env` de la VM. Las dos variables van juntas: una sola no activa nada, para que un `.env` a medio configurar no deje el ruteo en un estado que nadie quiso.

#### Colores de congestión sobre el trazo, evaluados y descartados

`extraComputations: TRAFFIC_ON_POLYLINE` devuelve `speedReadingIntervals`: tramos de la polilínea marcados `NORMAL`, `SLOW` o `TRAFFIC_JAM`, que es exactamente el verde/naranja/rojo de Google Maps. Viene en **la misma llamada** que ya se hace, así que no costaría ni una petición más.

**Se probó contra la API real y funciona** (05-10-2026): devolvió 3 intervalos, uno de ellos `SLOW`. No es una limitación técnica.

**Lo que lo descarta es el SKU.** La página de detalles lista *"Información sobre el tráfico en las polilíneas"* entre los disparadores de **Compute Routes Enterprise**, y como el SKU lo decide la función más cara de cada solicitud, habilitarlo **mueve todas las generaciones de Pro a Enterprise**:

| | Hoy (Pro) | Con colores (Enterprise) |
|---|---|---|
| Gratis/mes | 5.000 | **1.000** |
| Uso previsible | ~600 | ~600 |
| Holgura | **8x** | **1,6x** |
| Cuota diaria necesaria | 160 | **32** |

Sigue siendo $0 al volumen real, así que el argumento **no es el costo**: es que la cuota diaria tendría que bajar de 160 a 32, y 32 generaciones por día es poco justo los días de prueba y de demostración, que es cuando más se genera.

**La alternativa gratis es el `TrafficLayer` del Maps JavaScript API**, incluido sin costo en la carga del mapa: pinta la congestión sobre todas las calles del mapa base en vez de sobre el trazo. Para la cuadrilla responde la misma pregunta. Vive en la migración del mapa a Google, no acá.

#### Route Optimization (FleetRouting), evaluado y descartado

`RouteOptimization FleetRouting` resuelve con **una sola llamada** lo que acá son criterios separados, y cubre nativamente **AC3** (límites de distancia por vehículo), **AC4** (capacidades de carga y compatibilidad vehículo-envío) y **AC5** (`considerRoadTraffic`, que es exactamente el ajuste por tráfico que pide el criterio).

**El costo no es el argumento, aunque ahora juega en contra suya.** Son 1.000 solicitudes gratis al mes contra 5.000 de Routes Pro, y ambos enfoques gastan **1 llamada por generación**, así que son 1.000 generaciones mensuales contra 5.000. Mientras el plan era espejar `route_geometry()` con tres llamadas la comparación quedaba casi pareja (1.000 contra 1.666); con las paradas intermedias ya no lo está. De todos modos 1.000 generaciones son 33 por día, de sobra para una herramienta municipal: el costo no alcanzaba para decidir ni antes ni ahora.

**Lo que lo descarta es el AC6.** El objeto `SkippedShipment` que devuelve trae `index` y `label`: dice **cuál** zona quedó fuera, no **por qué**. Y la descripción de la historia subraya justamente eso: *"un vehículo puede quedar descartado por falta de personal, por autonomía insuficiente, o por no transportar el tipo de residuo de la zona, y el sistema debe poder distinguir cuál fue el motivo en cada caso"*. Un optimizador devuelve un óptimo, no una explicación; el código actual puede decir *"La capacidad disponible (4 m³) no alcanza para esta zona"* porque aplica cada restricción él mismo.

Se suman dos cosas más: **AC1 y AC2 seguirían siendo nuestros igual** (que dos vehículos compartan un peoneta no es un concepto de FleetRouting, hay que filtrar antes qué vehículos se le mandan), y habría que rearmar AC7 sobre otra respuesta. El balance es ganar tres criterios, perder el único ya verificado y reescribir el algoritmo completo.

**La forma en que sí serviría** es híbrida: aplicar nuestras restricciones primero, con sus motivos, y mandarle solo el subconjunto factible para que resuelva el orden y el tráfico. Conserva AC6 intacto, pero es **más** trabajo y no menos: hay que implementar AC1 a AC4 igual, y además integrar la API. Queda registrado como la evolución identificada para después de este sprint.

| Historia | Criterio de aceptación | Estado |
|---|---|---|
| HDU5.1 | Solo se consideran vehículos cuyo personal requerido esté completo con perfiles disponibles | ✅ Cumplido |
| HDU5.1 | Un mismo perfil de trabajador no puede cubrir dos vehículos que operan a la vez | ✅ Cumplido |
| HDU5.1 | Se descarta toda subruta cuya distancia total supere la autonomía del vehículo | ✅ Cumplido |
| HDU5.1 | Se prioriza la coincidencia de tipo de residuo, y solo se usa un vehículo no compatible si no hay alternativa | ✅ Cumplido |
| HDU5.1 | Los tiempos de cada tramo se ajustan por las condiciones de tráfico vigentes, sin intervención del trabajador | ✅ Cumplido (apagado por omisión: requiere habilitar la clave de Google) |
| HDU5.1 | Las zonas sin vehículo posible quedan marcadas "sin asignar" con el motivo, sin invalidar el resto del plan | ✅ Cumplido |
| HDU5.1 | Cada tramo del plan muestra qué vehículo lo recorre, por patente y tipo, y su personal asociado | ✅ Cumplido |
| HDU8 | "Agregar recurso" pide el tipo de recurso a añadir | ✅ Cumplido |
| HDU8 | Al elegir el tipo, el sistema pide los detalles relevantes de ese tipo | ✅ Cumplido |
| HDU8 | "Editar" sobre un recurso registrado permite modificar su registro | ✅ Cumplido |
| HDU8 | El botón de disponibilidad alterna el recurso entre disponible y no disponible | ✅ Cumplido |
| HDU8 | Un recurso no disponible queda excluido al armar la asignación de una ruta | ✅ Cumplido |
| HDU9 | Al seleccionar una o más zonas y presionar "generar informe", se exporta un PDF con el volumen total y por zona | ✅ Cumplido |
| HDU9 | Con zonas de distintos tipos de residuo, el PDF detalla el volumen por tipo además del total | ✅ Cumplido |
| HDU9 | Con dos versiones guardadas de la misma zona, el PDF muestra la comparación de volumen entre ambos períodos | ✅ Cumplido |
| HDU9 | Sin ninguna zona guardada, el botón queda deshabilitado con un mensaje que lo explica | ✅ Cumplido |
| HDU10 | "Ver evolución" muestra la cadena completa de versiones anteriores, ordenada cronológicamente | ✅ Cumplido |
| HDU10 | Se grafica el volumen estimado de cada versión por fecha | ✅ Cumplido |
| HDU10 | Una zona sin versiones anteriores lo indica explícitamente | ✅ Cumplido |
| HDU10 | Al hacer click en una versión, se abre en modo solo lectura con el visor de HDU4 | ✅ Cumplido |
| SP2 (Spike, 13 pts) | Primer entregable: tabla comparando el desempeño con una única imagen, para demostrar estabilidad de las estimaciones | 🔲 Pendiente |

> **Una zona que no cabe en la capacidad despachada ya no se descarta: se retira de ella lo que entra y el resto queda pendiente.** Antes el plan la dejaba entera fuera, lo que no es lo que hace la cuadrilla: el camión va, carga lo que le entra y la zona queda con un resto para otra jornada. La línea de tiempo lo dice en la parada ("se retiran 8,00 de 12,40 m³, quedan 4,40 en la zona").
>
> **No incumple ningún criterio.** El de HDU5 habla de cuando *no se logra generar una ruta factible*, y ese mensaje sigue existiendo para los casos en que no hay plan que construir (ningún punto activo, ninguna zona ubicable, ningún vehículo con capacidad declarada). El AC6 de HDU5.1 habla de zonas *sin vehículo posible*, y sus motivos siguen todos en pie: autonomía, horas, tipo de residuo, falta de dotación, y ahora además "no queda capacidad" para las zonas que vienen después de la parcial.
>
> Tres cosas que el cambio obligó a cuidar:
>
> - **La geometría de tres tramos sigue siendo exacta.** Lo que se carga nunca *supera* la capacidad, solo la alcanza, así que el camión sigue saliendo vacío, llegando lleno al relleno y volviendo vacío. Lo que cambia es que la zona queda con un pendiente, no que el recorrido tenga un tramo más.
> - **El peso recorta igual que el volumen**, porque son dos límites distintos del mismo vehículo y la densidad cambia con el tipo de residuo. La fracción la decide el que primero se agota, y escala las dos magnitudes juntas: con el peso completo de la zona contra una carga parcial, `_trucks_used` rechazaría camiones que sí sirven.
> - **Una capacidad en toneladas no declarada sigue significando "no medida", no cero.** Es la regla que ya tenía `aguanta_el_peso`, y las dos tienen que moverse juntas o el plan recorta una zona por peso y después no encuentra vehículo que la lleve.
| SP2 (Spike, 13 pts) | Segundo entregable: tabla con una imagen con datos reales validados por la municipalidad | 🔲 Pendiente |


---

## Estado de Sprint 3

Historias comprometidas: **HDU14** (itinerario semanal de puntos permanentes), **HDU15** (puntos diarios de retiro) y el **inicio de sesión federado**, que no es una historia con criterios sino la corrección de un riesgo de seguridad.

### Inicio de sesión federado

El sistema tenía un único usuario sembrado desde el `.env`, con contraseña compartida por el equipo, y **buena parte de la API del pipeline estaba abierta sin sesión**. Las dos cosas se cerraron:

- La identidad la emite ahora un proveedor externo por OpenID Connect con PKCE. **Nadie escribe una contraseña en este sistema**, así que no hay ninguna que se pueda robar.
- El cliente entra por su **directorio** (el `tid` del token), no por una lista de correos: un funcionario nuevo entra el día que su TI le crea la cuenta y deja de entrar el día que se la cierran, sin tocar el sistema.
- `orquestador.py` exige sesión con una **dependencia global**, no endpoint por endpoint. Las únicas excepciones son `/auth/*` y las lecturas de imágenes.
- Se agregaron **bitácora** de acciones destructivas y **límite de peticiones**.
- En MongoDB Atlas se cerró la regla `0.0.0.0/0`: solo la IP de la VM y las de desarrollo.

> **Un defecto que esto introdujo y conviene dejar escrito.** Al exigir sesión en toda la API, `/carga` dejó de funcionar en producción: ninguno de los 14 `fetch` de `src/lib/unify.ts` mandaba `credentials: "include"`, ni el `XMLHttpRequest` de la subida llevaba `withCredentials`. Funcionaba porque esa parte de la API estaba abierta. El síntoma visible era un `401` aislado en `/tasks/pending`, que el frontend se tragaba en silencio.

### HDU14 y HDU15

| Historia | Criterio de aceptación | Estado |
|---|---|---|
| HDU14 | Al presionar el botón con signo de suma de una columna, el sistema muestra el listado de puntos permanentes y permite escoger y añadir puntos | ✅ Cumplido |
| HDU14 | Si no hay ningún punto permanente creado, el listado muestra "no se encontraron puntos permanentes" | ✅ Cumplido |
| HDU14 | Al presionar "crear punto permanente", se muestra una pantalla de configuración con nombre, dirección y opcionalmente una imagen | ✅ Cumplido (ver nota abajo) |
| HDU14 | Al presionar el botón de edición en la esquina de un punto, se permite editar su información | ✅ Cumplido |
| HDU14 | Cuando no haya puntos en un día, se muestra "no hay puntos permanentes asociados" | ✅ Cumplido |
| HDU15 | Al presionar "crear punto diario", se muestra una pantalla de selección entre "escombros" y "extras" | ✅ Cumplido |
| HDU15 | Al escoger "escombros", se muestra una configuración con la información pertinente a escombros | ✅ Cumplido |
| HDU15 | Al escoger "extras", se muestra una configuración con la información pertinente a extras | ✅ Cumplido |
| HDU15 | Con puntos diarios en el mapa, "editar puntos" permite modificar la información de todos los puntos actuales | ✅ Cumplido |

> **Dos divergencias respecto de la letra de los criterios, deliberadas y anotadas acá en vez de dejarlas pasar en silencio:**
>
> - **El formulario de un punto permanente pide más que nombre, dirección e imagen**: también barrio, tipo (Microbasural o VIRS) y frecuencia de atención, que son los campos de la planilla municipal y lo que después permite ordenar el catálogo.
> - **El campo de imagen se quitó.** El AC habla de "opcionalmente una imagen", pero la imagen que de verdad le corresponde a un lugar en este sistema es su **mapa unificado**, que sale del vuelo y no de la galería de alguien. Dos imágenes para lo mismo dejaban la pregunta de cuál manda. La tabla muestra la del vuelo cuando existe, y un hueco cuando no, que es información: dice que falta volarlo.

### Lo que estas historias dejaron planteado y no resuelven

Los puntos permanentes y los diarios **no entran todavía a la ruta generada**: se ven en el mapa y se editan, que es lo que piden sus criterios, pero `_load_route_stops` resuelve paradas solo desde análisis guardados. Un punto sin vuelo no tiene volumen, peso ni clases de residuo, y todo el reparto por capacidad de HDU5.1 descansa en esas tres cosas.

Tampoco existe el **registro de lo retirado** (cuántos m³ y con qué camión), que es la primera tabla de cada hoja diaria de la planilla municipal.

Las dos cosas, más la unificación completa de puntos y zonas, están desarrolladas en [`docs/unificacion-puntos-zonas.md`](docs/unificacion-puntos-zonas.md) como entrada a **HDU5.2**.

---

## Tecnologías

| Capa | Tecnología |
|---|---|
| Frontend | React 19 + TanStack Start (SSR) + TanStack Router |
| Lenguaje frontend | TypeScript |
| Estilos | Tailwind CSS v4, un solo tema (cuerpo claro, barra lateral navy) con el login en tratamiento oscuro |
| Componentes UI | shadcn/ui + Radix UI |
| Mapas geográficos | Leaflet + react-leaflet, o Maps JavaScript de Google si hay clave (los dos detrás del mismo contrato) |
| Ruteo por calles | OSRM (matriz y geometría), con Google Routes opcional para tiempos con tráfico |
| Bundler / servidor SSR | Vinxi + Nitro |
| Gestor de paquetes | pnpm |
| Backend API | FastAPI + Uvicorn |
| Base de datos | MongoDB Atlas (pymongo, cliente async + sync) |
| Autenticación | OpenID Connect con PKCE contra Microsoft Entra ID y Google; sesión en JWT en cookie httpOnly (PyJWT con RS256) |
| Unificación de imágenes | OpenDroneMap (NodeODM vía Docker) |
| Detección de basura | YOLOv8 (Ultralytics) + SAHI |
| Cálculo de volumen | RasterStats + GeoPandas sobre nDSM de ODM |
| Detección de duplicados (HDU7) | Shapely (IoU real entre huellas de ortomosaico georreferenciadas, backend) |
| Geodesia / reproyección | proj4 (UTM → WGS84, cliente) |
| Geocodificación | Google Places y Geocoding por el backend si hay clave, con Nominatim (OpenStreetMap) de respaldo |
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

**Cliente:** Paloma Valenzuela, Directora de Aseo, Ornato y Gestión Ambiental, Municipalidad de Maipú.

**Institución:** Universidad Técnica Federico Santa María, Departamento de Informática, Ingeniería de Software 2026
