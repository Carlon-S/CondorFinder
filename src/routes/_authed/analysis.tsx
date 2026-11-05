import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { notify } from "@/lib/notify";
import {
  ArrowLeft,
  BarChart3,
  Boxes,
  CheckCircle2,
  Clock,
  Crosshair,
  Eye,
  EyeOff,
  Loader2,
  ChartLineUp,
  FileText,
  Map as MapIcon,
  MousePointerClick,
  Pencil,
  RotateCcw,
  RotateCw,
  Save,
  Scale,
  Search,
  Trash2,
  TriangleAlert,
} from "@/components/icons/Icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  startVolumeAnalysis,
  pollVolumeAnalysis,
  type EnrichedDetection,
  type ZonaManual,
} from "@/lib/analysis";
import {
  saveAnalysis,
  findAnalysisByName,
  loadAnalysisById,
  listAnalyses,
  listZones,
  deleteVersion,
  consumePendingOpenId,
  confirmDuplicate,
  rejectDuplicate,
  renameZone,
  renameAnalysis,
  type SavedAnalysisRecord,
  type DuplicateCandidate,
} from "@/lib/analysisStore";
import { RenameDialog } from "@/components/RenameDialog";
import { buildVersions, type RetiroDeZona, type ZoneVersion } from "@/lib/volumeReport";
import { listarRetiros } from "@/lib/routePlans";
import { VersionBar } from "@/components/VersionBar";
import { ReportPreview } from "@/components/ReportPreview";
import { borrarArchivosDeVersion } from "@/lib/versionCleanup";
// Carga diferida: ZoneEvolution arrastra recharts, cerca de 850 kB. Importarlo
// de forma normal lo mete en el bundle inicial de esta ruta; esa regresión ya
// ocurrió una vez en Vista Principal.
const ZoneEvolution = lazy(() =>
  import("@/components/ZoneEvolution").then((m) => ({ default: m.ZoneEvolution })),
);
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  loadMapUrl,
  saveMapUrl,
  clearMapUrl,
  MAP_READY_EVENT,
  loadThumbnailUrl,
  saveThumbnailUrl,
  clearThumbnailUrl,
  loadCurrentAnalysisId,
  saveCurrentAnalysisId,
  loadCurrentAnalysisName,
  saveCurrentAnalysisName,
  clearCurrentAnalysisId,
} from "@/lib/mapState";
import {
  loadNoWasteDetected, loadDetectionJsonUrl, saveDetectionJsonUrl, clearDetectionJsonUrl,
  loadTaskId, saveTaskId, clearTaskId, loadZonaDestino, clearZonaDestino,
} from "@/lib/imageState";
import {
  getTaskStatus,
  deleteResultFile,
  deleteFinalsFile,
  deleteTaskImages,
  deleteTask,
} from "@/lib/unify";
import { area, peso, volumen } from "@/lib/formato";
import { classColor, CLASS_COLORS } from "@/components/zone-colors";

// Acá vivía WEIGHT_LIMIT_KG = 5000, que descartaba toda detección de más de 5
// toneladas antes de mostrarla. Se eliminó, y conviene saber por qué para no
// reponerlo:
//
//   - Descartaba EN SILENCIO. El trabajador no veía el polígono ni sabía que
//     existía, así que no podía decidir si era un error del modelo o un
//     basural grande de verdad.
//   - Solo filtraba en pantalla. El backend seguía calculando y guardando esas
//     detecciones, de modo que el total de la vista no coincidía con lo que
//     había en la base ni con lo que el ruteo iba a usar.
//   - Sesgaba el volumen hacia abajo justo en las zonas más grandes, que es lo
//     contrario de lo que SP2 busca demostrar sobre la precisión.
//
// Una detección exagerada sigue siendo visible y se apaga con el ojo de "Zonas
// detectadas", que es una decisión del trabajador y queda registrada en el
// campo `enabled` del análisis guardado.

// ── tipos ──────────────────────────────────────────────────────────────────────

interface ClassBreakdown {
  class: string;
  volume_m3: number | null;
  area_m2: number | null;
  weight_kg: number | null;
}

interface DisplayDetection {
  id: number;
  ids: number[];
  class: string;        // "Varios tipos" si fue fusionado, nombre real si es único
  classes: string[];    // todas las clases del grupo
  confidence: number;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
  polygon: null | number[][];
  rings?: number[][];
  // Zona de basura dibujada a mano (HDU12). Nunca se fusiona con otra.
  manual?: boolean;
  // Coordenadas reales (CRS proyectado del ortomosaico) de la detección
  // dominante del grupo, HDU5 las reproyecta a WGS84 para el mapa.
  geo_polygon?: number[][] | null;
  area_m2?: number | null;   // máximo del grupo (para totales sin doble conteo)
  volume_m3?: number | null;
  weight_kg?: number | null;
  breakdown: ClassBreakdown[]; // desglose por clase (para visualización)
}

function normalizeRings(polygon: unknown): number[][] {
  if (!Array.isArray(polygon) || polygon.length === 0) return [];
  const rings = Array.isArray(polygon[0]) ? (polygon as number[][]) : [polygon as number[]];
  return rings.filter((r) => r.length >= 6); // mínimo 3 puntos
}

/** Contorno de una detección en píxeles del PNG. Las máscaras del JSON están en
 *  píxeles del ortomosaico; el PNG se reduce con `png_scale` cuando el
 *  ortomosaico es muy grande, así que se multiplica por ese factor. */
function escalarAnillos(polygon: unknown, factor: number): number[][] {
  return normalizeRings(polygon).map((r) => r.map((v) => v * factor));
}

type AreaPoint = [number, number];

/** Lo que se está dibujando: el área relevante (HDU13) o una zona de basura (HDU12). */
type TipoDibujo = "area" | "zona";

/** Zona de basura dibujada y confirmada, todavía sin analizar (HDU12). */
interface ZonaPendiente {
  uid: string;
  clase: string;
  pts: AreaPoint[];
}

/** Las 20 clases del modelo, en el orden de la tabla de colores. */
const CLASES_DE_BASURA = Object.keys(CLASS_COLORS).slice(0, 20);

function pointInPolygon(x: number, y: number, poly: AreaPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Una detección cuenta como "dentro" si el centro de su recuadro cae en el área.
 *  Si prefieres otra regla (solo si está entera dentro, o si toca el área),
 *  se cambia solo acá. */
function detectionInArea(d: DisplayDetection, poly: AreaPoint[]): boolean {
  return pointInPolygon(
    (d.bbox.minx + d.bbox.maxx) / 2,
    (d.bbox.miny + d.bbox.maxy) / 2,
    poly,
  );
}

function ringsToPath(rings: number[][]): string {
  return rings
    .map((r) => {
      let d = `M${r[0]} ${r[1]}`;
      for (let i = 2; i + 1 < r.length; i += 2) d += `L${r[i]} ${r[i + 1]}`;
      return d + "Z";
    })
    .join("");
}
// ── colores ────────────────────────────────────────────────────────────────────

// ── degradé de volumen verde → amarillo → rojo ─────────────────────────────

function lerpRgb(
  c1: [number, number, number],
  c2: [number, number, number],
  t: number,
): string {
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
  return `rgb(${r},${g},${b})`;
}

function volumeToFillColor(volume: number, minVol: number, maxVol: number): string {
  if (maxVol <= 0 || maxVol === minVol) return "rgb(34,197,94)";
  const t = Math.max(0, Math.min(1, (volume - minVol) / (maxVol - minVol)));
  const green:  [number, number, number] = [34,  197, 94];
  const yellow: [number, number, number] = [245, 158, 11];
  const red:    [number, number, number] = [239, 68,  68];
  return t <= 0.5
    ? lerpRgb(green, yellow, t * 2)
    : lerpRgb(yellow, red, (t - 0.5) * 2);
}

// ── merge de zonas solapadas ───────────────────────────────────────────────────

function computeIoU(
  a: { minx: number; miny: number; maxx: number; maxy: number },
  b: { minx: number; miny: number; maxx: number; maxy: number },
): number {
  const ix1 = Math.max(a.minx, b.minx);
  const iy1 = Math.max(a.miny, b.miny);
  const ix2 = Math.min(a.maxx, b.maxx);
  const iy2 = Math.min(a.maxy, b.maxy);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const inter = (ix2 - ix1) * (iy2 - iy1);
  const areaA = (a.maxx - a.minx) * (a.maxy - a.miny);
  const areaB = (b.maxx - b.minx) * (b.maxy - b.miny);
  return inter / (areaA + areaB - inter);
}

function mergeOverlapping(
  detections: EnrichedDetection[],
  pngScale = 1,
  iouThreshold = 0.5,
): DisplayDetection[] {
  if (detections.length === 0) return [];

  // Grafo de adyacencia: par (i,j) si IoU >= umbral
  const adj: number[][] = detections.map(() => []);
  for (let i = 0; i < detections.length; i++) {
    for (let j = i + 1; j < detections.length; j++) {
      // Una zona dibujada a mano es una decisión del trabajador y no se fusiona.
      if (detections[i].manual || detections[j].manual) continue;
      if (computeIoU(detections[i].bbox, detections[j].bbox) >= iouThreshold) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }

  // Componentes conexas (BFS)
  const visited = new Set<number>();
  const groups: number[][] = [];
  for (let i = 0; i < detections.length; i++) {
    if (visited.has(i)) continue;
    const group: number[] = [];
    const queue = [i];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (visited.has(node)) continue;
      visited.add(node);
      group.push(node);
      for (const n of adj[node]) if (!visited.has(n)) queue.push(n);
    }
    groups.push(group);
  }

  return groups.map(group => {
    const dets = group.map(i => detections[i]);
    const classes = [...new Set(dets.map(d => d.class))];

    // Bbox unión del grupo
    const bbox = {
      minx: Math.min(...dets.map(d => d.bbox.minx)),
      miny: Math.min(...dets.map(d => d.bbox.miny)),
      maxx: Math.max(...dets.map(d => d.bbox.maxx)),
      maxy: Math.max(...dets.map(d => d.bbox.maxy)),
    };

    const volumes = dets.map(d => d.volume_m3 ?? 0);
    const areas   = dets.map(d => d.area_m2  ?? 0);
    const weights = dets.map(d => d.weight_kg ?? 0);

    // Para zonas fusionadas: si todas las áreas son similares (ratio ≤ 2×)
    // se usa el promedio; si una zona domina claramente, se usa el máximo.
    const nonZeroAreas = areas.filter(a => a > 0);
    const areasAreSimilar =
      dets.length > 1 &&
      nonZeroAreas.length > 0 &&
      Math.max(...nonZeroAreas) / Math.min(...nonZeroAreas) <= 2.0;

    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const maxVolIdx = volumes.indexOf(Math.max(...volumes));

    const aggVolume = areasAreSimilar ? avg(volumes) : Math.max(...volumes);
    const aggArea   = areasAreSimilar ? avg(areas)   : Math.max(...areas);
    const aggWeight = areasAreSimilar ? avg(weights)  : weights[maxVolIdx];

    // Desglose individual por clase para mostrar en la lista
    const breakdown: ClassBreakdown[] = dets.map(d => ({
      class:     d.class,
      volume_m3: d.volume_m3 ?? null,
      area_m2:   d.area_m2  ?? null,
      weight_kg: d.weight_kg ?? null,
    }));

    return {
      id:         dets[0].id,
      ids:        dets.map(d => d.id),
      class:      classes.length > 1 ? "Varios tipos" : classes[0],
      classes,
      confidence: Math.max(...dets.map(d => d.confidence)),
      bbox,
      polygon:    dets[0].polygon,
      rings:      dets.flatMap((d) => escalarAnillos(d.polygon, pngScale)),
      manual:     dets.length === 1 && Boolean(dets[0].manual),
      geo_polygon: dets[0].geo_polygon,
      area_m2:    aggArea   || null,
      volume_m3:  aggVolume || null,
      weight_kg:  aggWeight || null,
      breakdown,
    };
  });
}

// ── ruta ──────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/_authed/analysis")({
  head: () => ({
    meta: [
      { title: "CondorFinder - Analisis de volumen" },
      {
        name: "description",
        content:
          "Vista de analisis para calcular volumen de residuos por poligono sobre el mapa unificado.",
      },
    ],
  }),
  component: AnalysisPage,
});

type AnalysisStatus = "idle" | "running" | "done" | "empty" | "error";

function AnalysisPage() {
  // Para volver a Vista Principal cuando se elimina la última captura de la
  // zona: sin zona no queda nada que mostrar acá.
  const navigate = useNavigate();
  const [mapUrl, setMapUrl] = useState<string | null>(() => loadMapUrl());
  // Miniatura liviana asociada a mapUrl (ver mapState.ts), puede no existir
  // (análisis reabiertos de antes de este campo), se guarda igual con la
  // misma disciplina "capturado una vez al montar" que mapUrl.
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(() => loadThumbnailUrl());
  const usingGeneratedMap = mapUrl !== null;

  // taskId/detectionJsonUrl se capturan UNA VEZ al montar, igual que mapUrl
  // arriba, sessionStorage es solo el mecanismo de traspaso entre rutas
  // (mismo patrón documentado en mapState.ts/imageState.ts), no una fuente
  // viva para releer en cada click. runAnalysis() volvía a llamar
  // loadTaskId()/loadDetectionJsonUrl() cada vez que se presionaba
  // "Analizar volumen", y esas claves podían quedar limpias por el efecto de
  // cleanup de más abajo (se dispara en cualquier desmontaje, incluido algún
  // remount temprano que TanStack Start puede hacer en dev), mapUrl nunca
  // sufría esto porque ya vivía en estado de React, no releído de
  // sessionStorage después del montaje. Mismo tratamiento acá.
  const [taskId, setTaskId] = useState<string | null>(() => loadTaskId());
  const [detectionJsonUrl, setDetectionJsonUrl] = useState<string | null>(() => loadDetectionJsonUrl());
  // Se llega aquí directo desde el sidebar ahora (antes solo vía Vista
  // Principal, que siempre dejaba un mapUrl seteado). Sin esta bandera, un
  // acceso directo sin contexto mostraría el layout roto en vez de un
  // estado vacío, se pone en true recién cuando el efecto de montaje ya
  // tuvo chance de resolver un análisis pendiente (HDU4).
  const [initChecked, setInitChecked] = useState(false);

  const [status, setStatus] = useState<AnalysisStatus>(() => {
    if (loadMapUrl() !== null && loadNoWasteDetected()) return "empty";
    return "idle";
  });
  const [progress, setProgress]           = useState(0);
  const [analysisMessage, setAnalysisMessage] = useState<string | null>(() => {
    if (loadMapUrl() !== null && loadNoWasteDetected()) return "No hay basura detectada en el área";
    return null;
  });

  const [scale, setScale]   = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  /** Cuántos grados está girado el mapa unificado. **Ángulo libre, 0 a 359.**
   *
   *  **Para qué sirve**: el ortomosaico sale del vuelo con el norte arriba, y
   *  eso no es cómo la cuadrilla ve el terreno cuando llega. Poder girarlo deja
   *  orientar la imagen como se la va a mirar en la calle.
   *
   *  **Empezó en pasos de 90 y se abrió a cualquier ángulo**, a pedido: un
   *  basural no se alinea con los puntos cardinales, se alinea con la calle que
   *  lo bordea, y esa calle casi nunca cae en un múltiplo de 90. Lo que hacía
   *  caro el ángulo libre era cuánto encoger la imagen para que siguiera
   *  entrando de costado, y eso resultó tener una fórmula cerrada para cualquier
   *  ángulo, no solo para 90 (ver `factorRotacion`). Los botones de 90 se
   *  conservan igual, porque son el caso frecuente y con el deslizador habría
   *  que apuntar para clavar un cuarto de vuelta exacto. */
  const [rotacion, setRotacion] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStart    = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const [displayDetections, setDisplayDetections] = useState<DisplayDetection[]>([]);
  const [detectionsLoading, setDetectionsLoading] = useState(false);
  // Lo que el trabajador dejó activado a mano. Lo que de verdad cuenta es
  // `enabledIds` (más abajo), que además excluye lo descartado por el área.
  const [enabledRaw, setEnabledIds]                = useState<Set<number>>(new Set());
  const [areaMode, setAreaMode]         = useState<"idle" | "drawing">("idle");
  const [drawKind, setDrawKind]         = useState<TipoDibujo>("area");
  const [draftPoints, setDraftPoints]   = useState<AreaPoint[]>([]);
  const [analysisArea, setAnalysisArea] = useState<AreaPoint[] | null>(null);
  // HDU13: el área se puede apagar sin borrarla, y seleccionar para hacerlo.
  const [areaActiva, setAreaActiva]               = useState(true);
  const [areaSeleccionada, setAreaSeleccionada]   = useState(false);
  // HDU13: detecciones fuera del área que el trabajador restauró por error.
  const [restauradasIds, setRestauradasIds]       = useState<Set<number>>(new Set());
  const [mostrarDescartadas, setMostrarDescartadas] = useState(false);
  // HDU12: zonas de basura dibujadas a mano. `zonaModo` se enciende al apretar
  // "Dibujar zona de basura" y se apaga al analizar con ellas.
  const [zonaModo, setZonaModo]                   = useState(false);
  const [zonasManuales, setZonasManuales]         = useState<ZonaPendiente[]>([]);
  const [zonaPendiente, setZonaPendiente]         = useState<AreaPoint[] | null>(null);
  const [tipoZonaOpen, setTipoZonaOpen]           = useState(false);
  // Zona cuyo contorno se esta editando arrastrando sus puntos: "pendiente" (la
  // recien dibujada), el uid de una confirmada, o null.
  const [zonaEnEdicion, setZonaEnEdicion]         = useState<string | null>(null);
  const arrastreVertice = useRef<{ id: string; i: number } | null>(null);
  // Factor con que el PNG se redujo respecto del ortomosaico (1 = sin reducir).
  const [pngScale, setPngScale]                   = useState(1);
  const svgRef = useRef<SVGSVGElement>(null);

  // ── lo que el área relevante descarta (HDU13) ─────────────────────────────
  //
  // Se DERIVA del área y de las detecciones en vez de guardarse: así vale igual
  // al analizar, al reabrir un análisis y al apagar o mover el área, y no hay
  // un segundo estado que mantener sincronizado. Una detección cuenta como
  // "dentro" si el centro de su recuadro cae en el área.
  const descartadasIds = useMemo(() => {
    if (!analysisArea || !areaActiva) return new Set<number>();
    return new Set(
      displayDetections
        .filter((d) => !restauradasIds.has(d.id) && !detectionInArea(d, analysisArea))
        .map((d) => d.id),
    );
  }, [displayDetections, analysisArea, areaActiva, restauradasIds]);

  /** Las detecciones activas que cuentan para los totales: las que el
   *  trabajador dejó activas y que el área no descartó. */
  const enabledIds = useMemo(
    () => new Set([...enabledRaw].filter((id) => !descartadasIds.has(id))),
    [enabledRaw, descartadasIds],
  );
  const visibleDetections = useMemo(
    () => displayDetections.filter((d) => !descartadasIds.has(d.id)),
    [displayDetections, descartadasIds],
  );
  const descartadas = useMemo(
    () => displayDetections.filter((d) => descartadasIds.has(d.id)),
    [displayDetections, descartadasIds],
  );
  const [imgNaturalSize, setImgNaturalSize]        = useState<{ w: number; h: number } | null>(null);
  // CRS proyectado del ortomosaico (HDU5), llega junto con las detecciones,
  // se guarda para poder reproyectar geo_polygon a WGS84 más adelante (en
  // /rutas). Análisis abiertos por AC4 lo traen de record.crs.
  const [crs, setCrs] = useState<string | undefined>(undefined);
  // Centro geográfico real del ortomosaico (mismo CRS que `crs`), a
  // diferencia del centroide de las detecciones, es el mismo sin importar
  // qué encuentre YOLO en cada corrida. rutas.tsx lo prefiere por sobre el
  // centroide de detecciones para ubicar la zona de forma consistente.
  const [orthoCenter, setOrthoCenter] = useState<[number, number] | null>(null);
  // Huella geográfica COMPLETA del ortomosaico, HDU7 la usa (no las
  // detecciones puntuales) para detectar duplicados entre análisis
  // guardados, más robusto ante corridas de YOLO que detectan la basura en
  // una posición levemente distinta. Ver backendModel/analyses.py.
  const [orthoBounds, setOrthoBounds] = useState<[number, number, number, number] | null>(null);

  // ── zona, versión y sello del cálculo ──────────────────────────────────────
  // Una zona agrupa las versiones (vuelos) de un mismo terreno, y cada versión
  // agrupa sus análisis. Estos campos viajan con el análisis al guardarlo para
  // que la evolución pueda ordenarlos en el tiempo y distinguir un cambio real
  // del basural de un cambio en cómo se mide.
  // Arranca con la zona que el trabajador DECLARO en Vista Principal, si eligio
  // "modificar zona existente". Es lo que hace que el backend no tenga que
  // adivinar a que zona pertenece esta captura ni levantar el aviso de posible
  // duplicado: _resolve_zone() da prioridad a la zona declarada.
  const [zoneId, setZoneId] = useState<string | null>(() => loadZonaDestino());
  /** Fecha en que se voló el terreno, del EXIF de las fotos. */
  const [captureDate, setCaptureDate] = useState<string | null>(null);
  /** true cuando ninguna foto traía fecha y se usó la de carga. */
  const [captureDateEstimated, setCaptureDateEstimated] = useState(false);
  const [algorithmVersion, setAlgorithmVersion] = useState<number | null>(null);
  /** false cuando los modelos de elevación de este vuelo ya se liberaron
   *  porque existe una captura más reciente de la zona. En ese caso el vuelo
   *  se puede consultar pero no volver a medir. */
  const [canAnalyze, setCanAnalyze] = useState(true);
  const [cannotAnalyzeReason, setCannotAnalyzeReason] = useState<string | null>(null);
  /**
   * Solo lectura: este análisis es de una versión que ya fue reemplazada por
   * una captura más reciente de la misma zona (HDU7 lo marca `historical` al
   * confirmarse el duplicado).
   *
   * Se deriva del dato, no de la presencia de archivos en el servidor. La poda
   * de modelos de elevación solo corre al terminar una generación y respeta
   * los vuelos sin análisis guardado, así que perfectamente puede haber una
   * versión reemplazada que todavía conserve sus archivos. Preguntar por el
   * disco respondía "sí se puede medir" para versiones que no correspondía.
   */
  const [readOnly, setReadOnly] = useState(false);

  // ── capturas de la zona (HDU10 dentro de esta vista) ──────────────────────
  /** Todos los análisis guardados de la zona actual. */
  const [zoneAnalyses, setZoneAnalyses] = useState<SavedAnalysisRecord[]>([]);
  /** Los mismos, agrupados por vuelo y ordenados en el tiempo. */
  const [versions, setVersions] = useState<ZoneVersion[]>([]);
  /** Las capturas se piden después de montar; sin avisarlo, la barra
   *  aparecía de golpe un momento después y empujaba el contenido. */
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [evolutionOpen, setEvolutionOpen] = useState(false);
  /** Los retiros de esta zona, para la línea de tiempo de la evolución y para el
   *  informe (pieza 2.5 de HDU5.2).
   *
   *  **Se piden cuando se conoce la zona, no al abrir cada diálogo.** Los dos
   *  caminos que los usan son botones distintos, y pedirlos en cada uno dejaría
   *  dos lugares donde recordar hacerlo; es además una consulta indexada por
   *  `zoneId` que casi siempre vuelve vacía.
   *
   *  Un fallo deja la lista vacía y las dos salidas quedan como antes, con solo
   *  las mediciones: perder el detalle de los retiros es molesto, perder la
   *  evolución entera por una consulta caída sería peor. */
  const [retirosZona, setRetirosZona] = useState<RetiroDeZona[]>([]);
  const [reportOpen, setReportOpen] = useState(false);
  /** Sube cada vez que se aplica un análisis. Se usa como `key` del mapa y de
   *  la lista de zonas para que React los reemplace y su animación de entrada
   *  vuelva a correr: sin eso, cambiar de captura reemplazaba el contenido de
   *  golpe y no se alcanzaba a ver que algo había cambiado. Un contador y no el
   *  id del análisis, porque volver a elegir la MISMA captura también tiene que
   *  dar una señal visible. */
  const [animKey, setAnimKey] = useState(0);
  /** Nombre de la zona, para el título del informe y de la evolución. Sale de
   *  la colección de zonas: el nombre del análisis identifica una captura, no
   *  el terreno. */
  const [zoneName, setZoneName] = useState<string | null>(null);
  /** El nombre de la zona se resuelve con una consulta aparte, mientras que el
   *  del análisis ya viene en el registro. Sin saber que la consulta sigue en
   *  curso, el título mostraba primero el nombre del ANÁLISIS ("Zona A - Vuelo
   *  2") y un instante después lo reemplazaba por el de la ZONA ("Zona A"): un
   *  cambio de nombre a la vista que parecía un error de datos. */
  const [zoneNameLoading, setZoneNameLoading] = useState(false);

  /** Cuál de los dos renombrados está abierto, o null.
   *
   *  Un solo estado y no dos banderas: son excluyentes por construcción (los
   *  abre el mismo gesto en dos lugares distintos) y con dos banderas hay un
   *  cuarto estado, "los dos abiertos", que no significa nada. */
  const [renombrando, setRenombrando] = useState<"zona" | "version" | null>(null);

  // ── HDU4 / AC1, guardar análisis: pide nombre ─────────────────────────────
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [analysisName, setAnalysisName]     = useState("");

  // AC6, nombre duplicado
  const [duplicateExisting, setDuplicateExisting] = useState<SavedAnalysisRecord | null>(null);

  // Análisis ya guardado que se está viendo en esta sesión (llegó por AC4, o
  // ya se guardó una vez en este mismo tab). Mientras esté marcado, volver a
  // guardar sobrescribe directo, sin pedir nombre ni chequear duplicados , 
  // no es un análisis nuevo, es el mismo que ya existe.
  // Estado inicial leído de sessionStorage (no null a secas): sin esto, un
  // F5 sobre un análisis YA GUARDADO reconstruía mapUrl/detecciones bien
  // (ver más abajo) pero perdía esta identidad -- el botón volvía a decir
  // "Guardar análisis" en vez de "Guardar cambios" y ofrecía guardarlo de
  // nuevo como si fuera una generación nueva sin guardar, en vez de seguir
  // apuntando al mismo registro.
  const [currentAnalysisId, setCurrentAnalysisId]     = useState<string | null>(loadCurrentAnalysisId);
  const [currentAnalysisName, setCurrentAnalysisName] = useState<string | null>(loadCurrentAnalysisName);
  // Guardar/buscar duplicado ahora son llamadas HTTP (Mongo), no localStorage
  // instantáneo, sin este indicador, un click en "Guardar" durante una
  // conexión lenta no daba ninguna señal de que algo estaba pasando.
  const [savingAnalysis, setSavingAnalysis] = useState(false);

  // HDU7/AC2, posible duplicado con un análisis anterior (>50% de área
  // superpuesta, calculado por el backend con shapely al guardar). Guarda
  // el análisis ANTERIOR ya resuelto (nombre/volumen) para poder comparar
  // ambos en el banner sin otra vuelta al backend. null = nada pendiente.
  const [duplicateWarning, setDuplicateWarning] = useState<{
    candidatos: DuplicateCandidate[];
  } | null>(null);
  // Qué acción está corriendo: el analysisId del candidato que se está
  // confirmando, o "reject". Antes era un booleano compartido por dos botones;
  // ahora hay una fila por candidato y cada una necesita mostrar su propio
  // indicador, sin bloquear visualmente a las demás.
  const [resolvingDuplicate, setResolvingDuplicate] = useState<string | null>(null);

  // Se llama tanto justo después de guardar (performSave) como al reabrir
  // un análisis ya guardado (AC4-de-HDU4, en el efecto de montaje), mismo
  // chequeo en los dos casos: "al acceder al mapa del nuevo análisis" (AC2)
  // cubre ambos accesos, no solo el instante del guardado.
  const checkDuplicateWarning = async (record: SavedAnalysisRecord) => {
    if (record.duplicateStatus !== "pending" || !record.possibleDuplicateOf) {
      setDuplicateWarning(null);
      return;
    }

    // Los candidatos vienen con el registro: el backend ya calculó la
    // superposición de cada uno al guardar, no hace falta pedirlos de nuevo.
    if (record.possibleDuplicates && record.possibleDuplicates.length > 0) {
      setDuplicateWarning({ candidatos: record.possibleDuplicates });
      return;
    }

    // Respaldo para análisis guardados ANTES de que existiera la lista: solo
    // traen possibleDuplicateOf. Se arma un candidato único con ese id para
    // que el aviso siga funcionando sobre registros viejos.
    const older = await loadAnalysisById(record.possibleDuplicateOf);
    if (older) {
      setDuplicateWarning({
        candidatos: [{ analysisId: older.id, name: older.name, zoneId: older.zoneId, ratio: 0 }],
      });
    }
  };

  /**
   * Toma la zona que el BACKEND resolvió para un análisis y recarga sus
   * capturas.
   *
   * La zona no la decide el frontend: la asigna `_resolve_zone()` al guardar
   * (hereda la que HDU7 reconoció por huella, o crea una nueva), y puede
   * CAMBIAR después, cuando se resuelve un posible duplicado. Cada vez que el
   * backend devuelve un registro actualizado hay que adoptar lo que diga, o la
   * vista se queda mostrando una zona que ya no es la suya.
   */
  const adoptarZonaDe = (record: SavedAnalysisRecord) => {
    const zona = record.zoneId ?? null;
    setZoneId(zona);
    cargarVersionesDeLaZona(zona);
  };

  const handleConfirmDuplicate = async (candidatoId: string) => {
    if (!currentAnalysisId) return;
    const elegido = duplicateWarning?.candidatos.find((c) => c.analysisId === candidatoId);
    setResolvingDuplicate(candidatoId);
    const updated = await confirmDuplicate(currentAnalysisId, candidatoId);
    setResolvingDuplicate(null);
    if (!updated) {
      notify.error("No se pudo vincular la captura", "Intenta nuevamente.");
      return;
    }
    setDuplicateWarning(null);
    // Si se eligió un candidato distinto del que el sistema puso primero, el
    // backend movió esta versión a la zona del elegido, así que la zona sí
    // puede haber cambiado. Adoptar lo que devuelva cubre los dos casos.
    adoptarZonaDe(updated);
    notify.success(
      "Capturas vinculadas",
      elegido ? `Quedó como una captura más de la zona de "${elegido.name}".` : "Quedó vinculada como la misma zona.",
    );
  };

  const handleRejectDuplicate = async () => {
    if (!currentAnalysisId) return;
    setResolvingDuplicate("reject");
    const updated = await rejectDuplicate(currentAnalysisId);
    setResolvingDuplicate(null);
    if (!updated) {
      notify.error("No se pudo actualizar el análisis", "Intenta nuevamente.");
      return;
    }
    setDuplicateWarning(null);
    // Acá la zona SÍ cambia: al crear el análisis, _resolve_zone le asignó la
    // zona del posible duplicado sin esperar respuesta (acierta en la mayoría
    // de los casos), así que hasta este momento esta captura figuraba en la
    // barra de versiones de la otra zona. Al decir que son distintas, el
    // backend la mueve a una zona nueva y devuelve el registro corregido;
    // sin adoptarlo, la barra seguía mostrando las dos juntas hasta un F5.
    adoptarZonaDe(updated);
    notify.success("Marcado como zona distinta", "Ambos análisis se mantienen por separado.");
  };

  // Guardado real, compartido entre el camino feliz, la sobrescritura rápida
  // y la confirmación de duplicado. AC5, si falla, notifica por toast y no
  // cierra el modal para poder reintentar.
  const performSave = async (name: string, overwriteId?: string) => {
    if (!mapUrl) return;

    setSavingAnalysis(true);
    const result = await saveAnalysis(
      name,
      {
        mapUrl,
        thumbnailUrl,
        // Cada detección viaja con si estaba activa o no. Antes se guardaban
        // todas sin la marca, así que el total guardado (que solo cuenta las
        // activas) no se podía reconciliar con el detalle, y al reabrir el
        // análisis volvían todas activas y el total cambiaba.
        detections: displayDetections.map(d => ({
          ...d,
          enabled: enabledIds.has(d.id),
          // Si el área relevante la dejó fuera. Al reabrir el análisis, una
          // detección fuera del área con `discarded: false` es una restaurada.
          discarded: descartadasIds.has(d.id),
        })),
        summary: activeSummary,
        sourceTaskId: taskId ?? undefined,
        crs,
        orthoCenter,
        orthoBounds,
        analysisArea,
        analysisAreaActive: areaActiva,
        pngScale,
        zoneId,
        captureDate,
        captureDateEstimated,
        algorithmVersion,
      },
      overwriteId,
    );
    setSavingAnalysis(false);

    if (!result.ok) {
      notify.error("No se pudo guardar el análisis", result.error);
      return;
    }

    // La zona declarada ya cumplió: viajó en este guardado y quedó en el
    // registro. Se limpia ACÁ y no al desmontar la vista, porque éste es el
    // momento en que deja de valer.
    clearZonaDestino();

    setCurrentAnalysisId(result.record.id);
    setCurrentAnalysisName(result.record.name);
    saveCurrentAnalysisId(result.record.id);
    saveCurrentAnalysisName(result.record.name);
    setSaveDialogOpen(false);
    setAreaMode("idle");
    setDraftPoints([]);
    notify.success(
      overwriteId ? "Análisis actualizado" : "Análisis guardado",
      overwriteId
        ? "Los cambios se guardaron sobre el análisis existente."
        : "Puedes encontrarlo en el listado de zonas de la Vista Principal.",
    );

    // HDU7/AC1→AC2, solo un guardado NUEVO (create_analysis en el backend)
    // puede traer un possibleDuplicateOf recién calculado; una sobrescritura
    // nunca lo dispara (ver analyses.py), así que esto es un no-op ahí.
    checkDuplicateWarning(result.record);

    // Sin adoptar la zona que resolvió el backend, recién guardado el análisis
    // la vista quedaba sin nombre de zona en el título, sin barra de capturas y
    // con "Informe de esta zona" y "Ver evolución" ocultos, porque los tres
    // dependen de zoneId. Había que salir y volver a entrar.
    //
    // También corre en una sobrescritura: la zona no cambia, pero el análisis
    // sí, y la barra de capturas y el informe tienen que reflejarlo.
    adoptarZonaDe(result.record);
  };

  // AC6 (sobrescribir): la sobrescritura REEMPLAZA sourceTaskId/mapUrl en el
  // documento, si el análisis existente venía de una generación DISTINTA
  // (otro mapa/tarea) a la que se está guardando ahora, esa tarea anterior
  // y sus archivos quedan sin ninguna referencia una vez sobrescrito. Sin
  // este cleanup quedaban huérfanos para siempre en Mongo (`tasks`) y en
  // disco (result/finals/task-images), mismo tipo de fuga que ya se
  // corrigió para "Eliminar zona" en index.tsx, acá aplica al camino de
  // sobrescritura en vez de al de borrado.
  const cleanupOverwrittenTask = (previous: SavedAnalysisRecord) => {
    if (previous.mapUrl && previous.mapUrl !== mapUrl) {
      const filename = previous.mapUrl.split("/").pop();
      if (filename) {
        deleteResultFile(filename);
        const jsonName = filename.replace(/\.png$/i, ".json");
        if (jsonName !== filename) deleteResultFile(jsonName);
        const tifName = filename.replace(/\.png$/i, ".tif");
        if (tifName !== filename) deleteFinalsFile(tifName);
      }
    }
    if (previous.sourceTaskId && previous.sourceTaskId !== (taskId ?? undefined)) {
      deleteTaskImages(previous.sourceTaskId);
      deleteTask(previous.sourceTaskId);
    }
  };

  // Botón "Guardar análisis": si ya se sabe qué análisis es (se abrió por AC4
  // o ya se guardó antes en esta sesión), sobrescribe directo sin preguntar
  // nada. Si es nuevo, recién ahí pide nombre (AC1).
  const handleSaveClick = () => {
    if (currentAnalysisId && currentAnalysisName) {
      performSave(currentAnalysisName, currentAnalysisId);
      return;
    }
    setAnalysisName("");
    setSaveDialogOpen(true);
  };

  // AC2, guarda el análisis con el nombre ingresado en el listado disponible.
  // AC6, si el nombre ya existe, pide confirmar sobrescribir en vez de guardar directo.
  const confirmSaveAnalysis = async () => {
    const name = analysisName.trim();
    if (!name || !mapUrl) return;

    setSavingAnalysis(true);
    const existing = await findAnalysisByName(name);
    setSavingAnalysis(false);
    if (existing) {
      setDuplicateExisting(existing);
      return;
    }

    performSave(name);
  };

  // ── helpers de toggle ──────────────────────────────────────────────────────

  const toggleDetection = (id: number) => {
    setEnabledIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allEnabled = visibleDetections.length > 0 && enabledIds.size === visibleDetections.length;

  const toggleAll = () => {
    setEnabledIds(
      allEnabled ? new Set() : new Set(visibleDetections.map(d => d.id)),
    );
  };

  /** Empieza a dibujar un polígono: el área relevante (HDU13) o una zona de
   *  basura (HDU12). Los dos usan el mismo modo de dibujo sobre la imagen. */
  const startDrawing = (tipo: TipoDibujo) => {
    setDrawKind(tipo);
    setDraftPoints([]);
    setZonaPendiente(null);
    setZonaEnEdicion(null);
    if (tipo === "zona") setZonaModo(true);
    setAreaMode("drawing");
  };

  const cancelDrawing = () => {
    setDraftPoints([]);
    setAreaMode("idle");
  };

  /** Se cerró el polígono. Un área relevante queda definida y activa; una zona
   *  de basura queda pendiente de confirmación (HDU12). */
  const closeArea = (pts: AreaPoint[]) => {
    setDraftPoints([]);
    setAreaMode("idle");
    if (drawKind === "zona") {
      setZonaPendiente(pts);
      return;
    }
    setAnalysisArea(pts);
    setAreaActiva(true);
    setAreaSeleccionada(true);
    setRestauradasIds(new Set());
  };

  const clearArea = () => {
    setAnalysisArea(null);
    setAreaSeleccionada(false);
    setAreaActiva(true);
    setRestauradasIds(new Set());
    setMostrarDescartadas(false);
  };

  /** Activa o desactiva el área sin borrarla (HDU13). Al desactivarla se
   *  analiza la imagen completa, así que lo que había descartado vuelve a
   *  contar. */
  const cambiarAreaActiva = (activa: boolean) => {
    setAreaActiva(activa);
    if (!activa) setEnabledIds((prev) => new Set([...prev, ...descartadasIds]));
  };

  /** Devuelve una detección descartada por el área a los totales (HDU13). */
  const restaurarDetection = (id: number) => {
    setRestauradasIds((prev) => new Set(prev).add(id));
    setEnabledIds((prev) => new Set(prev).add(id));
  };

  /** Confirma la zona dibujada con el tipo elegido (HDU12). */
  const confirmarZona = (clase: string) => {
    if (!zonaPendiente) return;
    setZonasManuales((prev) => [
      ...prev,
      { uid: `z${Date.now()}${prev.length}`, clase, pts: zonaPendiente },
    ]);
    setZonaPendiente(null);
    setZonaEnEdicion(null);
    setTipoZonaOpen(false);
  };

  /** Sale del modo de zonas de basura (HDU12): el trabajador se arrepintió de
   *  dibujar. Suelta lo que estaba en construcción o esperando confirmación y
   *  vuelve a permitir el análisis normal. Las zonas ya confirmadas se
   *  conservan en la lista, con su "Borrar": salir del modo no las pierde. */
  const salirModoZonas = () => {
    setZonaModo(false);
    setZonaPendiente(null);
    setZonaEnEdicion(null);
    setTipoZonaOpen(false);
    setDraftPoints([]);
    if (areaMode === "drawing" && drawKind === "zona") setAreaMode("idle");
  };

  /** Selecciona el área relevante si el clic cae dentro de ella. */
  const seleccionarAreaEn = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm || !analysisArea) return;
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    if (pointInPolygon(p.x, p.y, analysisArea)) setAreaSeleccionada((s) => !s);
  };

  // ── edicion del contorno de una zona de basura (HDU12) ───────────────────
  //
  // "Reducir el area" es manual: el trabajador arrastra los puntos del
  // contorno (los blancos) hacia donde quiera, y arrastra un punto intermedio
  // de un lado para agregar un vertice nuevo.

  /** Punto de la imagen (en pixeles del PNG) bajo el cursor, acotado a la imagen. */
  const puntoDeEvento = (clientX: number, clientY: number): AreaPoint | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm || !imgNaturalSize) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return [Math.min(imgNaturalSize.w, Math.max(0, p.x)), Math.min(imgNaturalSize.h, Math.max(0, p.y))];
  };

  /** Cambia los puntos de la zona `id` ("pendiente" o el uid de una confirmada). */
  const cambiarPuntos = (id: string, fn: (pts: AreaPoint[]) => AreaPoint[]) => {
    if (id === "pendiente") setZonaPendiente((prev) => (prev ? fn(prev) : prev));
    else setZonasManuales((prev) => prev.map((z) => (z.uid === id ? { ...z, pts: fn(z.pts) } : z)));
  };

  const iniciarArrastre = (e: React.PointerEvent<SVGCircleElement>, id: string, i: number) => {
    // Sin esto el contenedor del visor lo toma como el inicio de un paneo.
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    arrastreVertice.current = { id, i };
  };

  const insertarVertice = (e: React.PointerEvent<SVGCircleElement>, id: string, i: number, x: number, y: number) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    cambiarPuntos(id, (pts) => [...pts.slice(0, i + 1), [x, y] as AreaPoint, ...pts.slice(i + 1)]);
    arrastreVertice.current = { id, i: i + 1 };
  };

  const moverArrastre = (e: React.PointerEvent<SVGCircleElement>) => {
    const a = arrastreVertice.current;
    if (!a) return;
    e.stopPropagation();
    const punto = puntoDeEvento(e.clientX, e.clientY);
    if (!punto) return;
    cambiarPuntos(a.id, (pts) => pts.map((q, k) => (k === a.i ? punto : q)));
  };

  const terminarArrastre = (e: React.PointerEvent<SVGCircleElement>) => {
    e.stopPropagation();
    arrastreVertice.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* el puntero ya se habia soltado */
    }
  };

const addAreaPoint = (clientX: number, clientY: number) => {
  const svg = svgRef.current;
  const ctm = svg?.getScreenCTM();
  if (!svg || !ctm || !imgNaturalSize) return;
  const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  const x = Math.min(imgNaturalSize.w, Math.max(0, p.x));
  const y = Math.min(imgNaturalSize.h, Math.max(0, p.y));

  // Cerrar: click a ≤12 px de pantalla del primer punto (con ≥3 puestos).
  if (draftPoints.length >= 3) {
    const pxPerUnit = Math.hypot(ctm.a, ctm.b);
    const [x0, y0] = draftPoints[0];
    if (Math.hypot(x - x0, y - y0) * pxPerUnit <= 12) {
      closeArea(draftPoints);
      return;
    }
  }
  setDraftPoints([...draftPoints, [x, y]]);
};

// Esc cancela, Retroceso deshace el último punto.
useEffect(() => {
  if (areaMode !== "drawing") return;
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement | null)?.closest("input, textarea")) return;
    if (e.key === "Escape") cancelDrawing();
    else if (e.key === "Backspace") setDraftPoints(p => p.slice(0, -1));
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [areaMode]);



  /** Zonas fusionadas con su desglose por tipo a la vista. Colapsadas por
   *  omisión: sus cifras internas son casi idénticas entre sí y desplegadas
   *  siempre tapaban las filas que de verdad se comparan entre sí. */
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const toggleExpanded = (id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  /** El orden de la tabla: de mayor a menor volumen, que es el orden en que
   *  conviene atacar el retiro. Se ordena una copia y no `displayDetections`,
   *  porque ese arreglo es el que se guarda y su orden es el que produjo el
   *  backend. */
  const detectionRows = useMemo(
    () => [...visibleDetections].sort((a, b) => (b.volume_m3 ?? 0) - (a.volume_m3 ?? 0)),
    [visibleDetections],
  );

  /**
   * Cuántas detecciones tienen en pantalla una selección distinta a la que
   * quedó guardada.
   *
   * El informe se arma SIEMPRE con los análisis guardados, no con lo que está
   * marcado en ese momento: si saliera del estado en pantalla, dos personas
   * generarían informes distintos de la misma zona y el documento dejaría de
   * corresponder a una medición guardada. Pero sin avisarlo, ver el informe
   * ignorar lo que uno acaba de desmarcar se lee como un error de cálculo.
   */
  const cambiosSinGuardar = useMemo(() => {
    if (!currentAnalysisId) return 0;
    const guardado = zoneAnalyses.find((a) => a.id === currentAnalysisId);
    if (!guardado) return 0;
    const detGuardadas = (guardado.detections ?? []) as { id?: number; enabled?: boolean }[];
    // Una detección sin la marca cuenta como activa, igual que en
    // volumeReport.ts: es como se comportaban los registros anteriores a que
    // la selección se persistiera.
    return detGuardadas.filter((d) => (d.enabled !== false) !== enabledIds.has(d.id ?? -1)).length;
  }, [currentAnalysisId, zoneAnalyses, enabledIds]);

  // ── resumen calculado solo con zonas activas ───────────────────────────────

  const activeSummary = useMemo(() => {
    if (status !== "done") return { totalVolumeM3: 0, totalWeightKg: 0, totalAreaM2: 0 };
    const active = displayDetections.filter(d => enabledIds.has(d.id));
    return {
      totalVolumeM3: Math.round(active.reduce((s, d) => s + (d.volume_m3 ?? 0), 0) * 100) / 100,
      totalWeightKg: Math.round(active.reduce((s, d) => s + (d.weight_kg ?? 0), 0)),
      totalAreaM2:   Math.round(active.reduce((s, d) => s + (d.area_m2  ?? 0), 0) * 100) / 100,
    };
  }, [displayDetections, enabledIds, status]);

  // ── aplicar un análisis a la vista ────────────────────────────────────────
  //
  // Vive aparte del efecto de montaje porque ahora se usa DOS veces: al abrir
  // la vista, y cada vez que se cambia de captura con la barra inferior. Es el
  // único lugar que sabe traducir un registro guardado a estado de pantalla.
  const aplicarAnalisis = (record: SavedAnalysisRecord) => {
    setAnimKey((n) => n + 1);
    setMapUrl(record.mapUrl);
    saveMapUrl(record.mapUrl);
    setThumbnailUrl(record.thumbnailUrl ?? null);
    saveThumbnailUrl(record.thumbnailUrl ?? null);

    const detections = (record.detections as (DisplayDetection & { enabled?: boolean })[]) ?? [];
    setDisplayDetections(detections);
    // Se restaura la selección tal como se guardó. Una detección sin la marca
    // cuenta como activa: es como se comportaban los análisis anteriores a que
    // la selección se persistiera, así que abrirlos sigue dando lo mismo.
    setEnabledIds(new Set(detections.filter((d) => d.enabled !== false).map((d) => d.id)));
    const areaGuardada = (record.analysisArea as [number, number][] | null | undefined) ?? null;
    const activaGuardada = record.analysisAreaActive ?? true;
    setAnalysisArea(areaGuardada);
    setAreaActiva(activaGuardada);
    setAreaSeleccionada(false);
    setMostrarDescartadas(false);
    setPngScale(record.pngScale ?? 1);
    // Una detección fuera del área que se guardó con `discarded: false` es una
    // que el trabajador restauró: se mantiene restaurada al reabrir.
    setRestauradasIds(
      new Set(
        areaGuardada && activaGuardada
          ? detections
              .filter((d) => (d as { discarded?: boolean }).discarded === false && !detectionInArea(d, areaGuardada))
              .map((d) => d.id)
          : [],
      ),
    );
    setZonasManuales([]);
    setZonaPendiente(null);
    setZonaModo(false);
    setDraftPoints([]);
    setAreaMode("idle");
    setCrs(record.crs);
    setOrthoCenter(record.orthoCenter ?? null);
    setOrthoBounds(record.orthoBounds ?? null);
    setZoneId(record.zoneId ?? null);
    setCaptureDate(record.captureDate ?? null);
    setCaptureDateEstimated(record.captureDateEstimated ?? false);
    setAlgorithmVersion(record.algorithmVersion ?? null);

    // Una versión reemplazada queda en consulta: ni medir de nuevo ni
    // sobrescribir (AC4 de HDU10). Se resetea en cada aplicación, no solo se
    // enciende: al volver desde una captura antigua a la vigente, la vista
    // tiene que recuperar sus controles.
    setReadOnly(Boolean(record.historical));
    setCanAnalyze(true);
    setCannotAnalyzeReason(
      record.historical
        ? "Existe una captura más reciente de esta zona, así que este vuelo solo se puede consultar."
        : null,
    );
    setStatus("done");

    setCurrentAnalysisId(record.id);
    setCurrentAnalysisName(record.name);
    saveCurrentAnalysisId(record.id);
    saveCurrentAnalysisName(record.name);

    // HDU7/AC2, cubre tanto el guardado recién hecho como reabrirlo después.
    checkDuplicateWarning(record);

    // Otra captura es otra imagen: el zoom y el encuadre de la anterior no
    // significan nada sobre esta. Y el tamaño natural se descarta hasta que la
    // nueva imagen cargue, porque los rectángulos de detección se posicionan
    // con esa medida y con la vieja caerían corridos por un instante.
    setScale(1);
    setOffset({ x: 0, y: 0 });
    // La rotación también: la PNG de una versión tiene que abrirse derecha y
    // completa, igual que se abre sin zoom ni desplazamiento. Arrastrar el giro
    // de la captura anterior dejaría la nueva de costado sin que nadie lo pidiera.
    setRotacion(0);
    setImgNaturalSize(null);

    // El desglose desplegado tampoco se hereda. Los ids de detección son
    // enteros que arrancan bajo en CADA análisis, así que chocan entre
    // versiones: dejar el conjunto puesto abría el desglose de una zona
    // distinta solo porque le tocó el mismo id.
    setExpandedIds(new Set());

    // taskId y detectionJsonUrl se resuelven por captura. Sin esto, "Analizar
    // volumen" trabajaría sobre lo que hubiera quedado en sessionStorage de la
    // última tarea vista, que puede ser de otra zona por completo.
    clearDetectionJsonUrl();
    setDetectionJsonUrl(null);
    if (record.sourceTaskId) {
      const sourceTaskId = record.sourceTaskId;
      saveTaskId(sourceTaskId);
      setTaskId(sourceTaskId);
      getTaskStatus(sourceTaskId).then((s) => {
        if (s?.result_json_url) {
          saveDetectionJsonUrl(s.result_json_url);
          setDetectionJsonUrl(s.result_json_url);
        }
        // Respaldo: si además faltan los modelos de elevación de este vuelo,
        // tampoco se puede medir. El motivo principal sigue siendo `historical`.
        //
        // El texto NO repite "existe una captura más reciente": ese era el
        // motivo cuando la poda se llevaba los modelos de cualquier vuelo ya
        // superado, pero desde que el borrado devuelve a vigente la versión
        // anterior, una captura sin captura posterior puede igual haber
        // perdido sus modelos (si se podaron antes de que la retención
        // cambiara). Afirmar que existe una más reciente era mentir sobre el
        // estado real. Se dice lo único que se sabe con certeza: faltan los
        // archivos con los que se mide.
        if (s && s.can_analyze === false) {
          setCanAnalyze(false);
          setCannotAnalyzeReason(
            "Los modelos de elevación de este vuelo ya no están disponibles, así que se puede consultar pero no volver a medir.",
          );
        }
      });
    } else {
      clearTaskId();
      setTaskId(null);
    }
  };

  /** Trae las demás capturas de la zona para poder navegar entre ellas, y los
   *  retiros registrados de ese lugar.
   *
   *  Los retiros van acá y no en un efecto propio porque esta función es el
   *  único lugar del que esta vista se enteró de que hay una zona: la llaman el
   *  montaje, el cambio de captura, el renombrado y el borrado. Con un efecto
   *  aparte habría dos definiciones de "cuándo se sabe cuál es la zona". */
  const cargarVersionesDeLaZona = (zona: string | null) => {
    if (!zona) {
      setVersions([]);
      setVersionsLoading(false);
      setZoneNameLoading(false);
      setRetirosZona([]);
      return;
    }

    listarRetiros(zona)
      .then((rs) =>
        setRetirosZona(
          rs.map((r) => ({ fecha: r.fecha, volumenRetiradoM3: r.volumenRetiradoM3 })),
        ),
      )
      // Degrada a vacío: sin esto el gráfico y el informe quedan como estaban
      // antes de que existieran los retiros, con solo las mediciones.
      .catch(() => setRetirosZona([]));
    setVersionsLoading(true);
    setZoneNameLoading(true);
    listAnalyses()
      .then((todos) => {
        const deLaZona = todos.filter((a) => a.zoneId === zona);
        setZoneAnalyses(deLaZona);
        setVersions(buildVersions(deLaZona));
      })
      // Degrada en silencio: sin versiones la barra queda vacía, pero el resto
      // de la vista sigue funcionando igual.
      .catch(() => {})
      .finally(() => setVersionsLoading(false));

    listZones()
      .then((zonas) => setZoneName(zonas.find((z) => z.id === zona)?.name ?? null))
      .catch(() => {})
      // Pase lo que pase se apaga la bandera: si la consulta falla o la zona no
      // aparece, el título tiene que resolverse a su respaldo en vez de quedar
      // mostrando un esqueleto para siempre.
      .finally(() => setZoneNameLoading(false));
  };

  /** Captura que se está por eliminar desde la barra, o null. */
  const [versionAEliminar, setVersionAEliminar] = useState<ZoneVersion | null>(null);
  const [eliminandoVersion, setEliminandoVersion] = useState(false);

  /**
   * Elimina una captura completa de la zona: todos sus análisis y todos sus
   * archivos.
   *
   * Antes solo se podía borrar desde Vista Principal, y para llegar a una
   * versión intermedia había que saber que estaba escondida bajo el filtro
   * "Historial". Desde la barra se ve cuál es cuál y se borra la que
   * corresponde.
   *
   * Se borran TODOS los análisis de esa versión, no uno: todos miden el mismo
   * vuelo, y dejar algunos sueltos deja la versión a medias. Eso lo hace el
   * backend en UNA operación (`deleteVersion`), en vez de una llamada por
   * medición: así la vigencia de la zona se reconcilia una sola vez y la
   * bitácora registra un vuelo en lugar de N análisis sueltos. Los archivos se
   * van con ella porque ya no queda nadie que los use.
   */
  const eliminarVersion = async (version: ZoneVersion) => {
    setEliminandoVersion(true);
    try {
      const { zonaConservada } = await deleteVersion(version.sourceTaskId);
      borrarArchivosDeVersion(version.mapUrl, version.sourceTaskId);

      const restantes = versions.filter((v) => v.sourceTaskId !== version.sourceTaskId);
      setVersionAEliminar(null);

      if (restantes.length === 0) {
        // Era la única captura, así que no queda nada que mostrar acá y se
        // vuelve a Vista Principal. Pero el LUGAR puede seguir existiendo: un
        // punto permanente, o una zona a la que alguien le completó la
        // dirección, sobrevive a perder sus vuelos y vuelve a listarse como
        // sin vuelo. Decir "la zona ya no tiene capturas" en ese caso sugería
        // que el punto se había ido con ellas.
        notify.success(
          "Captura eliminada",
          zonaConservada
            ? "El punto sigue registrado, ahora sin vuelo."
            : "La zona ya no tiene capturas guardadas.",
        );
        navigate({ to: "/" });
        return;
      }

      // Si se borró la que se estaba viendo, hay que pararse en otra; si no,
      // basta con releer las capturas para que la barra se actualice.
      const borroLaActual = version.sourceTaskId === taskId;
      cargarVersionesDeLaZona(zoneId);
      if (borroLaActual) {
        const ultima = restantes[restantes.length - 1];
        const analisisVigente = ultima.analyses[ultima.analyses.length - 1];
        if (analisisVigente) aplicarAnalisis(analisisVigente);
      }
      notify.success(
        "Captura eliminada",
        `La zona conserva ${restantes.length} captura${restantes.length === 1 ? "" : "s"}.`,
      );
    } catch {
      notify.error("No se pudo eliminar la captura", "Intenta nuevamente.");
    } finally {
      setEliminandoVersion(false);
    }
  };

  /** Cambia la captura que se está viendo, sin salir de la vista. */
  const seleccionarVersion = (version: ZoneVersion) => {
    // La medición más reciente de ese vuelo es su lectura vigente.
    const ultimo = version.analyses[version.analyses.length - 1];
    if (ultimo) aplicarAnalisis(ultimo);
  };

  // ── carga inicial de detecciones al montar ─────────────────────────────────
  //
  // Un solo efecto para las dos fuentes posibles, en vez de dos separados:
  // antes, el efecto de HDU4/AC4 (abrir un análisis guardado, síncrono) y el
  // de "detectionJsonUrl" (fetch asíncrono a lo que haya quedado en
  // sessionStorage de CUALQUIER sesión anterior) corrían en paralelo, el
  // fetch async terminaba después y pisaba los datos correctos del análisis
  // recién abierto con los de la última generación/tarea, sin importar cuál
  // hubieras clickeado. Al estar en el mismo efecto, si hay un análisis
  // guardado pendiente de abrir se usa ESE y no se llega a disparar el fetch.
  //
  // hasLoadedRef evita que el CUERPO del efecto corra más de una vez para el
  // mismo montaje del componente (ej. doble-render por hot-reload en dev, o
  // cualquier remount que React dispare sin que la página realmente haya
  // cambiado). consumePendingOpenId() es de un solo uso, borra la clave de
  // sessionStorage al leerla, así que una segunda ejecución del efecto no
  // la encuentra, cae al camino de "fetch en vivo", y pisa los datos
  // correctos recién cargados con lo que haya quedado viejo en
  // detectionJsonUrl. Se vio exactamente esto: un flash correcto de los
  // polígonos del análisis guardado, seguido de un cambio casi instantáneo
  // a los de otra zona.
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    // loadAnalysisById ahora es una llamada HTTP (Mongo), el resto de este
    // efecto sigue dependiendo de que se resuelva ANTES de decidir si cae al
    // camino normal (mismo motivo documentado arriba: correr ambos caminos
    // en paralelo pisaba los datos correctos con los de la última tarea
    // vista). El await adentro de este IIFE preserva ese orden.
    (async () => {
      // HDU4 / AC4, abrir un análisis guardado desde el listado (index.tsx),
      // O un F5 sobre un análisis ya guardado: consumePendingOpenId() es de
      // un solo uso y ya se consumió en el primer mount, así que en un F5
      // cae acá gracias a loadCurrentAnalysisId() (persistido en
      // sessionStorage, ver mapState.ts). Volver a pedir el registro
      // completo a Mongo (en vez de intentar persistir cada campo, status,
      // detecciones, resumen para el banner de duplicado, por separado)
      // deja TODO consistente con una sola fuente de verdad.
      const pendingId = consumePendingOpenId() ?? loadCurrentAnalysisId();
      if (pendingId) {
        const record = await loadAnalysisById(pendingId);
        if (record) {
          aplicarAnalisis(record);
          // Las demás capturas de la misma zona, para poder navegar entre
          // ellas sin salir de la vista. buildVersions() ya agrupa por vuelo y
          // ordena por fecha de captura con desempate por carga.
          cargarVersionesDeLaZona(record.zoneId ?? null);
          setInitChecked(true);
          return;
        }
      }
      // Recién acá se sabe con certeza si había o no un análisis guardado
      // para mostrar (pendingId ausente, o presente pero sin record), antes
      // esto se marcaba síncrono al principio del efecto, y como el camino
      // de arriba depende de un await real a Mongo, quedaba una vuelta de
      // render con initChecked=true y mapUrl aún null que disparaba el
      // "flash" de "No hay un análisis para mostrar" antes de que el
      // análisis guardado realmente terminara de cargar.
      setInitChecked(true);

      // Camino normal: análisis recién generado en vivo, o "pendiente de
      // análisis" desde Vista Principal (ambos dejan detectionJsonUrl fresco).
      const jsonUrl = loadDetectionJsonUrl();
      if (!jsonUrl) return;
      // Camino "recién generado": mapUrl ya está disponible sync (leído de
      // sessionStorage), pero las detecciones dependen de este fetch aparte
      // -- sin este flag, "Zonas detectadas" mostraba "Sin detecciones
      // cargadas" (un mensaje de VACÍO, no de CARGANDO) durante esa ventana,
      // indistinguible de una zona genuinamente sin basura detectada.
      setDetectionsLoading(true);
      fetch(jsonUrl)
        .then(r => r.json())
        .then(data => {
          const escala = data.png_scale ?? 1;
          setPngScale(escala);
          const merged = mergeOverlapping(data.detections ?? [], escala);
          setDisplayDetections(merged);
          setEnabledIds(new Set(merged.map(d => d.id)));
        })
        .catch(() => {})
        .finally(() => setDetectionsLoading(false));
    })();
  }, []);

  // Al salir de /analysis por navegación real dentro de la app (sidebar,
  // Link, etc.) se limpia el hand-off, si no, una vuelta directa a
  // /analysis desde el sidebar (sin pasar por openZone/reviewPending, que sí
  // dejan mapUrl fresco a propósito) resucitaba el último análisis visto en
  // vez de mostrar "No hay un análisis para mostrar". Esta cleanup NO corre
  // en un F5/cierre real: el navegador destruye el contexto de JS antes de
  // que React llegue a ejecutar el cleanup, así que un F5 sobre el mismo
  // análisis lo sigue mostrando (mismo comportamiento ya confirmado en
  // HDU4/AC5).
  useEffect(() => {
    return () => {
      clearMapUrl();
      clearThumbnailUrl();
      clearDetectionJsonUrl();
      clearCurrentAnalysisId();
      // Acá se llamaba a clearZonaDestino(), y era un defecto: desmontar esta
      // vista no significa que la carga terminó, significa que el trabajador
      // navegó. Mirar el mapa recién generado y volver atrás desligaba en
      // silencio la zona que había elegido antes de subir las fotos, y el
      // análisis terminaba guardándose en una zona nueva.
      //
      // La zona se limpia donde de verdad caduca: al empezar otra carga
      // (goToCarga) y al guardar el análisis, que es cuando se consume.
    };
  }, []);

  // ── sincronización si el mapa termina mientras se está en esta vista ───────

  useEffect(() => {
    const handler = (e: Event) => {
      const url = (e as CustomEvent<{ url: string }>).detail.url;
      setMapUrl(url);
      setThumbnailUrl(loadThumbnailUrl());
      if (loadNoWasteDetected()) {
        setStatus("empty");
        setAnalysisMessage("No hay basura detectada en el área");
      } else {
        setStatus("idle");
        setAnalysisMessage(null);
      }
    };
    window.addEventListener(MAP_READY_EVENT, handler);
    return () => window.removeEventListener(MAP_READY_EVENT, handler);
  }, []);

  // ── análisis de volumen ────────────────────────────────────────────────────

  const runAnalysis = async () => {
    if (!mapUrl || !taskId || !detectionJsonUrl) {
      setAnalysisMessage("No se encontró la tarea. Regenera el mapa desde la vista de carga.");
      setStatus("error");
      return;
    }

    // HDU12: con el modo de zonas de basura encendido, el análisis es para
    // volver a medir con las zonas nuevas, y sin ninguna no hay nada que
    // medir de nuevo. Se advierte y no se ejecuta.
    if (zonaModo && zonasManuales.length === 0) {
      const aviso =
        "No hay nuevas zonas añadidas. Dibuja y confirma al menos una zona de basura para volver a analizar.";
      setAnalysisMessage(aviso);
      notify.warning("No hay nuevas zonas añadidas", aviso);
      return;
    }

    setStatus("running");
    setProgress(10);
    setAnalysisMessage(null);

    try {
      const manualPrevias = displayDetections.filter((d) => d.manual).length;
      const zonasNuevas: ZonaManual[] = zonasManuales.map((z) => ({ class: z.clase, polygon: z.pts }));
      const startResult = await startVolumeAnalysis(taskId, zonasNuevas);
      if (startResult.status === "error") {
        setAnalysisMessage(startResult.message ?? "Error al iniciar el análisis");
        setStatus("error");
        return;
      }
      // El vuelo perdió sus modelos de elevación porque hay una captura más
      // reciente de la zona. No es un error del sistema, es una regla: se
      // deja el motivo a la vista y se deshabilita el botón.
      if (startResult.status === "unavailable") {
        setCanAnalyze(false);
        setCannotAnalyzeReason(startResult.message ?? null);
        console.log("CannotAnalyzeReason")
        setAnalysisMessage(startResult.message ?? null);
        setStatus("error");
        return;
      }

      const response = await pollVolumeAnalysis(taskId, detectionJsonUrl, setProgress);
      if (response.status === "success") {
        setPngScale(response.pngScale);
        const merged = mergeOverlapping(response.detections, response.pngScale);
        setDisplayDetections(merged);
        setEnabledIds(new Set(merged.map(d => d.id)));
        // El área relevante se conserva: es lo que descarta las detecciones del
        // análisis nuevo. Lo que se reinicia es lo restaurado a mano, que era de
        // la medición anterior, y las zonas dibujadas, que ya son detecciones.
        setRestauradasIds(new Set());
        // Las zonas dibujadas solo se sueltan si el servidor las registro: si
        // el analisis volvio sin ellas (un servidor que no las conoce, o que
        // las descarto), se dejan a la vista en vez de borrarlas en silencio.
        const manualTras = response.detections.filter((d) => d.manual).length;
        const zonasRegistradas = zonasNuevas.length === 0 || manualTras >= manualPrevias + zonasNuevas.length;
        if (zonasRegistradas) {
          setZonasManuales([]);
          setZonaPendiente(null);
          setZonaModo(false);
          setZonaEnEdicion(null);
        } else {
          notify.error(
            "Las zonas dibujadas no entraron al análisis",
            "El servidor no las registró. Se conservan en pantalla para reintentar.",
          );
        }
        setDraftPoints([]);
        setAreaMode("idle");
        setCrs(response.crs || undefined);
        setOrthoCenter(response.orthoCenter ?? null);
        setOrthoBounds(response.orthoBounds ?? null);
        // Datos de la captura y sello del cálculo: se leen del estado de la
        // tarea recién analizada y viajan con el análisis al guardarlo.
        const estado = await getTaskStatus(taskId);
        if (estado?.capture_date) {
          setCaptureDate(estado.capture_date);
          setCaptureDateEstimated(Boolean(estado.capture_date_estimated));
        }
        if (estado?.algorithm_version != null) setAlgorithmVersion(estado.algorithm_version);
        // **El lugar declarado se recupera de la TAREA cuando el navegador ya
        // no lo tiene.**
        //
        // `zoneId` arranca de `sessionStorage`, que se borra al cerrar el
        // navegador mientras la tarea sigue viva en Mongo. Ese hueco desligaba
        // el vuelo de su punto: se declaraba el lugar, se generaba, se apagaba
        // la máquina con el análisis pendiente, y al volver a guardar
        // `_resolve_zone()` no recibía zona y creaba una nueva, o sea el
        // huérfano que la unificación vino a eliminar.
        //
        // Solo rellena si no hay nada: dentro de la misma pestaña manda lo que
        // el trabajador acaba de elegir, y pisarlo con el dato del servidor
        // revertiría un cambio de destino hecho recién.
        if (estado?.zone_id) setZoneId((previa) => previa ?? estado.zone_id!);
        // Una medición nueva es un análisis nuevo, no una corrección del
        // anterior: se suelta la identidad del guardado para que "Guardar"
        // cree un registro con su propia fecha en vez de sobrescribir.
        setCurrentAnalysisId(null);
        clearCurrentAnalysisId();
        setStatus("done");
      } else if (response.status === "empty") {
        setAnalysisMessage(response.message);
        setStatus("empty");
      } else {
        setAnalysisMessage(response.message);
        setStatus("error");
      }
    } catch {
      setAnalysisMessage("No se pudo completar el análisis de volumen. Intenta nuevamente.");
      setStatus("error");
    }
  };

  // ── controles del visor ────────────────────────────────────────────────────

  const resetView = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setRotacion(0);
  };

  /** Gira una cantidad de grados relativa, envolviendo en 360. */
  const girar = (grados: number) => {
    setRotacion((r) => (((r + grados) % 360) + 360) % 360);
  };

  /** Fija el ángulo absoluto, para el deslizador y el campo numérico. */
  const fijarRotacion = (grados: number) => {
    if (!Number.isFinite(grados)) return;
    setRotacion((((Math.round(grados) % 360) + 360) % 360));
  };

  /** Cuánto encoger el contenido girado para que siga entrando en el visor.
   *
   *  Una caja de ancho W y alto H girada un ángulo t ocupa una caja envolvente
   *  de `W·|cos t| + H·|sin t|` por `W·|sin t| + H·|cos t|`. El factor que la
   *  devuelve adentro es el menor de las dos proporciones, acotado a 1 porque
   *  nunca se agranda. En 0 y 180 grados da exactamente 1, y en 90 da
   *  `min(W/H, H/W)`, que era el caso particular que esto resolvía antes.
   *
   *  **Es la fórmula la que hizo barato el ángulo libre**: sin ella habría que
   *  tener un factor por ángulo, que es lo que parecía caro.
   *
   *  Ajusta la CAJA y la imagen va `object-contain` dentro, así que el resultado
   *  es conservador: si la foto no llena la caja, podría crecer un poco más.
   *  Preferible a lo contrario, que es recortarla.
   *
   *  **Se lee del DOM en cada render y no se memoiza**: depende del tamaño del
   *  visor, que cambia con la ventana y con el ancho del panel de detecciones.
   *  Son dos propiedades, así que recalcular siempre sale más barato que
   *  mantenerlo sincronizado. */
  const factorRotacion = (() => {
    if (rotacion % 180 === 0) return 1;
    const el = containerRef.current;
    if (!el || !el.clientWidth || !el.clientHeight) return 1;
    const rad = (rotacion * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sen = Math.abs(Math.sin(rad));
    const w = el.clientWidth;
    const h = el.clientHeight;
    const anchoGirado = w * cos + h * sen;
    const altoGirado = w * sen + h * cos;
    return Math.min(w / anchoGirado, h / altoGirado, 1);
  })();

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect  = container.getBoundingClientRect();
    const px    = event.clientX - rect.left;
    const py    = event.clientY - rect.top;
    const mapX  = (px - offset.x) / scale;
    const mapY  = (py - offset.y) / scale;
    const next  = Math.min(4, Math.max(0.7, scale + (event.deltaY < 0 ? 0.14 : -0.14)));
    const ns    = Number(next.toFixed(2));
    setOffset({ x: px - mapX * ns, y: py - mapY * ns });
    setScale(ns);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).tagName === "IMG") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = {
      x: event.clientX, y: event.clientY,
      offsetX: offset.x, offsetY: offset.y,
    };
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setOffset({
      x: dragStart.current.offsetX + event.clientX - dragStart.current.x,
      y: dragStart.current.offsetY + event.clientY - dragStart.current.y,
    });
  };

const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
  event.currentTarget.releasePointerCapture(event.pointerId);
  setDragging(false);
  if (areaMode === "drawing" && dragging && event.button === 0) {
    const moved = Math.hypot(event.clientX - dragStart.current.x, event.clientY - dragStart.current.y);
    if (moved < 4) addAreaPoint(event.clientX, event.clientY);
  } else if (areaMode === "idle" && analysisArea && dragging && event.button === 0) {
    const moved = Math.hypot(event.clientX - dragStart.current.x, event.clientY - dragStart.current.y);
    if (moved < 4) seleccionarAreaEn(event.clientX, event.clientY);
  }
};
  



  // ── render ─────────────────────────────────────────────────────────────────

  // Mientras se resuelve si hay o no un análisis para mostrar (ver el efecto
  // de arriba), antes de esto, la navegación a /analysis ya es instantánea,
  // pero este tramo se renderizaba con datos todavía vacíos (mapUrl/
  // detecciones/métricas en null) en vez de un estado de carga honesto.
  if (!initChecked) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">Cargando análisis...</p>
      </div>
    );
  }

  if (!mapUrl) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground">
        <BarChart3 className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm font-medium">No hay un análisis para mostrar</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Abre una zona desde la Vista Principal para ver su análisis de volumen.
        </p>
        <Link to="/">
          <Button variant="secondary" size="sm">
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Volver a Vista Principal
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background text-foreground">
      {/* Tres columnas: controles, mapa y zonas detectadas.

          Las zonas detectadas estuvieron una vuelta como franja horizontal bajo
          el mapa y se descartó: una lista se recorre de arriba abajo, y puesta
          a lo ancho obligaba a leer en zigzag. En columna propia se recorre de
          un vistazo y el mapa conserva su alto completo.

          Bajo 80rem no hay ancho para tres columnas sin dejar el visor
          inservible, así que ahí la lista pasa a ocupar una fila propia debajo
          (col-span-2), que es la única disposición razonable en pantallas
          angostas. */}
      <main className="grid flex-1 min-h-0 grid-cols-[clamp(15rem,22vw,22.5rem)_1fr] grid-rows-[minmax(0,1fr)_auto] xl:grid-cols-[clamp(15rem,19vw,19rem)_1fr_clamp(17rem,23vw,25rem)] xl:grid-rows-1">

        {/* ── panel lateral ── */}
        {/* Los dos paneles laterales van sobre superficie de tarjeta y el
            visor sobre el fondo del cuerpo. Es lo que separa los planos ahora
            que no hay trama de fondo: sin esta diferencia de tono, panel y
            mapa quedaban del mismo color y la pantalla se leía como una sola
            plancha. Mismo criterio que un IDE o un SIG: los paneles son
            superficie, el lienzo es fondo. */}
        <aside
          id="dashboard"
          className="border-r border-border/35 bg-card/50 p-5 overflow-y-auto"
        >
          <div className="flex flex-col gap-4">

            {/* El título es el NOMBRE DE LA ZONA, no la palabra "Análisis".
                Antes la vista no decía en ningún lado qué zona se estaba
                mirando: con varias zonas guardadas y capturas de fechas
                parecidas, era imposible saberlo sin volver a Vista Principal.
                Qué vista es ya lo dice el sidebar y lo dice el cintillo; lo que
                falta acá es de qué terreno se está hablando.

                Cae a "Análisis" mientras la zona no se conoce todavía: una
                generación recién hecha aún no tiene zona asignada, eso pasa al
                guardarla. */}
            <div>
              <p className="eyebrow">Análisis de volumen</p>
              {zoneNameLoading ? (
                // Un esqueleto, no el nombre del análisis: ese respaldo solo
                // vale cuando ya se sabe que la zona no tiene nombre, no
                // mientras la consulta sigue en curso (ver zoneNameLoading).
                <Skeleton className="h-9 w-3/4 rounded md:h-10" />
              ) : (
                // El lápiz va DENTRO del flujo del título, no flotando a su
                // derecha: el nombre ocupa hasta dos líneas y su alto cambia con
                // el largo, así que un botón posicionado aparte terminaba
                // despegado del texto justo en los nombres largos.
                <div className="flex items-start gap-1.5">
                  <h1
                    // break-words + line-clamp: un nombre largo antes desbordaba
                    // la columna o la estiraba. Ahora corta por palabras, se
                    // limita a dos líneas y el nombre completo queda en el
                    // title. El cuerpo baja un escalón de tamaño pasados los 22
                    // caracteres, que es lo que entra cómodo en una línea al
                    // ancho de este panel.
                    title={zoneName ?? currentAnalysisName ?? undefined}
                    className={`min-w-0 font-rubik font-semibold tracking-normal text-foreground line-clamp-2 break-words hyphens-auto ${
                      (zoneName ?? currentAnalysisName ?? "").length > 22
                        ? "text-xl md:text-2xl"
                        : "text-3xl md:text-4xl"
                    }`}
                  >
                    {zoneName ?? currentAnalysisName ?? "Análisis"}
                  </h1>
                  {/* Solo con zona: antes de guardar no hay nada que renombrar,
                      el nombre que se ve es el del análisis y se pide al
                      guardar. */}
                  {zoneId && zoneName && (
                    <button
                      type="button"
                      onClick={() => setRenombrando("zona")}
                      title="Renombrar la zona"
                      aria-label="Renombrar la zona"
                      className="mt-1.5 flex-shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}
              {(currentAnalysisName || captureDate) && (
                <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                  {currentAnalysisName && (
                    // max-w-full: sin un límite, `truncate` dentro de un
                    // contenedor flex no recorta nada y el nombre desborda.
                    <span
                      title={currentAnalysisName}
                      className="max-w-full truncate font-medium text-foreground"
                    >
                      {currentAnalysisName}
                    </span>
                  )}
                  {/* El segundo renombrado, el de la versión. Va pegado a su
                      nombre y no junto al de la zona, porque son dos nombres
                      distintos y poner los dos lápices arriba no diría cuál
                      cambia cuál. */}
                  {currentAnalysisName && currentAnalysisId && (
                    <button
                      type="button"
                      onClick={() => setRenombrando("version")}
                      title="Renombrar esta versión"
                      aria-label="Renombrar esta versión"
                      className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                  {currentAnalysisName && captureDate && <span>·</span>}
                  {captureDate && (
                    <span className="mono tabular-nums">
                      captura del {new Date(captureDate).toLocaleDateString("es-CL")}
                    </span>
                  )}
                  {/* Ninguna foto traía fecha y se usó la de carga. Sin
                      decirlo, una fecha inventada se lee como real. */}
                  {captureDate && captureDateEstimated && (
                    <span className="text-warning" title="Ninguna foto traía fecha de captura; se usó la de carga">
                      (estimada)
                    </span>
                  )}
                </p>
              )}
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Activa o desactiva zonas antes de ejecutar el análisis. Los totales
                reflejan únicamente las zonas activas.
              </p>
            </div>

            {/* ── Bloque "Control": lo que el usuario opera ── */}
            <div className="rounded-lg bg-background/40 p-3 animate-in fade-in slide-in-from-left-2 duration-500 fill-mode-both space-y-4">
              <Button
                onClick={runAnalysis}
                disabled={
                  status === "running" ||
                  !usingGeneratedMap ||
                  (status === "empty" && zonasManuales.length === 0) ||
                  !canAnalyze ||
                  readOnly ||
                  // La URL del JSON de detecciones se resuelve con una consulta
                  // asíncrona al abrir un análisis guardado. Si se presionaba
                  // antes de que llegara, runAnalysis abortaba con "No se
                  // encontró la tarea", que sonaba a datos perdidos cuando solo
                  // era una carrera. Mejor no habilitar el botón hasta tenerla.
                  !detectionJsonUrl
                }
                className="w-full"
              >
                {status === "running" ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analizando...</>
                ) : (
                  <><Search className="mr-2 h-4 w-4" /> Analizar volumen</>
                )}
              </Button>

              {zonaModo && zonasManuales.length === 0 && (
                <AvisoAmbar
                  accion={
                    <Button size="sm" variant="outline" onClick={salirModoZonas}>
                      Salir del modo de zonas
                    </Button>
                  }
                >
                  No hay nuevas zonas añadidas. Para volver a analizar, dibuja y confirma al menos una
                  zona de basura, o sal del modo de zonas para analizar sin ellas.
                </AvisoAmbar>
              )}

              {/* Este vuelo no se puede volver a medir: o es una versión ya
                  reemplazada, o sus modelos de elevación se liberaron. Se
                  explica el motivo en vez de dejar un botón apagado sin razón
                  aparente. */}
              {(!canAnalyze || readOnly) && cannotAnalyzeReason && (
                <p className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[0.69rem] leading-relaxed text-muted-foreground">
                  {cannotAnalyzeReason}
                </p>
              )}

              {/* HDU13: área relevante. */}
              <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-2.5">
                <p className="text-xs font-semibold text-foreground">Área relevante</p>
                <Button
                  onClick={areaMode === "drawing" && drawKind === "area" ? cancelDrawing : () => startDrawing("area")}
                  disabled={!imgNaturalSize || readOnly}
                  variant={areaMode === "drawing" && drawKind === "area" ? "default" : "secondary"}
                  className="w-full"
                >
                  <Crosshair className="mr-2 h-4 w-4" />
                  {areaMode === "drawing" && drawKind === "area"
                    ? "Cancelar delimitación"
                    : analysisArea
                      ? "Redibujar área relevante"
                      : "Delimitar área relevante"}
                </Button>

                {areaMode === "drawing" && drawKind === "area" && (
                  <p className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[0.69rem] leading-relaxed text-muted-foreground">
                    Haz click en el mapa para poner los puntos. Para cerrar, vuelve a hacer click
                    en el primero. Retroceso deshace el último punto y Esc cancela.
                  </p>
                )}

                {analysisArea && areaMode === "idle" && (
                  <>
                    {/* Seleccionar el área (aquí o con un clic sobre ella en el
                        mapa) muestra el interruptor para activarla o desactivarla. */}
                    <div
                      role="button"
                      tabIndex={0}
                      aria-pressed={areaSeleccionada}
                      onClick={() => setAreaSeleccionada((s) => !s)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setAreaSeleccionada((s) => !s);
                        }
                      }}
                      className={`cursor-pointer rounded-md border px-2.5 py-2 text-xs transition-colors ${
                        areaSeleccionada ? "border-primary bg-primary/10" : "border-border/60 hover:bg-muted/40"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-foreground">
                          {areaSeleccionada ? "Área seleccionada" : "Área delimitada"}
                        </span>
                        <span className={areaActiva ? "text-success-strong" : "text-muted-foreground"}>
                          {areaActiva ? "Activa" : "Desactivada"}
                        </span>
                      </div>
                      {areaSeleccionada && (
                        <div
                          className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <span className="text-muted-foreground">Usar el área en el análisis</span>
                          <Switch checked={areaActiva} onCheckedChange={cambiarAreaActiva} />
                        </div>
                      )}
                    </div>
                    <Button onClick={clearArea} variant="outline" size="sm" className="w-full">
                      Quitar área
                    </Button>
                  </>
                )}
              </div>

              {/* HDU12: zonas de basura dibujadas a mano. */}
              <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-2.5">
                <p className="text-xs font-semibold text-foreground">Zonas de basura</p>
                <Button
                  onClick={areaMode === "drawing" && drawKind === "zona" ? cancelDrawing : () => startDrawing("zona")}
                  disabled={!imgNaturalSize || readOnly}
                  variant={areaMode === "drawing" && drawKind === "zona" ? "default" : "secondary"}
                  className="w-full"
                >
                  <Crosshair className="mr-2 h-4 w-4" />
                  {areaMode === "drawing" && drawKind === "zona" ? "Cancelar dibujo" : "Dibujar zona de basura"}
                </Button>

                {areaMode === "drawing" && drawKind === "zona" && (
                  <p className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[0.69rem] leading-relaxed text-muted-foreground">
                    Haz click en el mapa para marcar el contorno de la basura. Para cerrar la zona, vuelve a
                    hacer click en el primer punto. Retroceso deshace el último punto y Esc cancela.
                  </p>
                )}

                {/* La zona cerrada espera confirmación; al confirmar se pide el
                    tipo de basura. Antes de confirmar se puede reducir (arrastrando
                    los puntos del contorno) o borrar. */}
                {zonaPendiente && areaMode === "idle" && (
                  <div className="space-y-2 rounded-md border border-success/40 bg-success/10 px-2.5 py-2.5">
                    <p className="text-xs font-semibold text-foreground">Zona dibujada</p>
                    <Button size="sm" className="w-full" onClick={() => setTipoZonaOpen(true)}>
                      Confirmar zona
                    </Button>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Button
                        size="sm"
                        className="px-2"
                        variant={zonaEnEdicion === "pendiente" ? "default" : "secondary"}
                        onClick={() => setZonaEnEdicion((z) => (z === "pendiente" ? null : "pendiente"))}
                      >
                        {zonaEnEdicion === "pendiente" ? "Listo" : "Reducir área"}
                      </Button>
                      <Button
                        size="sm"
                        className="px-2"
                        variant="outline"
                        onClick={() => {
                          setZonaPendiente(null);
                          setZonaEnEdicion(null);
                        }}
                      >
                        Borrar
                      </Button>
                    </div>
                    {zonaEnEdicion === "pendiente" && (
                      <p className="text-[0.69rem] leading-relaxed text-muted-foreground">
                        Arrastra los puntos blancos del contorno hacia adentro para reducir el área. Un punto
                        intermedio de un lado agrega un vértice nuevo.
                      </p>
                    )}
                  </div>
                )}

                {zonasManuales.length > 0 && (
                  <ul className="space-y-1.5">
                    {zonasManuales.map((z) => (
                      <li key={z.uid} className="rounded-md border border-border/60 px-2 py-2">
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: classColor(z.clase) }} />
                          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{z.clase}</span>
                          <span className="text-[0.6875rem] text-muted-foreground">nueva</span>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-1.5">
                          <Button
                            size="sm"
                            className="px-2"
                            variant={zonaEnEdicion === z.uid ? "default" : "secondary"}
                            onClick={() => setZonaEnEdicion((cur) => (cur === z.uid ? null : z.uid))}
                          >
                            {zonaEnEdicion === z.uid ? "Listo" : "Reducir área"}
                          </Button>
                          <Button
                            size="sm"
                            className="px-2"
                            variant="outline"
                            onClick={() => {
                              setZonasManuales((prev) => prev.filter((o) => o.uid !== z.uid));
                              setZonaEnEdicion((cur) => (cur === z.uid ? null : cur));
                            }}
                          >
                            Borrar
                          </Button>
                        </div>
                        {zonaEnEdicion === z.uid && (
                          <p className="mt-2 text-[0.69rem] leading-relaxed text-muted-foreground">
                            Arrastra los puntos blancos del contorno hacia adentro para reducir el área. Un
                            punto intermedio de un lado agrega un vértice nuevo.
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {zonaModo && zonasManuales.length === 0 && !zonaPendiente && areaMode === "idle" && (
                  <AvisoAmbar>Aún no hay zonas nuevas. Dibuja y confirma al menos una para volver a analizar.</AvisoAmbar>
                )}

                {/* Salida del modo: sin ella, apretar "Dibujar zona de basura" por
                    error dejaba el análisis bloqueado hasta recargar la página. */}
                {zonaModo && (
                  <Button size="sm" variant="outline" className="w-full" onClick={salirModoZonas}>
                    Salir del modo de zonas
                  </Button>
                )}
              </div>

              {/* HDU12: tipo de basura de la zona dibujada. */}
              <Dialog open={tipoZonaOpen} onOpenChange={setTipoZonaOpen}>
                <DialogContent className="sm:max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Tipo de basura de la zona</DialogTitle>
                    <DialogDescription>
                      Elige qué tipo de basura hay en el área que dibujaste. Se medirá su volumen y su peso
                      con la densidad de ese tipo.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid max-h-[50vh] grid-cols-2 gap-1.5 overflow-y-auto pr-1">
                    {CLASES_DE_BASURA.map((clase) => (
                      <button
                        key={clase}
                        type="button"
                        onClick={() => confirmarZona(clase)}
                        className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 px-2.5 py-2 text-left text-xs font-medium text-foreground transition-colors hover:border-primary hover:bg-primary/10"
                      >
                        <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: classColor(clase) }} />
                        {clase}
                      </button>
                    ))}
                  </div>
                </DialogContent>
              </Dialog>

              {/* HDU4/AC1, guardar análisis. Deshabilitado en una versión ya
                  reemplazada: consultarla es válido, sobrescribirla no, porque
                  es historia de la zona y no el estado vigente del terreno. */}
              <Button
                onClick={handleSaveClick}
                disabled={status !== "done" || savingAnalysis || readOnly}
                variant="secondary"
                className="w-full"
              >
                {savingAnalysis ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                {currentAnalysisId ? "Guardar cambios" : "Guardar versión"}
              </Button>

              {/* "Informe de esta zona" y "Ver evolución" ya no viven acá:
                  pasaron al encabezado de "Zonas detectadas". Son lecturas
                  sobre el conjunto de la zona, no acciones sobre el análisis
                  abierto como analizar y guardar, y ahí quedan junto a lo que
                  resumen. */}

              {/* estado */}
              <div>
                {/* Los títulos de sección van en el color de texto pleno y las
                    etiquetas de cada dato en gris. Antes ambos eran gris y la
                    vista quedaba sin jerarquía: nada destacaba porque todo
                    pesaba lo mismo. */}
                <p className="text-xs font-semibold text-foreground mb-2.5">Estado del análisis</p>
                <div className="flex items-center gap-2">
                  {status === "running"  ? <Loader2      className="h-4 w-4 animate-spin text-primary" />
                  : status === "done"    ? <CheckCircle2 className="h-4 w-4 text-success-strong" />
                  : status === "empty"   ? <TriangleAlert className="h-4 w-4 text-warning" />
                  :                        <Clock         className="h-4 w-4 text-muted-foreground" />}
                  <p className="text-xs font-medium">{statusLabel[status]}</p>
                </div>
                <Progress value={progress} className="mt-2.5 h-1" />
                <p className="mono mt-1 text-[0.625rem] tabular-nums text-muted-foreground">
                  {progress}% completado
                </p>
              </div>
            </div>

            {/* ── Bloque "Resultados": lo que el usuario revisa ── */}
            {(status === "empty" || status === "error") ? (
              <div className="rounded-lg bg-background/40 p-3 animate-in fade-in slide-in-from-left-2 duration-500 delay-100 fill-mode-both">
                <div className="flex flex-col items-center justify-center rounded-md border border-warning/40 bg-warning/10 p-5 text-center">
                  {status === "empty"
                    ? <Trash2        className="mb-3 h-8 w-8 text-warning" />
                    : <TriangleAlert className="mb-3 h-8 w-8 text-warning" />}
                  <p className="text-sm font-semibold">
                    {analysisMessage || "No hay basura detectada en el área"}
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {status === "empty"
                      ? "El análisis finalizó correctamente, pero no encontró polígonos de residuos en el mapa unificado."
                      : !canAnalyze
                        // No es una falla del servicio: es la regla de
                        // retención. El texto genérico de error hacía parecer
                        // roto algo que funciona como se diseñó.
                        ? "No es un error del sistema. Este vuelo conserva su mapa y los análisis que ya se le hicieron, pero no se puede volver a medir."
                        : "El servicio de análisis no retornó resultados válidos para mostrar."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="rounded-lg bg-background/40 p-3 animate-in fade-in slide-in-from-left-2 duration-500 delay-100 fill-mode-both space-y-4">
                {/* métricas */}
                <div>
                  <p className="text-xs font-semibold text-foreground mb-2.5">Métricas</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Metric
                      label="Volumen total"
                      value={status === "done" ? `${volumen(activeSummary.totalVolumeM3)} m³` : "-"}
                      icon={<Boxes className="h-4 w-4" />}
                    />
                    <Metric
                      label="Peso total"
                      value={status === "done" ? `${peso(activeSummary.totalWeightKg)} kg` : "-"}
                      icon={<Scale className="h-4 w-4" />}
                    />
                    <Metric
                      label="Área total"
                      value={status === "done" ? `${area(activeSummary.totalAreaM2)} m²` : "-"}
                      icon={<Crosshair className="h-4 w-4" />}
                    />
                    <Metric
                      label="Zonas activas"
                      value={`${enabledIds.size} / ${visibleDetections.length}`}
                      icon={<MapIcon className="h-4 w-4" />}
                    />
                  </div>
                </div>

              </div>
            )}
          </div>
        </aside>

        {/* ── visor de mapa ── */}
        {/* Las esquinas decorativas van acá, en el marco del visor, y NO sobre
            el <img>: la imagen vive dentro de un contenedor con transform de
            zoom/paneo, así que colgadas ahí escalarían con la rueda. En el
            visor quedan fijas, a 10px del borde, lejos de donde caen los
            rectángulos que dibuja el modelo dentro de la imagen. */}
        <section className="detect-frame relative min-w-0 overflow-hidden bg-background animate-in fade-in duration-500">
          <span className="detect-corners" aria-hidden="true" />
          {usingGeneratedMap ? (
            <>
              <div className="absolute left-4 top-4 z-20 rounded-md border border-border bg-card/90 px-3 py-2 text-xs shadow-xl backdrop-blur">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <MousePointerClick className="h-3.5 w-3.5 text-primary" />
                  Rueda para zoom, click izquierdo sostenido para mover
                </div>
              </div>

              {/* Girar y reiniciar van juntos arriba a la derecha: los tres
                  actúan sobre el encuadre y no sobre el análisis. Los de giro
                  son solo ícono porque son un par simétrico que se entiende por
                  la forma, y llevan `title` y `aria-label` con el sentido. */}
              <div className="absolute right-4 top-4 z-20 flex flex-col gap-2 rounded-md border border-border bg-card/90 p-2 shadow-xl backdrop-blur">
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => girar(-90)}
                    title="Girar un cuarto de vuelta a la izquierda"
                    aria-label="Girar el mapa 90 grados a la izquierda"
                    className="h-8 w-8 flex-shrink-0 p-0"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => girar(90)}
                    title="Girar un cuarto de vuelta a la derecha"
                    aria-label="Girar el mapa 90 grados a la derecha"
                    className="h-8 w-8 flex-shrink-0 p-0"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                  </Button>
                  {/* El ángulo **se escribe**, no solo se lee: con el deslizador
                      es imposible clavar un valor exacto, y quien quiere 37
                      grados porque es como corre la calle necesita poder
                      teclearlo. Los dos controles mueven el mismo estado. */}
                  <label className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
                    <input
                      type="number"
                      min={0}
                      max={359}
                      value={rotacion}
                      onChange={(e) => fijarRotacion(Number(e.target.value))}
                      aria-label="Ángulo de giro en grados"
                      className="mono h-8 w-14 rounded-md border border-border bg-background px-1.5 text-right text-[0.6875rem] tabular-nums text-foreground"
                    />
                    °
                  </label>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={resetView}
                    className="h-8 flex-shrink-0 px-2.5 text-xs"
                  >
                    Reiniciar
                  </Button>
                </div>
                {/* El deslizador va en su propia fila y a lo ancho del panel:
                    en la misma fila que cuatro controles quedaba de 3 rem, donde
                    un grado es medio pixel y apuntar es imposible. */}
                <input
                  type="range"
                  min={0}
                  max={359}
                  value={rotacion}
                  onChange={(e) => fijarRotacion(Number(e.target.value))}
                  aria-label="Girar el mapa, en grados"
                  className="h-1.5 w-full cursor-pointer accent-primary"
                />
              </div>

              {/* key={animKey}: al cambiar de captura por la barra inferior,
                  React reemplaza este subárbol y la animación de entrada se
                  vuelve a ejecutar, así el cambio de mapa se ve como una
                  transición y no como un parpadeo. */}
              <div
                key={animKey}
                ref={containerRef}
                role="presentation"
                onWheel={onWheel}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => setDragging(false)}
                className={`h-full w-full touch-none select-none overflow-hidden animate-in fade-in zoom-in-95 duration-300 ${
                  dragging ? "cursor-grabbing" : areaMode === "drawing" ? "cursor-crosshair" : "cursor-grab"
                }`}
              >
                <div
                  className="relative h-full w-full"
                  style={{
                    transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                    transformOrigin: "0 0",
                    transition: dragging ? "none" : "transform 120ms ease-out",
                  }}
                >
                  {/* inset-8 y no inset-4: la sombra de .map-float se difunde unos
                      26px hacia abajo y el visor recorta su contenido, así que con
                      16px de aire quedaba cortada contra el borde del panel y la
                      imagen no llegaba a levantarse. De paso deja las esquinas
                      amarillas de .detect-frame por fuera de la imagen en vez de
                      encima. */}
                  {/* **El giro se aplica ACÁ y no en el contenedor de zoom**, y
                      es lo que mantiene alineadas las detecciones: la imagen y
                      el SVG de recuadros son hermanos dentro de esta misma caja,
                      así que girarla gira las dos juntas y ningún rectángulo se
                      corre. Aplicado en el contenedor de arriba habría roto la
                      aritmética del paneo, que descuenta `offset` y `scale`
                      suponiendo un `transformOrigin` en el vértice. */}
                  <div
                    className="absolute inset-8 flex items-center justify-center"
                    style={{
                      transform: `rotate(${rotacion}deg) scale(${factorRotacion})`,
                      // **Sin transición, y es por el deslizador.** Tenía 200 ms
                      // de suavizado, que está bien para un salto de 90 grados y
                      // mal para arrastrar: la imagen quedaba persiguiendo al
                      // cursor un quinto de segundo atrás, así que elegir un
                      // ángulo a ojo se volvía imposible. Un editor de imágenes
                      // tampoco interpola mientras se gira.
                    }}
                  >
                    {/* La imagen llena esta caja y el SVG se superpone sobre LA
                        MISMA caja con position: absolute. Las dos letterboxean
                        igual (object-contain y xMidYMid meet hacen la misma
                        cuenta), así que los rectángulos caen sobre la foto se
                        amplíe o no.

                        **Esto estuvo como una celda de grid y hay que no
                        volver a hacerlo.** La idea era que el <img> midiera
                        exactamente la foto (max-h/max-w en vez de h-full/w-full)
                        y que el SVG heredara esa caja; pero con
                        place-items-center los ítems NO se estiran, así que el
                        h-full/w-full del SVG no tenía contra qué resolverse y el
                        <svg> caía a su tamaño por omisión de 300px. Con un
                        ortomosaico de miles de píxeles en el viewBox eso dibuja
                        todo a un 7% de escala: el stroke de 1.5 queda en una
                        décima de píxel y las detecciones desaparecen de la
                        vista. El mapa se veía bien y los polígonos no.

                        Y la razón que justificaba esa celda ya no existe: era
                        .map-plate, que dibujaba un filete en el borde y
                        necesitaba que la caja fuera la foto. Hoy es .map-float,
                        que es filter: drop-shadow, y **drop-shadow sigue el
                        canal alfa, no la caja**, así que el aire transparente de
                        object-contain no aporta sombra. La sombra sigue el
                        contorno real del vuelo igual que antes. */}
                    <div className="relative h-full w-full">
                      <img
                        src={mapUrl!}
                        alt="Mapa unificado para analisis de volumen"
                        className="map-float h-full w-full object-contain pointer-events-none"
                        draggable={false}
                        onDragStart={e => e.preventDefault()}
                        onLoad={e => {
                          const img = e.currentTarget;
                          setImgNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
                        }}
                      />
                      {imgNaturalSize && (displayDetections.length > 0 || analysisArea || zonasManuales.length > 0 || zonaPendiente || draftPoints.length > 0) && (() => {
                        const enabledDets = displayDetections.filter(d => enabledIds.has(d.id));
                        const vols = enabledDets.map(d => d.volume_m3 ?? 0).filter(v => v > 0);
                        const minVol = vols.length > 0 ? Math.min(...vols) : 0;
                        const maxVol = vols.length > 0 ? Math.max(...vols) : 0;
                        const hasVolData = status === "done" && maxVol > 0;
                        const svgEl = svgRef.current;
                        const ppu = svgEl?.clientWidth && svgEl?.clientHeight
                        ? Math.min(svgEl.clientWidth / imgNaturalSize.w, svgEl.clientHeight / imgNaturalSize.h) * scale * factorRotacion
                        : 0.1; // pixeles de pantalla por pixel de imagen
                        const toPts = (pts: AreaPoint[]) => pts.map(([x, y]) => `${x},${y}`).join(" ");
                        const colorBorrador = drawKind === "zona" ? "#22c55e" : "#38bdf8";
                        return (
                          <svg
                            ref={svgRef}
                            viewBox={`0 0 ${imgNaturalSize.w} ${imgNaturalSize.h}`}
                            className="absolute inset-0 h-full w-full pointer-events-none"
                            preserveAspectRatio="xMidYMid meet"
                          >
                            {enabledDets.map(d => {
                              const strokeColor = classColor(d.class);
                              const fillColor = hasVolData && d.volume_m3 != null
                                ? volumeToFillColor(d.volume_m3, minVol, maxVol)
                                : strokeColor;
                              const bw   = d.bbox.maxx - d.bbox.minx;
                              const bh   = d.bbox.maxy - d.bbox.miny;
                              const FONT = 24;
                              const rings = d.rings ?? escalarAnillos(d.polygon, pngScale);
                              return (
                                <g key={d.id}>
                                  {rings.length > 0 ? (
                                    <path
                                      d={ringsToPath(rings)}
                                      fill={fillColor}
                                      fillOpacity={0.35}
                                      stroke={strokeColor}
                                      strokeWidth={1.5}
                                      strokeLinejoin="round"
                                    />
                                  ) : (
                                    <rect
                                      x={d.bbox.minx} y={d.bbox.miny}
                                      width={bw} height={bh}
                                      fill={fillColor}
                                      fillOpacity={0.35}
                                      stroke={strokeColor}
                                      strokeWidth={1.5}
                                      strokeLinejoin="round"
                                    />
                                  )}
                                  <text
                                    x={d.bbox.minx}
                                    y={d.bbox.miny - 6}
                                    fontSize={FONT}
                                    fill={strokeColor}
                                    fontFamily="monospace"
                                    fontWeight="700"
                                    paintOrder="stroke"
                                    stroke="rgba(0,0,0,0.75)"
                                    strokeWidth={5}
                                    strokeLinejoin="round"
                                  >
                                    {d.class}
                                  </text>
                                </g>
                              );
                            })}
                            {/* HDU13: detecciones que el área relevante descartó, con un
                                estilo distinto (contorno gris punteado, sin relleno). */}
                            {mostrarDescartadas && descartadas.map(d => {
                              const rings = d.rings ?? escalarAnillos(d.polygon, pngScale);
                              return (
                                <g key={`desc-${d.id}`} opacity={0.9}>
                                  {rings.length > 0 ? (
                                    <path
                                      d={ringsToPath(rings)}
                                      fill="none"
                                      stroke="#94a3b8"
                                      strokeWidth={2 / ppu}
                                      strokeDasharray={`${6 / ppu} ${4 / ppu}`}
                                      strokeLinejoin="round"
                                    />
                                  ) : (
                                    <rect
                                      x={d.bbox.minx} y={d.bbox.miny}
                                      width={d.bbox.maxx - d.bbox.minx} height={d.bbox.maxy - d.bbox.miny}
                                      fill="none"
                                      stroke="#94a3b8"
                                      strokeWidth={2 / ppu}
                                      strokeDasharray={`${6 / ppu} ${4 / ppu}`}
                                    />
                                  )}
                                  <text
                                    x={d.bbox.minx}
                                    y={d.bbox.miny - 6}
                                    fontSize={22}
                                    fill="#cbd5e1"
                                    fontFamily="monospace"
                                    paintOrder="stroke"
                                    stroke="rgba(0,0,0,0.75)"
                                    strokeWidth={5}
                                  >
                                    {d.class} (descartada)
                                  </text>
                                </g>
                              );
                            })}

                            {/* HDU13: el área relevante. Activa oscurece lo de afuera;
                                desactivada queda solo su contorno, en gris. Seleccionada,
                                el contorno se engrosa. */}
                            {analysisArea && (
                              <>
                                {areaActiva && (
                                  <path
                                    fillRule="evenodd"
                                    fill="black"
                                    fillOpacity={0.35}
                                    d={`M0 0H${imgNaturalSize.w}V${imgNaturalSize.h}H0Z` +
                                      `M${analysisArea.map(([x, y]) => `${x} ${y}`).join("L")}Z`}
                                  />
                                )}
                                <polygon
                                  points={toPts(analysisArea)}
                                  fill="none"
                                  stroke={areaActiva ? "#38bdf8" : "#94a3b8"}
                                  strokeWidth={(areaSeleccionada ? 4 : 2) / ppu}
                                  strokeDasharray={`${8 / ppu} ${5 / ppu}`}
                                  strokeLinejoin="round"
                                />
                              </>
                            )}

                            {/* HDU12: zonas de basura confirmadas, todavía sin analizar. */}
                            {zonasManuales.map(z => (
                              <g key={z.uid}>
                                <polygon
                                  points={toPts(z.pts)}
                                  fill={classColor(z.clase)}
                                  fillOpacity={0.3}
                                  stroke={classColor(z.clase)}
                                  strokeWidth={2.5 / ppu}
                                  strokeDasharray={`${8 / ppu} ${5 / ppu}`}
                                  strokeLinejoin="round"
                                />
                                <text
                                  x={Math.min(...z.pts.map(q => q[0]))}
                                  y={Math.min(...z.pts.map(q => q[1])) - 6}
                                  fontSize={24}
                                  fill={classColor(z.clase)}
                                  fontFamily="monospace"
                                  fontWeight="700"
                                  paintOrder="stroke"
                                  stroke="rgba(0,0,0,0.75)"
                                  strokeWidth={5}
                                >
                                  {z.clase} (nueva)
                                </text>
                              </g>
                            ))}

                            {/* HDU12: zona dibujada que espera confirmación. */}
                            {zonaPendiente && (
                              <polygon
                                points={toPts(zonaPendiente)}
                                fill="#22c55e"
                                fillOpacity={0.25}
                                stroke="#22c55e"
                                strokeWidth={2.5 / ppu}
                                strokeLinejoin="round"
                              />
                            )}

                            {/* HDU12: manijas para reducir o reformar el contorno de una zona. */}
                            {zonaEnEdicion && (() => {
                              const pts =
                                zonaEnEdicion === "pendiente"
                                  ? zonaPendiente
                                  : (zonasManuales.find((z) => z.uid === zonaEnEdicion)?.pts ?? null);
                              if (!pts) return null;
                              const id = zonaEnEdicion;
                              return (
                                <g>
                                  {pts.map(([x, y], i) => {
                                    const [x2, y2] = pts[(i + 1) % pts.length];
                                    const mx = (x + x2) / 2;
                                    const my = (y + y2) / 2;
                                    return (
                                      <circle
                                        key={`m${i}`}
                                        cx={mx}
                                        cy={my}
                                        r={4 / ppu}
                                        fill="#ffffff"
                                        fillOpacity={0.55}
                                        stroke="#0f172a"
                                        strokeWidth={1 / ppu}
                                        style={{ pointerEvents: "all", cursor: "copy" }}
                                        onPointerDown={(e) => insertarVertice(e, id, i, mx, my)}
                                        onPointerMove={moverArrastre}
                                        onPointerUp={terminarArrastre}
                                        onPointerCancel={terminarArrastre}
                                      />
                                    );
                                  })}
                                  {pts.map(([x, y], i) => (
                                    <circle
                                      key={`v${i}`}
                                      cx={x}
                                      cy={y}
                                      r={6 / ppu}
                                      fill="#ffffff"
                                      stroke="#0f172a"
                                      strokeWidth={1.5 / ppu}
                                      style={{ pointerEvents: "all", cursor: "grab" }}
                                      onPointerDown={(e) => iniciarArrastre(e, id, i)}
                                      onPointerMove={moverArrastre}
                                      onPointerUp={terminarArrastre}
                                      onPointerCancel={terminarArrastre}
                                    />
                                  ))}
                                </g>
                              );
                            })()}

                            {/* polígono en construcción */}
                            {areaMode === "drawing" && draftPoints.length > 0 && (
                              <g>
                                <polyline points={toPts(draftPoints)} fill="none" stroke={colorBorrador} strokeWidth={2 / ppu} />
                                {draftPoints.map(([x, y], i) => (
                                  <circle
                                    key={i}
                                    cx={x} cy={y}
                                    r={(i === 0 && draftPoints.length >= 3 ? 7 : 4) / ppu}
                                    fill={i === 0 ? "#ffffff" : colorBorrador}
                                    stroke="#0f172a"
                                    strokeWidth={1.5 / ppu}
                                  />
                                ))}
                              </g>
                            )}
                          </svg>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
              <MapIcon className="h-12 w-12 text-muted-foreground/30" />
              <div>
                <p className="text-sm font-semibold text-foreground">No hay mapa generado</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Para analizar el área primero debes generar el mapa unificado desde la vista de carga.
                </p>
              </div>
              <Link to="/carga">
                <Button variant="secondary" size="sm">
                  Ir a Unificación de imágenes
                </Button>
              </Link>
            </div>
          )}
        </section>

        {/* ── zonas detectadas ── */}
        {/* El tope de alto es solo del layout angosto (abajo de 80rem esta
            columna baja a su propia fila y no puede comerse el visor). Con el
            aviso de duplicado presente el tope sube: 30vh alcanza para la lista
            de zonas, no para la lista más una pregunta con sus candidatos, y con
            el tope chico había que desplazar bastante para llegar a las
            respuestas. En el layout de tres columnas no hay tope y esto no
            aplica. */}
        <aside
          className={`col-span-2 flex min-h-0 flex-col border-t border-border/40 bg-card/50 px-4 py-3 xl:col-span-1 xl:max-h-none xl:border-l xl:border-t-0 ${
            duplicateWarning ? "max-h-[55vh]" : "max-h-[30vh]"
          }`}
        >
          <div className="mb-2.5 flex items-baseline justify-between gap-2">
            <p className="text-sm font-semibold text-foreground">Zonas detectadas</p>
            {displayDetections.length > 0 && (
              <button
                onClick={toggleAll}
                className="cursor-pointer text-xs text-primary transition-colors hover:underline"
              >
                {allEnabled ? "Desactivar todas" : "Activar todas"}
              </button>
            )}
          </div>

          {/* HDU9 y HDU10 al alcance de la mano. Antes había que salir a Vista
              Principal, buscar la zona en una tabla y volver. Los botones de
              allá se mantienen: el informe de Vista Principal permite elegir
              varias zonas, que es lo que pide el AC1. */}
          {zoneId && (
            <div className="mb-3 grid grid-cols-2 gap-2 xl:grid-cols-1">
              <Button
                size="sm"
                variant="secondary"
                className="w-full"
                onClick={() => setReportOpen(true)}
                disabled={zoneAnalyses.length === 0}
              >
                <FileText className="mr-2 h-4 w-4" /> Informe de esta zona
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="w-full"
                onClick={() => setEvolutionOpen(true)}
                disabled={zoneAnalyses.length === 0}
              >
                <ChartLineUp className="mr-2 h-4 w-4" /> Ver evolución
              </Button>
            </div>
          )}

          {/* Lista vertical de dos líneas por zona, no una tabla de columnas.
              En una columna de ~20rem no caben seis columnas, pero lo que hace
              comparable a una tabla se conserva igual: el volumen, que es la
              cifra con la que se decide, va alineado a la derecha, así que las
              cifras quedan una debajo de otra aunque los nombres midan
              distinto. El resto (área, peso, participación) baja a una segunda
              línea en gris, que es el orden de importancia real.

              Dos tamaños de letra en todo el panel: text-xs para lo principal y
              0.6875rem para la línea secundaria. */}
          {/* UNA sola región desplazable para la lista, los totales y el aviso de
              duplicado. Antes la lista era la que crecía (flex-1) y los totales
              quedaban clavados al pie de la columna, así que entre el último
              polígono y el total aparecía un hueco cuando había pocas zonas, y
              el total se leía como un pie de página en vez del cierre de la
              lista. Ahora los tres van en flujo normal: el total sale
              inmediatamente después del último polígono, el aviso debajo de él,
              y el espacio que sobra queda abajo, vacío.

              El encabezado y los botones de la zona quedan FUERA de esta región
              a propósito: son los controles de la columna y no tienen que
              desplazarse con su contenido. */}
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
          {detectionsLoading ? (
            <div className="space-y-1">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-11 w-full rounded-md" />
              ))}
            </div>
          ) : displayDetections.length > 0 ? (
            <>
              <ul
                key={animKey}
                className="space-y-0.5 animate-in fade-in slide-in-from-bottom-2 duration-300"
              >
                {detectionRows.map((d, i) => {
                  const enabled = enabledIds.has(d.id);
                  const desplegada = expandedIds.has(d.id);
                  const fusionada = d.classes.length > 1;
                  const hasData = d.volume_m3 != null || d.area_m2 != null;
                  const share =
                    enabled && activeSummary.totalVolumeM3 > 0
                      ? ((d.volume_m3 ?? 0) / activeSummary.totalVolumeM3) * 100
                      : null;

                  return (
                    <li
                      key={d.id}
                      style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
                      className={`animate-in fade-in duration-300 fill-mode-both rounded-md px-1.5 py-1.5 transition-all duration-200 hover:bg-muted/40 ${
                        enabled ? "" : "opacity-40"
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => toggleDetection(d.id)}
                          className="flex-shrink-0 cursor-pointer rounded p-0.5 transition-all duration-150 hover:bg-muted/60 active:scale-90"
                          title={enabled ? "Desactivar zona" : "Activar zona"}
                        >
                          {enabled
                            ? <Eye    className="h-3.5 w-3.5 text-primary" />
                            : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
                        </button>

                        {/* El triángulo solo existe donde hay algo que abrir, y
                            ocupa su ancho igual en las demás para que los
                            nombres queden alineados en columna. */}
                        {fusionada ? (
                          <button
                            onClick={() => toggleExpanded(d.id)}
                            aria-expanded={desplegada}
                            className="flex h-4 w-4 flex-shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                            title={desplegada ? "Ocultar desglose" : "Ver desglose por tipo"}
                          >
                            <Triangulo abierta={desplegada} />
                          </button>
                        ) : (
                          <span className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                        )}

                        <span
                          className="h-2.5 w-2.5 flex-shrink-0 rounded-sm"
                          style={{ background: classColor(d.class) }}
                        />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                          {d.class}
                          {d.manual && <span className="ml-1 text-[0.6875rem] font-normal text-muted-foreground">(manual)</span>}
                        </span>
                        <span className="mono flex-shrink-0 text-xs font-semibold tabular-nums text-foreground">
                          {status === "done" && hasData
                            ? `${volumen(d.volume_m3 ?? 0)} m³`
                            : "-"}
                        </span>
                      </div>

                      {/* pl-[3.4rem] alinea esta línea con el nombre de arriba,
                          saltando el ojo, el triángulo y el cuadro de color. */}
                      <div className="mt-0.5 flex items-baseline gap-2 pl-[3.4rem] text-[0.6875rem] text-muted-foreground">
                        {status === "done" && hasData ? (
                          <>
                            <span className="mono min-w-0 flex-1 truncate tabular-nums">
                              {area(d.area_m2 ?? 0)} m² · {peso(d.weight_kg ?? 0)} kg
                            </span>
                            {/* Que la cifra de una zona fusionada sea el
                                promedio (o el máximo) del grupo y no la suma es
                                lo que impide contar dos veces la misma basura,
                                así que se dice en la fila y no solo en el
                                código. */}
                            {fusionada && (
                              <span className="flex-shrink-0">{d.classes.length} tipos, prom.</span>
                            )}
                            <span className="mono flex-shrink-0 tabular-nums">
                              {share != null ? `${share.toFixed(0)} %` : "-"}
                            </span>
                          </>
                        ) : (
                          <span>
                            {status === "done" ? "Sin datos de volumen" : "Pendiente de análisis"}
                          </span>
                        )}
                      </div>

                      {/* Desglose por tipo, colapsado por omisión: en una zona
                          fusionada sus cifras son casi idénticas entre sí (salen
                          del mismo grupo), así que desplegadas siempre eran
                          ruido que tapaba las zonas que sí se comparan entre
                          sí. Quien necesita auditar el dato lo abre. */}
                      {desplegada && (
                        <ul className="mt-1.5 space-y-1 border-l border-border/60 pl-2 ml-[1.9rem]">
                          {d.breakdown.map((b) => (
                            <li key={b.class} className="text-[0.6875rem]">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className="h-2 w-2 flex-shrink-0 rounded-sm"
                                  style={{ background: classColor(b.class) }}
                                />
                                <span className="min-w-0 flex-1 truncate text-foreground">
                                  {b.class}
                                </span>
                                <span className="mono flex-shrink-0 tabular-nums text-foreground">
                                  {b.volume_m3 != null ? `${volumen(b.volume_m3)} m³` : "-"}
                                </span>
                              </div>
                              <p className="mono pl-3.5 tabular-nums text-muted-foreground">
                                {b.area_m2 != null ? `${area(b.area_m2)} m²` : "-"} ·{" "}
                                {b.weight_kg != null ? `${peso(b.weight_kg)} kg` : "-"}
                              </p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>

              {/* HDU13: detecciones que el área relevante descartó. */}
              {status === "done" && analysisArea && (
                <div className="mt-2 border-t border-border/60 pt-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">
                      Mostrar detecciones descartadas ({descartadas.length})
                    </span>
                    <Switch
                      checked={mostrarDescartadas}
                      onCheckedChange={setMostrarDescartadas}
                      disabled={descartadas.length === 0}
                    />
                  </div>
                  {mostrarDescartadas && descartadas.length > 0 && (
                    <ul className="mt-1.5 space-y-1">
                      {descartadas.map((d) => (
                        <li key={d.id} className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-1.5 py-1 text-xs">
                          <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm opacity-50" style={{ background: classColor(d.class) }} />
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">{d.class}</span>
                          <span className="mono flex-shrink-0 tabular-nums text-muted-foreground">
                            {d.volume_m3 != null ? `${volumen(d.volume_m3)} m³` : "-"}
                          </span>
                          <Button size="sm" variant="secondary" className="h-6 px-2 text-[0.6875rem]" onClick={() => restaurarDetection(d.id)}>
                            Restaurar
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Totales al pie de la columna: son los mismos de "Métricas" en
                  el panel izquierdo, y tenerlos junto al detalle es lo que
                  permite reconciliar uno con otro al activar o desactivar
                  zonas. */}
              {status === "done" && (
                <div className="mt-2 border-t border-border/60 pt-2">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                      Total ({enabledIds.size} de {visibleDetections.length} activas)
                    </span>
                    <span className="mono flex-shrink-0 text-xs font-semibold tabular-nums text-foreground">
                      {volumen(activeSummary.totalVolumeM3)} m³
                    </span>
                  </div>
                  <p className="mono mt-0.5 text-[0.6875rem] tabular-nums text-muted-foreground">
                    {area(activeSummary.totalAreaM2)} m² · {peso(activeSummary.totalWeightKg)} kg
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="py-3 text-center text-xs text-muted-foreground">
              Sin detecciones cargadas.
            </div>
          )}

          {/* HDU7/AC2, posible zona duplicada. Va al pie de esta columna, no en
              el panel de controles de la izquierda: la pregunta que hace es si
              ESTE terreno ya está registrado, y lo que la contesta es lo que
              está justo arriba, las zonas detectadas y su volumen total. En el
              panel izquierdo quedaba lejos de esa evidencia y además empujaba
              hacia abajo los botones de analizar y guardar.

              Antes preguntaba en binario: "¿es la misma zona que X?", con X = el
              candidato de mayor superposición. Cuando dos zonas superaban el
              umbral el trabajador solo veía una, y si la que el sistema eligió
              no era la correcta, "son zonas distintas" tampoco servía: lo que
              quería decir era "es esta OTRA", y esa respuesta no existía. Ahora
              se listan todos los candidatos con su porcentaje de superposición
              y se elige. */}
          {duplicateWarning && (
            <div className="mt-3 animate-in fade-in slide-in-from-bottom-2 duration-300 rounded-lg border border-warning/40 bg-warning/10 p-3">
              <div className="flex items-center gap-2">
                <TriangleAlert className="h-4 w-4 flex-shrink-0 text-warning" />
                <p className="text-sm font-semibold">¿Esta captura ya tiene zona?</p>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                El terreno de esta captura se superpone con{" "}
                {duplicateWarning.candidatos.length === 1
                  ? "una zona ya registrada"
                  : `${duplicateWarning.candidatos.length} zonas ya registradas`}
                . Si es la misma, elígela para que queden como capturas de una
                sola zona.
              </p>

              {/* Sin tope de alto propio ni scroll anidado: el backend ya acota
                  cuántos candidatos manda (MAX_CANDIDATOS = 4) y la columna
                  entera es una sola región desplazable, así que una lista larga
                  alarga esa región en vez de abrir una segunda barra dentro de
                  otra. */}
              <ul className="mt-2 space-y-1.5">
                {duplicateWarning.candidatos.map((c) => (
                  <li key={c.analysisId}>
                    <button
                      type="button"
                      disabled={resolvingDuplicate !== null}
                      onClick={() => handleConfirmDuplicate(c.analysisId)}
                      className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-background/60 p-2 text-left transition-all duration-200 hover:border-primary hover:bg-primary/5 disabled:pointer-events-none disabled:opacity-50"
                    >
                      {resolvingDuplicate === c.analysisId && (
                        <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-foreground">
                          {c.name}
                        </span>
                        <span className="mono block text-[0.625rem] tabular-nums text-muted-foreground">
                          {Math.round(c.ratio * 100)} % de superposición
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              {/* La salida cuando ninguna corresponde. Va como acción
                  secundaria y al final: si el sistema levantó el aviso es
                  porque algo se superpone, así que lo más probable es que
                  alguna de las de arriba sea la correcta. */}
              <Button
                size="sm"
                variant="secondary"
                className="relative mt-2.5 w-full"
                disabled={resolvingDuplicate !== null}
                onClick={handleRejectDuplicate}
              >
                {resolvingDuplicate === "reject" && (
                  <Loader2 className="absolute left-3 h-3.5 w-3.5 animate-spin" />
                )}
                Ninguna, es una zona nueva
              </Button>
            </div>
          )}
          </div>
        </aside>
      </main>

      {/* Navegación entre capturas, al pie y a lo ancho. Se muestra siempre y
          se puede plegar desde su propio encabezado. */}
      <VersionBar
        versions={versions}
        activeTaskId={taskId}
        onSelect={seleccionarVersion}
        // Con una sola captura no se ofrece: eso ya no es borrar una versión,
        // es borrar la zona, y ese camino vive en Vista Principal con su
        // propia confirmación.
        onDelete={versions.length > 1 ? setVersionAEliminar : undefined}
        loading={versionsLoading}
      />

      {/* Confirmación de eliminar una captura desde la barra. */}
      <AlertDialog
        open={versionAEliminar !== null}
        onOpenChange={(open) => { if (!open && !eliminandoVersion) setVersionAEliminar(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar esta captura</AlertDialogTitle>
            <AlertDialogDescription>
              {versionAEliminar && (
                <>
                  Se elimina la captura del{" "}
                  <strong>
                    {versionAEliminar.captureDate
                      ? new Date(versionAEliminar.captureDate).toLocaleDateString("es-CL")
                      : "sin fecha"}
                  </strong>{" "}
                  con {versionAEliminar.analyses.length} análisis, su mapa y sus modelos de
                  elevación. La zona conserva sus otras {versions.length - 1} captura(s).
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={eliminandoVersion}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={eliminandoVersion}
              onClick={(e) => {
                // Sin esto el diálogo se cierra al instante y el borrado sigue
                // corriendo sin que nada lo indique.
                e.preventDefault();
                if (versionAEliminar) eliminarVersion(versionAEliminar);
              }}
            >
              {eliminandoVersion && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* HDU9, informe acotado a esta zona, con vista previa antes de bajarlo. */}
      <ReportPreview
        open={reportOpen}
        onOpenChange={setReportOpen}
        unsavedWarning={
          cambiosSinGuardar > 0
            ? `Tienes ${cambiosSinGuardar} zona(s) activadas o desactivadas sin guardar. Este informe refleja el análisis guardado, no lo que ves en pantalla: guarda los cambios y vuelve a generarlo para incluirlos.`
            : null
        }
        selections={
          zoneId && zoneAnalyses.length > 0
            ? [{
                zone: {
                  id: zoneId,
                  owner: "",
                  name: zoneName ?? currentAnalysisName ?? "Zona",
                  createdAt: new Date().toISOString(),
                  // Zona sintética: esta vista tiene el id y el nombre, que es
                  // todo lo que el informe usa. El resto se rellena con lo que
                  // vale para una zona nacida de un vuelo, que es lo que esta
                  // pantalla siempre está mirando.
                  kind: "basural" as const,
                  active: true,
                  analysisCount: zoneAnalyses.length,
                },
                analyses: zoneAnalyses,
                retiros: retirosZona,
              }]
            : null
        }
      />

      {/* HDU10, el mismo diálogo de Vista Principal. Su "Ver" ahora cambia de
          captura acá mismo en vez de navegar, ya que la vista sabe hacerlo. */}
      <Dialog open={evolutionOpen} onOpenChange={setEvolutionOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Evolución de {zoneName ?? "la zona"}</DialogTitle>
            <DialogDescription>
              Cómo cambió el volumen de esta zona entre sus distintas capturas.
            </DialogDescription>
          </DialogHeader>
          {zoneId && (
            <Suspense
              fallback={
                <div className="flex h-[13rem] items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <ZoneEvolution
                zone={{
                  id: zoneId,
                  owner: "",
                  name: zoneName ?? "Zona",
                  createdAt: new Date().toISOString(),
                  kind: "basural" as const,
                  active: true,
                  analysisCount: zoneAnalyses.length,
                }}
                analyses={zoneAnalyses}
                retiros={retirosZona}
                onOpenAnalysis={(id) => {
                  const record = zoneAnalyses.find((a) => a.id === id);
                  if (record) aplicarAnalisis(record);
                  setEvolutionOpen(false);
                }}
              />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>

      {/* HDU4/AC1, modal que pide el nombre del análisis */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Guardar esta versión</DialogTitle>
            <DialogDescription>
              Es el nombre de esta medición, no el del terreno. Conviene que diga
              cuándo se midió.
            </DialogDescription>
          </DialogHeader>

          <Input
            autoFocus
            placeholder="Ej: Medición 26-05-2026"
            value={analysisName}
            onChange={(e) => setAnalysisName(e.target.value)}
          />

          {/* Decir qué pasa con la zona, porque lo que pasa no es evidente y
              era justo la confusión: una zona nueva nace con el nombre de su
              primera medición, así que sin este aviso el terreno terminaba
              llamándose "Medición 26-05-2026" y nada explicaba por qué. Solo se
              muestra cuando la zona todavía no existe; guardando dentro de una
              zona conocida, su nombre no se toca. */}
          {!zoneId && (
            <p className="text-[0.6875rem] text-muted-foreground">
              Esta es la primera medición del terreno, así que la zona se creará
              con este mismo nombre. Después puedes cambiarlo con el lápiz del
              título.
            </p>
          )}

          <DialogFooter>
            <Button
              disabled={analysisName.trim().length === 0 || savingAnalysis}
              onClick={confirmSaveAnalysis}
            >
              {savingAnalysis && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* HDU4/AC6, confirmación cuando el nombre ya existe */}
      <AlertDialog
        open={duplicateExisting !== null}
        onOpenChange={(open) => { if (!open) setDuplicateExisting(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ya existe una versión con ese nombre</AlertDialogTitle>
            <AlertDialogDescription>
              Puedes elegir otro nombre o sobrescribir la versión existente con esta
              medición.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {duplicateExisting && (
            <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/40 p-3">
              {/* Misma miniatura enmarcada que en la tabla de zonas. */}
              <div className="detect-frame detect-frame-sm h-16 w-16 flex-shrink-0 overflow-hidden rounded">
                <span className="detect-corners" aria-hidden="true" />
                <img
                  src={duplicateExisting.thumbnailUrl ?? duplicateExisting.mapUrl}
                  alt={duplicateExisting.name}
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{duplicateExisting.name}</p>
                <p className="text-[0.625rem] text-muted-foreground mb-1.5">
                  Guardado el {new Date(duplicateExisting.savedAt).toLocaleString("es-CL")}
                </p>
                {duplicateExisting.summary && (
                  <div className="mono flex gap-2 text-[0.625rem] tabular-nums text-muted-foreground">
                    <span>{volumen(duplicateExisting.summary.totalVolumeM3)} m³</span>
                    <span>·</span>
                    <span>{peso(duplicateExisting.summary.totalWeightKg)} kg</span>
                    <span>·</span>
                    <span>{area(duplicateExisting.summary.totalAreaM2)} m²</span>
                  </div>
                )}
              </div>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDuplicateExisting(null)}>
              Elegir otro nombre
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const record = duplicateExisting;
                setDuplicateExisting(null);
                if (record) {
                  cleanupOverwrittenTask(record);
                  performSave(record.name, record.id);
                }
              }}
            >
              Sobrescribir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Los dos renombrados. La zona es el terreno y la versión es una
          medición suya: el sistema los confundía porque al guardar se pedía un
          solo nombre y la zona nacía con el del primer análisis. */}
      <RenameDialog
        open={renombrando === "zona"}
        onOpenChange={(v) => setRenombrando(v ? "zona" : null)}
        titulo="Renombrar la zona"
        descripcion="El nombre del terreno, el que se mantiene entre vuelos. No cambia el nombre de ninguna de sus capturas."
        etiqueta="Nombre de la zona"
        valorInicial={zoneName ?? ""}
        onGuardar={async (nombre) => {
          if (!zoneId) return;
          await renameZone(zoneId, nombre);
          // Optimista y además recarga: el título tiene que cambiar en el acto,
          // y la recarga es la que arrastra lo demás que depende de la zona (la
          // barra de capturas, el informe, la evolución).
          setZoneName(nombre);
          cargarVersionesDeLaZona(zoneId);
          notify.success("Zona renombrada", `Ahora se llama "${nombre}".`);
        }}
      />
      <RenameDialog
        open={renombrando === "version"}
        onOpenChange={(v) => setRenombrando(v ? "version" : null)}
        titulo="Renombrar esta versión"
        descripcion="El nombre de esta medición. La zona a la que pertenece conserva el suyo."
        etiqueta="Nombre de la versión"
        valorInicial={currentAnalysisName ?? ""}
        onGuardar={async (nombre) => {
          if (!currentAnalysisId) return;
          await renameAnalysis(currentAnalysisId, nombre);
          setCurrentAnalysisName(nombre);
          // Se persiste igual que al guardar: sin esto, un F5 recuperaría el
          // nombre viejo desde sessionStorage y parecería que el cambio se
          // perdió, cuando en la base ya está.
          saveCurrentAnalysisName(nombre);
          cargarVersionesDeLaZona(zoneId);
          notify.success("Versión renombrada", `Ahora se llama "${nombre}".`);
        }}
      />
    </div>
  );
}

// ── constantes y subcomponentes ────────────────────────────────────────────────

const statusLabel: Record<AnalysisStatus, string> = {
  idle:    "Esperando inicio del analisis",
  running: "Calculando poligonos y volumenes...",
  done:    "Analisis completado",
  empty:   "Analisis completado sin detecciones",
  error:   "Error en el analisis",
};

// Una sola regla tipográfica en toda la vista, para que dos cifras del mismo
// tipo no se lean con dos letras distintas: Rubik para el título de la página,
// Sora (la del cuerpo) para TODO lo que sea texto, incluidas las etiquetas, y
// .mono reservada exclusivamente para las cifras y sus unidades. Y dos tamaños
// en la tabla, no más: text-xs para los datos y 0.6875rem en versalitas para la
// única fila de encabezado.

function Metric({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg bg-background/60 px-2.5 py-3">
      <div className="mb-2 text-primary/65 [&_svg]:h-4 [&_svg]:w-4">{icon}</div>
      <p className="mb-1 whitespace-nowrap text-[0.625rem] leading-none text-muted-foreground">{label}</p>
      {/* Una sola linea y sin cortarse: con miles de detecciones las cifras
          llegan a "4.582,63 m³", que en text-base no cabe en media columna. */}
      <p className="mono whitespace-nowrap text-[0.8125rem] font-bold tabular-nums text-foreground">{value}</p>
    </div>
  );
}

/** Aviso ámbar del panel de zonas: un solo estilo para todos los avisos de HDU12.
 *  El texto va en el color normal y solo el icono lleva el ámbar fuerte, porque
 *  el ámbar de relleno no tiene contraste como texto sobre el fondo claro. */
function AvisoAmbar({ children, accion }: { children: React.ReactNode; accion?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 px-2.5 py-2 text-[0.69rem] leading-relaxed text-foreground">
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning-strong" />
      <div className="min-w-0 flex-1">
        <span>{children}</span>
        {accion && <div className="mt-2">{accion}</div>}
      </div>
    </div>
  );
}

/** Triángulo de despliegue, mismo gesto que el panel de capas de Figma. */
function Triangulo({ abierta }: { abierta: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-3 w-3 transition-transform duration-200 ${abierta ? "rotate-90" : ""}`}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M9 5l8 7-8 7z" />
    </svg>
  );
}
