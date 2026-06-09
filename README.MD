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

Cierra y vuelve a abrir WSL para que el grupo `docker` tome efecto. Verificar con:

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
pnpm.cmd approve-builds
# se debe seleccionar true con space (se debera ver el circulo "encendido/lleno") al lado de esbuild
```


### 3. Crea el entorno virtual del backend

Abre WSL y navega a la raíz del proyecto:

```bash
cd /mnt/c/ruta/al/proyecto/CondorFinder
```

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

Mantener esta terminal abierta durante todo el uso del sistema.

### Terminal 2 — Backend (WSL)

Desde la raíz del proyecto con el venv activado:

```bash
source backendModel/joining/venv/bin/activate
uvicorn backendModel.orquestador:app --reload --port 8000
```

Espera hasta ver:
```
INFO: Application startup complete.
```

### Terminal 3 — Frontend (Windows PowerShell)

Desde la raíz del proyecto:

```powershell
pnpm dev
```

La aplicación estará disponible en **http://localhost:8080**

---

## Uso

1. Abrir http://localhost:8080 en el navegador
2. En la vista **Unificación de imágenes**, se pueden arrastrar o seleccionar las imagenes JPG tomadas mediante Drone
3. Esperar a que las imágenes se suban al servidor
4. Presionar **Generar mapa unificado** — el proceso toma tiempo.
5. Una vez generado, se puede hacer clic en el mapa para ir a la vista de **Análisis de detección**

---

## Estructura del proyecto

```
CondorFinder/
├── src/
│   ├── assets/              ← Imágenes estáticas de referencia
│   ├── components/          ← Componentes React reutilizables
│   ├── lib/                 ← Servicios y utilidades del frontend
│   └── routes/              ← Vistas principales (index.tsx, analysis.tsx)
├── backendModel/
│   ├── orquestador.py       ← API FastAPI (carga, generación, estado)
│   ├── requirements.txt     ← Dependencias Python
│   ├── joining/
│   │   ├── joinOrtho.py     ← Unificación de imágenes con ODM
│   │   ├── images/          ← Imágenes JPG cargadas por el usuario
│   │   └── finals/          ← Ortomosaico .tif generado por ODM
│   └── detecting/
│       ├── detectingOrtho.py ← Detección de basura con YOLOv8
│       ├── model/best.pt     ← Pesos del modelo entrenado
│       └── output/           ← Imágenes anotadas con detecciones
├── package.json
└── README.MD
```

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