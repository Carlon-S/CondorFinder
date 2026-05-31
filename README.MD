# CondorFinder

Sistema web municipal para el monitoreo automatizado de basurales mediante imágenes aéreas capturadas con drones. Desarrollado para la Municipalidad de Maipú como parte del proyecto de la asignatura de Ingeniería de Software, Universidad Técnica Federico Santa María.

---

## Descripción del proyecto

CondorFinder automatiza el monitoreo y gestión de vertederos ilegales en tres componentes principales:

1. **Carga y unificación de imágenes aéreas** — el trabajador municipal sube fotografías JPG tomadas con drone y el sistema genera un mapa unificado de la zona.
2. **Análisis con visión computacional** *(en desarrollo)* — detección de focos de basura, clasificación de tipos de residuo y estimación de volúmenes mediante un modelo YOLOv8.
3. **Visualización y planificación** *(en desarrollo)* — mapa interactivo con polígonos de basurales, generación de rutas optimizadas y asignación de recursos logísticos.

---

## Estado actual del repositorio

Este repositorio contiene de momento solo el **frontend completo** de la Historia de Usuario HDU1 (Unificación de imágenes), implementado como Prototipo Mínimo Viable (PMV).

El backend (API de procesamiento de imágenes) está siendo desarrollado por separado. El punto de conexión ya está preparado en `src/lib/unify.ts`.

---

## Tecnologías utilizadas

| Capa | Tecnología |
|------|-----------|
| Framework frontend | React 19 + TanStack Start |
| Lenguaje | TypeScript |
| Estilos | Tailwind CSS v4 |
| Componentes UI | shadcn/ui + Radix UI |
| Íconos | Lucide React |
| Bundler | Vite 7 |
| Gestor de paquetes | pnpm |

---

## Estructura del proyecto

```
src/
├── assets/
│   └── unified-map.jpg        # Imagen placeholder del mapa unificado (desarrollo)
├── components/
│   └── ui/                    # Componentes de shadcn/ui (Button, Progress, etc.)
├── lib/
│   ├── unify.ts               # Servicio de conexión con el backend (HDU1)
│   └── utils.ts               # Utilidades generales
├── routes/
│   ├── __root.tsx             # Layout raíz de la aplicación
│   └── index.tsx              # Página principal — componente Page (HDU1)
├── styles.css                 # Estilos globales, tokens de diseño, clases personalizadas
└── router.tsx                 # Configuración del router
```

---

## Instalación y ejecución local

### Requisitos previos

- [Node.js](https://nodejs.org/) v18 o superior
- [pnpm](https://pnpm.io/) v8 o superior

### Pasos

```bash
# 1. Clonar el repositorio
git clone https://github.com/tu-usuario/condorfinder.git
cd condorfinder

# 2. Instalar dependencias
pnpm install

# 3. Iniciar el servidor de desarrollo
pnpm dev
```

La aplicación estará disponible en `http://localhost:8080`.

### Otros comandos disponibles

```bash
pnpm build        # Compilar para producción
pnpm preview      # Previsualizar el build de producción
pnpm lint         # Verificar errores de código con ESLint
pnpm format       # Formatear el código con Prettier
```

---

## Funcionalidades implementadas (HDU1)

### Carga de imágenes
- Zona de drag & drop para arrastrar imágenes JPG directamente
- Selector de archivos múltiple (solo JPG/JPEG)
- Validación de formato al instante: extensión + MIME type
- Thumbnails optimizados vía Canvas API para scroll fluido con muchas imágenes
- Eliminación individual, por lote (no JPG) o total

### Revisión técnica
- Indicadores de estado en tiempo real para cada condición requerida
- **Formato JPG**: verifica que todos los archivos sean JPG/JPEG
- **Cantidad mínima**: requiere al menos 16 imágenes
- **Solapamiento ≥ 60%**: verificado al procesar (simulado actualmente)
- **Generación de mapa**: estado del proceso de unificación
- Resumen numérico de la carga (total, JPG, rechazadas, solapamiento)
- Explicación del solapamiento en lenguaje simple para el usuario

### Generación del mapa
- Proceso secuencial con fases visibles y barra de progreso
- Tooltip dinámico junto al botón con estado actual del sistema
- Visualización del mapa generado en contenedor cuadrado
- Descarga del mapa en formato JPG
- Mensajes de error descriptivos y en lenguaje simple

---

## Conexión con el backend

Cuando el backend esté disponible, solo se debe modificar `src/lib/unify.ts`:

```typescript
// Descomentar este bloque y eliminar la respuesta simulada:
const formData = new FormData();
files.forEach((f) => formData.append("images", f));
const res = await fetch("/api/images/unify", { method: "POST", body: formData });
return (await res.json()) as UnifyResponse;
```

El backend debe retornar un objeto con la siguiente estructura:

```typescript
// Respuesta exitosa:
{ status: "success", overlap: number, mapUrl: string }

// Respuesta de error:
{ status: "error", reason: string, overlap?: number, message: string }
```

---

## Historias de usuario del PMV

| ID | Descripción | Estado |
|----|-------------|--------|
| HDU1 | Unificación de imágenes aéreas en un mapa | ✅ Frontend completo |
| HDU2 | Cálculo de volumen de basurales | 🔄 En desarrollo |
| HDU3 | Visualización de áreas de basurales en mapa interactivo | 🔄 Pendiente |

---

## Equipo

| Nombre | Rol | Contacto |
|--------|-----|----------|
| Diego Carlon Soto | CPO | +56 9 3785 2772 |
| Bastian Kretschme | CEO | +56 9 7379 8753 |
| Nicolaz Muñoz | CMO / COO | +56 9 9044 4894 |
| Francisco González | CTO | +56 9 7537 9965 |

**Cliente:** Paloma Valenzuela, Directora de Aseo, Ornato y Gestión Ambiental — Municipalidad de Maipú

---

## Institución

Universidad Técnica Federico Santa María — Departamento de Informática  
Ingeniería de Software — 2026