# CondorFinder

Sistema web municipal para el monitoreo automatizado de basurales mediante imagenes aereas capturadas con drones. Desarrollado para la Municipalidad de Maipu como parte del proyecto de Ingenieria de Software de la Universidad Tecnica Federico Santa Maria.

---

## Descripcion del proyecto

CondorFinder busca apoyar a la Direccion de Aseo, Ornato y Gestion Ambiental de la Municipalidad de Maipu en el monitoreo de vertederos ilegales. El informe del proyecto describe un proceso actual principalmente manual: captura con drone, procesamiento externo, trazado de poligonos, estimacion de volumen y planificacion operativa con pocos informes disponibles durante periodos largos.

La solucion propuesta se organiza en tres componentes:

1. **Carga y unificacion de imagenes aereas**: el trabajador municipal sube fotografias JPG tomadas con drone y el sistema genera un mapa unificado de la zona.
2. **Analisis con vision computacional**: deteccion de focos de basura, clasificacion de tipos de residuo y estimacion de volumen por poligono.
3. **Visualizacion y planificacion**: mapa interactivo para priorizar zonas, comparar volumenes y, en una etapa posterior, conectar recursos logisticos como tolvas, camiones y rutas.

---

## Estado actual del repositorio

El repositorio contiene actualmente el **frontend del Prototipo Minimo Viable (PMV)**. No hay backend, servidor de procesamiento, scripts Python ni integraciones reales con modelos de deteccion. Las respuestas de procesamiento se encuentran simuladas para que el flujo de usuario pueda probarse visualmente y para dejar preparado el contrato que debera implementar el backend.

Estado por historia:

| Historia                             | Alcance PMV                                                                          | Estado actual                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| HDU1 - Unificacion de imagenes       | Cargar JPG, validar cantidad minima, simular solapamiento y mostrar mapa unificado   | Frontend completo con servicio simulado en `src/lib/unify.ts`                                                            |
| HDU2 - Calculo de volumen            | Ejecutar analisis sobre mapa unificado, mostrar volumen por poligono y resumen total | Frontend implementado de forma simulada en `src/routes/analysis.tsx` y `src/lib/analysis.ts`                             |
| HDU3 - Visualizar areas de basurales | Mostrar zonas detectadas con area, volumen y tipo de residuo para priorizacion       | Parcial: la vista de analisis ya dibuja poligonos y metricas simuladas; falta mapa geoespacial real y datos persistentes |

---

## Contexto documental usado

Se consideraron dos documentos externos del proyecto:

- `G14_Historias_CondorFinder_VF.pdf`: define el problema, actores, cliente, PMV y las tres historias principales.
- `DroneWaste_preprint.pdf`: referencia tecnica para la futura deteccion/clasificacion de residuos. El paper presenta DroneWaste, un dataset de 4.993 imagenes extraidas de ortomosaicos de 17 vertederos con 20 tipos de materiales. Es relevante para entrenar o evaluar modelos de object detection, pero aun no esta integrado al codigo.

Consideracion importante: el uso de DroneWaste queda como **insumo futuro para backend/modelo**, no como dependencia del frontend actual.

---

## Tecnologias utilizadas

| Capa               | Tecnologia                |
| ------------------ | ------------------------- |
| Framework frontend | React 19 + TanStack Start |
| Lenguaje           | TypeScript                |
| Estilos            | Tailwind CSS v4           |
| Componentes UI     | shadcn/ui + Radix UI      |
| Iconos             | Lucide React              |
| Bundler            | Vite 7                    |
| Gestor de paquetes | pnpm                      |

---

## Estructura relevante

```text
src/
├── assets/
│   ├── unified-map-preview.webp            # Preview liviano mostrado en la UI
│   ├── unified-map-simulation.png          # Descarga tecnica simulada
│   └── unified-map.jpg                     # Asset previo conservado
├── components/
│   └── ui/                                 # Componentes shadcn/ui
├── lib/
│   ├── analysis.ts                         # Contrato y respuesta simulada para HDU2
│   ├── unify.ts                            # Contrato y respuesta simulada para HDU1
│   └── utils.ts                            # Utilidades generales
├── routes/
│   ├── __root.tsx                          # Layout raiz
│   ├── index.tsx                           # Vista principal de carga/unificacion (HDU1)
│   └── analysis.tsx                        # Vista de analisis de volumen y poligonos (HDU2/HDU3 parcial)
├── routeTree.gen.ts                        # Generado por TanStack Router
├── router.tsx                              # Configuracion del router
└── styles.css                              # Estilos globales y tokens visuales
```

Archivos nuevos aun no agregados al repositorio remoto al momento de esta documentacion:

- `src/lib/analysis.ts`
- `src/routes/analysis.tsx`
- `src/assets/unified-map-preview.webp`
- `src/assets/unified-map-simulation.png`

---

## Instalacion y ejecucion local

### Requisitos previos

- [Node.js](https://nodejs.org/) v18 o superior
- [pnpm](https://pnpm.io/) v8 o superior

### Pasos

```bash
git clone https://github.com/Carlon-S/CondorFinder.git
cd CondorFinder
pnpm install
pnpm.cmd approve-builds
pnpm dev
```

La aplicacion estara disponible en `http://localhost:8080`.

### Comandos disponibles

```bash
pnpm dev          # Servidor de desarrollo
pnpm build        # Compilar para produccion
pnpm preview      # Previsualizar el build de produccion
pnpm lint         # Verificar errores con ESLint
pnpm format       # Formatear con Prettier
```

---

## Funcionalidades implementadas

### HDU1 - Carga y unificacion de imagenes

- Zona de drag and drop para cargar imagenes.
- Selector multiple de archivos.
- Validacion de formato JPG/JPEG por extension y MIME type.
- Validacion de cantidad minima: 16 imagenes JPG.
- Simulacion de solapamiento minimo de 60%.
- Flujo secuencial con fases visibles y barra de progreso.
- Thumbnails optimizados via Canvas API para mejorar rendimiento al listar muchas imagenes.
- Eliminacion individual, por lote de archivos invalidos o limpieza total.
- Mensajes de error en lenguaje simple, incluido el caso de solapamiento insuficiente.
- Visualizacion de mapa unificado usando `unified-map-preview.webp`.
- Descarga tecnica simulada usando `unified-map-simulation.png`.
- Link desde el mapa generado hacia `/analysis`.

### HDU2 - Analisis de volumen

- Ruta `/analysis` con dashboard lateral y visor central del mapa.
- Boton para ejecutar analisis de volumen simulado.
- Progreso visual del analisis.
- Resumen de volumen total, area total, cantidad de poligonos y formato de preview.
- Listado de poligonos detectados con categoria, area, volumen y confianza.
- Dibujo de poligonos sobre la imagen del mapa mediante SVG.
- Zoom con rueda del mouse y paneo con click sostenido.
- Estado alternativo para simular que no hay basura detectada.

### HDU3 - Visualizacion de areas

La implementacion actual cubre parcialmente esta historia:

- Los poligonos se visualizan sobre el mapa.
- Cada zona tiene volumen, area, categoria y color.
- Las zonas se diferencian visualmente.
- Falta reemplazar la simulacion por geometria y datos reales provenientes del backend/modelo.

---

## Contratos preparados para backend

### Unificacion de imagenes (`src/lib/unify.ts`)

Endpoint sugerido:

```text
POST /api/images/unify
```

Flujo esperado:

```text
imagenes JPG del drone
-> backend valida/corrige entrada
-> algoritmo de unificacion genera salida tecnica, idealmente TIF
-> backend genera preview liviano WEBP
-> frontend muestra WEBP
-> descarga tecnica usa TIF/PNG/WEBP segun disponibilidad
```

Respuesta esperada:

```typescript
type UnifyResponse =
  | {
      status: "success";
      overlap: number;
      mapUrl: string;
      technicalDownloadUrl?: string;
      technicalDownloadFormat?: "TIF" | "PNG" | "WEBP";
    }
  | {
      status: "error";
      reason: string;
      overlap?: number;
      message: string;
    };
```

### Analisis de volumen (`src/lib/analysis.ts`)

Endpoint sugerido:

```text
POST /api/maps/analyze-volume
```

Entrada sugerida:

```typescript
{
  mapUrl: string;
}
```

Respuesta esperada:

```typescript
type AnalyzeResponse =
  | {
      status: "success";
      polygons: WastePolygon[];
      summary: { areaM2: number; volumeM3: number };
    }
  | {
      status: "empty";
      message: string;
      polygons: [];
      summary: { areaM2: 0; volumeM3: 0 };
    }
  | {
      status: "error";
      reason: string;
      message: string;
    };
```

Cada `WastePolygon` debe incluir identificador, nombre, categoria/tipo de residuo, color o severidad visual, area, altura estimada, volumen, confianza y geometria. Hoy la geometria usa puntos SVG porcentuales solo para la demo; en produccion deberia venir en un formato geoespacial consistente, por ejemplo GeoJSON o coordenadas normalizadas documentadas.

---

## Consideraciones actuales

- El frontend esta preparado para escalar, pero no procesa imagenes realmente.
- La validacion de formato y cantidad ocurre en cliente; el backend debe repetirla por seguridad.
- El solapamiento, el mapa unificado, los poligonos, las categorias y los volumenes son simulados.
- Los controles de simulacion (`forceLowOverlap`, `forceEmpty`) son utiles para demo/testing y deben eliminarse o esconderse en produccion.
- Los assets tecnicos pesados, como TIF, no se versionan en el frontend. El repositorio conserva previews livianos y la salida tecnica debe generarse o almacenarse fuera del bundle web.
- `src/routeTree.gen.ts` es autogenerado por TanStack Router. No deberia editarse manualmente.
- No existe autenticacion, persistencia, historial, reportes ni administracion de recursos logisticos.
- No hay integracion aun con DroneWaste, YOLO, Python, Agisoft Metashape, GIS real ni base de datos.

---

## Que falta por hacer

1. Implementar backend para recibir imagenes JPG, validar insumos y ejecutar la unificacion.
2. Definir el pipeline real de ortomosaico/salida tecnica y generacion de preview WEBP.
3. Integrar modelo de deteccion/clasificacion de residuos, usando DroneWaste como referencia de dataset.
4. Definir como se calculara volumen: datos de altura, nube de puntos, DEM/DSM, fotogrametria o aproximacion operacional validada.
5. Reemplazar poligonos SVG simulados por geometria real, idealmente GeoJSON.
6. Implementar mapa geoespacial interactivo real para HDU3.
7. Agregar persistencia de analisis, historial por zona y comparacion temporal.
8. Agregar autenticacion y autorizacion para usuarios municipales.
9. Crear endpoints para reportes, exportacion y trazabilidad.
10. Conectar recursos logisticos: tolvas, camiones, rutas, frecuencias y priorizacion.
11. Agregar pruebas unitarias/integracion para servicios simulados, validaciones y flujos principales.
12. Revisar accesibilidad y comportamiento responsive de `/analysis`, que hoy prioriza escritorio.

---

## Equipo

| Nombre             | Rol       | Contacto        |
| ------------------ | --------- | --------------- |
| Diego Carlon Soto  | CPO       | +56 9 3785 2772 |
| Bastian Kretschme  | CEO       | +56 9 7379 8753 |
| Nicolaz Munoz      | CMO / COO | +56 9 9044 4894 |
| Francisco Gonzalez | CTO       | +56 9 7537 9965 |

**Cliente:** Paloma Valenzuela, Directora de Aseo, Ornato y Gestion Ambiental - Municipalidad de Maipu.

---

## Institucion

Universidad Tecnica Federico Santa Maria - Departamento de Informatica  
Ingenieria de Software - 2026
