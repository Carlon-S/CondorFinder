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
  RotateCcw,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { startVolumeAnalysis, pollVolumeAnalysis, type EnrichedDetection } from "@/lib/analysis";
import {
  saveAnalysis,
  findAnalysisByName,
  loadAnalysisById,
  listAnalyses,
  listZones,
  deleteAnalysis,
  consumePendingOpenId,
  confirmDuplicate,
  rejectDuplicate,
  type SavedAnalysisRecord,
} from "@/lib/analysisStore";
import { buildVersions, type ZoneVersion } from "@/lib/volumeReport";
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
  loadTaskId, saveTaskId, clearTaskId,
} from "@/lib/imageState";
import {
  getTaskStatus,
  deleteResultFile,
  deleteFinalsFile,
  deleteTaskImages,
  deleteTask,
} from "@/lib/unify";

const WEIGHT_LIMIT_KG = 5000;

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
  // Coordenadas reales (CRS proyectado del ortomosaico) de la detección
  // dominante del grupo, HDU5 las reproyecta a WGS84 para el mapa.
  geo_polygon?: number[][] | null;
  area_m2?: number | null;   // máximo del grupo (para totales sin doble conteo)
  volume_m3?: number | null;
  weight_kg?: number | null;
  breakdown: ClassBreakdown[]; // desglose por clase (para visualización)
}

// ── colores ────────────────────────────────────────────────────────────────────

const CLASS_COLORS: Record<string, string> = {
  // Nombres en español (nuevas ejecuciones)
  "Residuo de construcción":   "#ef4444",
  "Metal":                     "#f97316",
  "Plástico":                  "#3b82f6",
  "Residuo orgánico":          "#22c55e",
  "Muebles":                   "#a855f7",
  "Neumáticos":                "#64748b",
  "Tipo de basura indefinido": "#f59e0b",
  "Varios tipos":              "#7c3aed",
  // Nombres en inglés (tareas anteriores al cambio)
  construction_waste: "#ef4444",
  metal:              "#f97316",
  plastic:            "#3b82f6",
  organic_waste:      "#22c55e",
  furniture:          "#a855f7",
  tyres:              "#64748b",
  other:              "#f59e0b",
};

function classColor(cls: string): string {
  if (CLASS_COLORS[cls]) return CLASS_COLORS[cls];
  let hash = 0;
  for (let i = 0; i < cls.length; i++) hash = (hash * 31 + cls.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360},75%,55%)`;
}

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
  iouThreshold = 0.5,
): DisplayDetection[] {
  if (detections.length === 0) return [];

  // Grafo de adyacencia: par (i,j) si IoU >= umbral
  const adj: number[][] = detections.map(() => []);
  for (let i = 0; i < detections.length; i++) {
    for (let j = i + 1; j < detections.length; j++) {
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
      // Mismo dets[0] que `polygon`, son dos representaciones de la MISMA
      // geometría (píxel vs. real), tienen que salir de la misma detección.
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
  const [dragging, setDragging] = useState(false);
  const dragStart    = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const [displayDetections, setDisplayDetections] = useState<DisplayDetection[]>([]);
  const [detectionsLoading, setDetectionsLoading] = useState(false);
  const [enabledIds, setEnabledIds]               = useState<Set<number>>(new Set());
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
  const [zoneId, setZoneId] = useState<string | null>(null);
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
  const [duplicateWarning, setDuplicateWarning] = useState<{ older: SavedAnalysisRecord } | null>(null);
  // "confirm"/"reject" (no solo boolean) para saber cuál de los dos botones
  // mostrar cargando -- antes ambos compartían un solo flag y el ícono de
  // carga solo se le agregaba al texto de "Es la misma zona", lo que además
  // le cambiaba el ancho al botón y lo sacaba del borde del banner.
  const [resolvingDuplicate, setResolvingDuplicate] = useState<"confirm" | "reject" | null>(null);

  // Se llama tanto justo después de guardar (performSave) como al reabrir
  // un análisis ya guardado (AC4-de-HDU4, en el efecto de montaje), mismo
  // chequeo en los dos casos: "al acceder al mapa del nuevo análisis" (AC2)
  // cubre ambos accesos, no solo el instante del guardado.
  const checkDuplicateWarning = async (record: SavedAnalysisRecord) => {
    if (record.duplicateStatus !== "pending" || !record.possibleDuplicateOf) {
      setDuplicateWarning(null);
      return;
    }
    const older = await loadAnalysisById(record.possibleDuplicateOf);
    if (older) setDuplicateWarning({ older });
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

  const handleConfirmDuplicate = async () => {
    if (!currentAnalysisId) return;
    const olderName = duplicateWarning?.older.name;
    setResolvingDuplicate("confirm");
    const updated = await confirmDuplicate(currentAnalysisId);
    setResolvingDuplicate(null);
    if (!updated) {
      notify.error("No se pudo vincular el análisis", "Intenta nuevamente.");
      return;
    }
    setDuplicateWarning(null);
    // La zona no cambia al confirmar, pero el análisis anterior pasó a
    // histórico, así que la barra tiene que releerse para marcarlo.
    adoptarZonaDe(updated);
    notify.success(
      "Análisis vinculado",
      olderName ? `"${olderName}" quedó como historial de esta zona.` : "Quedó vinculado como la misma zona.",
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
        detections: displayDetections.map(d => ({ ...d, enabled: enabledIds.has(d.id) })),
        summary: activeSummary,
        sourceTaskId: taskId ?? undefined,
        crs,
        orthoCenter,
        orthoBounds,
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

    setCurrentAnalysisId(result.record.id);
    setCurrentAnalysisName(result.record.name);
    saveCurrentAnalysisId(result.record.id);
    saveCurrentAnalysisName(result.record.name);
    setSaveDialogOpen(false);
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

  const allEnabled = displayDetections.length > 0 && enabledIds.size === displayDetections.length;

  const toggleAll = () => {
    setEnabledIds(
      allEnabled ? new Set() : new Set(displayDetections.map(d => d.id)),
    );
  };

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
    () => [...displayDetections].sort((a, b) => (b.volume_m3 ?? 0) - (a.volume_m3 ?? 0)),
    [displayDetections],
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

  /** Trae las demás capturas de la zona para poder navegar entre ellas. */
  const cargarVersionesDeLaZona = (zona: string | null) => {
    if (!zona) {
      setVersions([]);
      setVersionsLoading(false);
      setZoneNameLoading(false);
      return;
    }
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
   * vuelo, y dejar algunos sueltos deja la versión a medias. Los archivos se
   * van con ella porque ya no queda nadie que los use.
   */
  const eliminarVersion = async (version: ZoneVersion) => {
    setEliminandoVersion(true);
    try {
      for (const analisis of version.analyses) {
        await deleteAnalysis(analisis.id);
      }
      borrarArchivosDeVersion(version.mapUrl, version.sourceTaskId);

      const restantes = versions.filter((v) => v.sourceTaskId !== version.sourceTaskId);
      setVersionAEliminar(null);

      if (restantes.length === 0) {
        // Era la única captura: la zona entera se fue con ella (el backend
        // borra la zona al quedarse sin análisis). No hay nada que mostrar.
        notify.success("Captura eliminada", "La zona ya no tiene capturas guardadas.");
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
          const merged = mergeOverlapping(data.detections ?? [])
            .filter(d => !(d.weight_kg != null && d.weight_kg > WEIGHT_LIMIT_KG));
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

    setStatus("running");
    setProgress(10);
    setAnalysisMessage(null);

    try {
      const startResult = await startVolumeAnalysis(taskId);
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
        setAnalysisMessage(startResult.message ?? null);
        setStatus("error");
        return;
      }

      const response = await pollVolumeAnalysis(taskId, detectionJsonUrl, setProgress);
      if (response.status === "success") {
        const merged = mergeOverlapping(response.detections)
          .filter(d => !(d.weight_kg != null && d.weight_kg > WEIGHT_LIMIT_KG));
        setDisplayDetections(merged);
        setEnabledIds(new Set(merged.map(d => d.id)));
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
  };

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
                <h1
                  // break-words + line-clamp: un nombre largo antes desbordaba
                  // la columna o la estiraba. Ahora corta por palabras, se
                  // limita a dos líneas y el nombre completo queda en el
                  // title. El cuerpo baja un escalón de tamaño pasados los 22
                  // caracteres, que es lo que entra cómodo en una línea al
                  // ancho de este panel.
                  title={zoneName ?? currentAnalysisName ?? undefined}
                  className={`font-rubik font-semibold tracking-normal text-foreground line-clamp-2 break-words hyphens-auto ${
                    (zoneName ?? currentAnalysisName ?? "").length > 22
                      ? "text-xl md:text-2xl"
                      : "text-3xl md:text-4xl"
                  }`}
                >
                  {zoneName ?? currentAnalysisName ?? "Análisis"}
                </h1>
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

            {/* HDU7/AC2, posible duplicado con un análisis anterior */}
            {duplicateWarning && (
              <div className="animate-in fade-in slide-in-from-left-2 duration-300 rounded-lg border border-warning/40 bg-warning/10 p-4">
                <TriangleAlert className="mb-2 h-5 w-5 text-warning" />
                <p className="text-sm font-semibold">Posible zona duplicada</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Este análisis se superpone con "{duplicateWarning.older.name}" (guardado el{" "}
                  {new Date(duplicateWarning.older.savedAt).toLocaleDateString("es-CL")}). ¿Es la misma zona?
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md bg-background/40 p-2">
                    <p className="text-muted-foreground">Este análisis</p>
                    <p className="mono font-semibold tabular-nums">{activeSummary.totalVolumeM3} m³</p>
                  </div>
                  <div className="rounded-md bg-background/40 p-2">
                    <p className="text-muted-foreground">Análisis anterior</p>
                    <p className="mono font-semibold tabular-nums">
                      {duplicateWarning.older.summary
                        ? `${duplicateWarning.older.summary.totalVolumeM3} m³`
                        : ", "}
                    </p>
                  </div>
                </div>
                {/* min-w-0 + ancho de ícono reservado siempre (visible solo
                    mientras carga la acción de ESE botón puntual): antes el
                    spinner solo se agregaba al texto de "Es la misma zona",
                    lo que le cambiaba el ancho al botón en pleno click y lo
                    sacaba del borde del banner. */}
                {/* Uno debajo del otro, no lado a lado. Este banner vive en el
                    panel lateral, que mide entre 240 y 360px; dos botones al
                    50% no alcanzaban para "Son zonas distintas" ni "Es la misma
                    zona", y los textos terminaban montados uno sobre otro.
                    Apilados, entran completos a cualquier ancho. */}
                <div className="mt-3 flex flex-col gap-2">
                  {/* La acción principal va arriba: es la respuesta esperada
                      cuando el sistema acertó en la superposición. */}
                  {/* El spinner va absolute (fuera del flujo) en vez de un
                      span reservado en línea con el texto -- ese span le
                      agregaba margen solo a la izquierda, corriendo el
                      centro real del texto hacia la derecha. Así el texto
                      queda perfectamente centrado siempre, y el spinner se
                      superpone a su izquierda sin mover nada. */}
                  <Button
                    size="sm"
                    className="relative w-full"
                    disabled={resolvingDuplicate !== null}
                    onClick={handleConfirmDuplicate}
                  >
                    {resolvingDuplicate === "confirm" && (
                      <Loader2 className="absolute left-3 h-3.5 w-3.5 animate-spin" />
                    )}
                    Es la misma zona
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="relative w-full"
                    disabled={resolvingDuplicate !== null}
                    onClick={handleRejectDuplicate}
                  >
                    {resolvingDuplicate === "reject" && (
                      <Loader2 className="absolute left-3 h-3.5 w-3.5 animate-spin" />
                    )}
                    Son zonas distintas
                  </Button>
                </div>
              </div>
            )}

            {/* ── Bloque "Control": lo que el usuario opera ── */}
            <div className="rounded-lg bg-background/40 p-3 animate-in fade-in slide-in-from-left-2 duration-500 fill-mode-both space-y-4">
              <Button
                onClick={runAnalysis}
                disabled={
                  status === "running" ||
                  !usingGeneratedMap ||
                  status === "empty" ||
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

              {/* Este vuelo no se puede volver a medir: o es una versión ya
                  reemplazada, o sus modelos de elevación se liberaron. Se
                  explica el motivo en vez de dejar un botón apagado sin razón
                  aparente. */}
              {(!canAnalyze || readOnly) && cannotAnalyzeReason && (
                <p className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[0.69rem] leading-relaxed text-muted-foreground">
                  {cannotAnalyzeReason}
                </p>
              )}

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
                {currentAnalysisId ? "Guardar cambios" : "Guardar análisis"}
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
                      value={status === "done" ? `${activeSummary.totalVolumeM3} m³` : ", "}
                      icon={<Boxes className="h-4 w-4" />}
                    />
                    <Metric
                      label="Peso total"
                      value={status === "done" ? `${activeSummary.totalWeightKg} kg` : ", "}
                      icon={<Scale className="h-4 w-4" />}
                    />
                    <Metric
                      label="Área total"
                      value={status === "done" ? `${activeSummary.totalAreaM2} m²` : ", "}
                      icon={<Crosshair className="h-4 w-4" />}
                    />
                    <Metric
                      label="Zonas activas"
                      value={`${enabledIds.size} / ${displayDetections.length}`}
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

              <Button
                size="sm"
                variant="secondary"
                onClick={resetView}
                className="absolute right-4 top-4 z-20 h-8 px-3 text-xs"
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reiniciar vista
              </Button>

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
                  dragging ? "cursor-grabbing" : "cursor-grab"
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
                  <div className="absolute inset-4 flex items-center justify-center">
                    <div className="relative w-full h-full">
                      <img
                        src={mapUrl!}
                        alt="Mapa unificado para analisis de volumen"
                        className="h-full w-full object-contain pointer-events-none"
                        draggable={false}
                        onDragStart={e => e.preventDefault()}
                        onLoad={e => {
                          const img = e.currentTarget;
                          setImgNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
                        }}
                      />
                      {imgNaturalSize && displayDetections.length > 0 && (() => {
                        const enabledDets = displayDetections.filter(d => enabledIds.has(d.id));
                        const vols = enabledDets.map(d => d.volume_m3 ?? 0).filter(v => v > 0);
                        const minVol = vols.length > 0 ? Math.min(...vols) : 0;
                        const maxVol = vols.length > 0 ? Math.max(...vols) : 0;
                        const hasVolData = status === "done" && maxVol > 0;
                        return (
                          <svg
                            viewBox={`0 0 ${imgNaturalSize.w} ${imgNaturalSize.h}`}
                            className="absolute inset-0 w-full h-full pointer-events-none"
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
                              return (
                                <g key={d.id}>
                                  <rect
                                    x={d.bbox.minx} y={d.bbox.miny}
                                    width={bw} height={bh}
                                    fill={fillColor}
                                    fillOpacity={0.35}
                                    stroke={strokeColor}
                                    strokeWidth={1.5}
                                    strokeLinejoin="round"
                                  />
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
        <aside className="col-span-2 flex max-h-[30vh] min-h-0 flex-col border-t border-border/40 bg-card/50 px-4 py-3 xl:col-span-1 xl:max-h-none xl:border-l xl:border-t-0">
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
                className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden pr-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
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
                        </span>
                        <span className="mono flex-shrink-0 text-xs font-semibold tabular-nums text-foreground">
                          {status === "done" && hasData
                            ? `${(d.volume_m3 ?? 0).toFixed(2)} m³`
                            : "-"}
                        </span>
                      </div>

                      {/* pl-[3.4rem] alinea esta línea con el nombre de arriba,
                          saltando el ojo, el triángulo y el cuadro de color. */}
                      <div className="mt-0.5 flex items-baseline gap-2 pl-[3.4rem] text-[0.6875rem] text-muted-foreground">
                        {status === "done" && hasData ? (
                          <>
                            <span className="mono min-w-0 flex-1 truncate tabular-nums">
                              {(d.area_m2 ?? 0).toFixed(2)} m² · {Math.round(d.weight_kg ?? 0)} kg
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
                                  {b.volume_m3 != null ? `${b.volume_m3.toFixed(2)} m³` : "-"}
                                </span>
                              </div>
                              <p className="mono pl-3.5 tabular-nums text-muted-foreground">
                                {b.area_m2 != null ? `${b.area_m2.toFixed(2)} m²` : "-"} ·{" "}
                                {b.weight_kg != null ? `${Math.round(b.weight_kg)} kg` : "-"}
                              </p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>

              {/* Totales al pie de la columna: son los mismos de "Métricas" en
                  el panel izquierdo, y tenerlos junto al detalle es lo que
                  permite reconciliar uno con otro al activar o desactivar
                  zonas. */}
              {status === "done" && (
                <div className="mt-2 flex-shrink-0 border-t border-border/60 pt-2">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                      Total ({enabledIds.size} de {displayDetections.length} activas)
                    </span>
                    <span className="mono flex-shrink-0 text-xs font-semibold tabular-nums text-foreground">
                      {activeSummary.totalVolumeM3} m³
                    </span>
                  </div>
                  <p className="mono mt-0.5 text-[0.6875rem] tabular-nums text-muted-foreground">
                    {activeSummary.totalAreaM2} m² · {activeSummary.totalWeightKg} kg
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="py-3 text-center text-xs text-muted-foreground">
              Sin detecciones cargadas.
            </div>
          )}
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
                },
                analyses: zoneAnalyses,
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
                }}
                analyses={zoneAnalyses}
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
            <DialogTitle>Guardar análisis</DialogTitle>
            <DialogDescription>
              Ingresa un nombre para identificar este análisis en el listado de
              análisis disponibles.
            </DialogDescription>
          </DialogHeader>

          <Input
            autoFocus
            placeholder="Ej: Basural Camino Melipilla - agosto"
            value={analysisName}
            onChange={(e) => setAnalysisName(e.target.value)}
          />

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
            <AlertDialogTitle>Ya existe un análisis con ese nombre</AlertDialogTitle>
            <AlertDialogDescription>
              Puedes elegir otro nombre o sobrescribir el análisis existente con esta
              nueva versión.
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
                    <span>{duplicateExisting.summary.totalVolumeM3} m³</span>
                    <span>·</span>
                    <span>{duplicateExisting.summary.totalWeightKg} kg</span>
                    <span>·</span>
                    <span>{duplicateExisting.summary.totalAreaM2} m²</span>
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
    <div className="rounded-lg bg-background/60 px-3 py-3">
      <div className="mb-2.5 text-primary/65 [&_svg]:h-4 [&_svg]:w-4">{icon}</div>
      <p className="text-[0.625rem] text-muted-foreground leading-none mb-1">{label}</p>
      <p className="mono text-base font-bold tabular-nums text-foreground">{value}</p>
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
