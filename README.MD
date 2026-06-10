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

> El frontend se levanta en **Windows**. El backend y Docker se ejecutan en **WSL (Ubuntu)**.

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

---

## Ejecución

El sistema requiere **tres terminales corriendo simultáneamente**.

### Terminal 1 — NodeODM (WSL)

```bash
docker run -ti -p 3000:3000 webodm/nodeodm
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

> **Importante:** no uses `--reload`. El flag de recarga automática reinicia el proceso al detectar cambios en archivos, lo que destruye las tareas en ejecución y hace que el frontend reciba "Tarea no encontrada" a mitad del pipeline.

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

### Vista de Unificación (`/`)

1. Abre http://localhost:8080 en el navegador
2. Arrastra o selecciona las imágenes JPG tomadas con drone (mínimo 16)
3. El sistema valida el formato y la cantidad antes de habilitar la generación
4. Presiona **Generar mapa unificado** — el proceso pasa por las fases: unificación con ODM y detección con YOLOv8
5. Al terminar, el mapa aparece en el visor:
   - Si se detectó basura: el mapa es clicable y navega a la vista de análisis
   - Si no se detectó basura: el mapa igual se muestra con un aviso informativo, y sigue siendo posible navegar al análisis

> El estado de la tarea persiste en la sesión. Si navegas a otra vista o recargas la página durante la generación, el proceso continúa y el resultado se sincroniza al volver.

### Vista de Análisis (`/analysis`)

6. Accede desde el mapa generado o directamente desde la barra de navegación
7. Si existe un mapa generado, presiona **Analizar volumen** para calcular el volumen por polígono
8. Si el mapa no contenía basura detectada, el sistema informa inmediatamente y el botón de análisis queda deshabilitado
9. Si no se ha generado ningún mapa, la vista muestra un mensaje indicando que primero se debe completar la unificación

---

## Estructura del proyecto

```
CondorFinder/
├── src/
│   ├── assets/              ← Imágenes estáticas de referencia
│   ├── components/          ← Componentes React reutilizables
│   ├── lib/                 ← Servicios y utilidades del frontend
│   │   ├── unify.ts         ← Cliente del pipeline de generación
│   │   ├── analysis.ts      ← Servicio de análisis de volumen (simulado)
│   │   ├── imageState.ts    ← Persistencia de estado en sessionStorage
│   │   └── mapState.ts      ← Persistencia y eventos de la URL del mapa
│   └── routes/              ← Vistas principales
│       ├── index.tsx        ← HDU1: Unificación de imágenes
│       └── analysis.tsx     ← HDU2/HDU3: Análisis de volumen
├── backendModel/
│   ├── orquestador.py       ← API FastAPI (carga, generación, estado)
│   ├── requirements.txt     ← Dependencias Python
│   ├── joining/
│   │   ├── joinOrtho.py     ← Unificación de imágenes con ODM
│   │   ├── images/          ← Imágenes JPG cargadas por el usuario
│   │   └── finals/          ← Ortomosaico .tif generado por ODM
│   └── detecting/
│       ├── detectingOrtho.py ← Detección de basura con YOLOv8 + SAHI
│       ├── model/best.pt     ← Pesos del modelo entrenado
│       └── output/           ← Imágenes anotadas con detecciones
├── package.json
└── README.MD
```

---

## Estado del MVP

| Historia | Criterio | Estado |
|---|---|---|
| HDU1 | Verificación de formato JPG | ✅ Implementado |
| HDU1 | Cantidad mínima de imágenes (16) | ✅ Implementado |
| HDU1 | Generación del mapa unificado | ✅ Implementado |
| HDU2 | Aviso cuando no se detecta basura en el mapa | ✅ Implementado |
| HDU2 | Cálculo de volumen por polígono | ⚠️ Simulado |
| HDU2 | Resumen total de volumen estimado | ⚠️ Simulado |
| HDU3 | Informar inmediatamente si no hay basura + deshabilitar análisis | ✅ Implementado |
| HDU3 | Mostrar volumen, área y tipos de residuo por zona | ⚠️ Simulado |
| HDU3 | Diferenciación visual por nivel de acumulación | ❌ Pendiente |
| HDU3 | Mensaje "Tipo de basura indefinido" | ❌ Pendiente |


---

## Tecnologías

| Capa | Tecnología |
|---|---|
| Frontend | React 19 + TanStack Router |
| Lenguaje frontend | TypeScript |
| Estilos | Tailwind CSS v4 |
| Componentes UI | shadcn/ui + Radix UI |
| Bundler | Vite 7 |
| Gestor de paquetes | pnpm |
| Backend API | FastAPI + Uvicorn |
| Unificación de imágenes | OpenDroneMap (NodeODM vía Docker) |
| Detección de basura | YOLOv8 (Ultralytics) + SAHI |

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
