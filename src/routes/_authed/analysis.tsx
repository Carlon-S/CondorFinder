import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
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
  consumePendingOpenId,
  confirmDuplicate,
  rejectDuplicate,
  type SavedAnalysisRecord,
} from "@/lib/analysisStore";
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
  // dominante del grupo — HDU5 las reproyecta a WGS84 para el mapa.
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
      // Mismo dets[0] que `polygon` — son dos representaciones de la MISMA
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
  const [mapUrl, setMapUrl] = useState<string | null>(() => loadMapUrl());
  // Miniatura liviana asociada a mapUrl (ver mapState.ts) — puede no existir
  // (análisis reabiertos de antes de este campo), se guarda igual con la
  // misma disciplina "capturado una vez al montar" que mapUrl.
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(() => loadThumbnailUrl());
  const usingGeneratedMap = mapUrl !== null;

  // taskId/detectionJsonUrl se capturan UNA VEZ al montar, igual que mapUrl
  // arriba — sessionStorage es solo el mecanismo de traspaso entre rutas
  // (mismo patrón documentado en mapState.ts/imageState.ts), no una fuente
  // viva para releer en cada click. runAnalysis() volvía a llamar
  // loadTaskId()/loadDetectionJsonUrl() cada vez que se presionaba
  // "Analizar volumen", y esas claves podían quedar limpias por el efecto de
  // cleanup de más abajo (se dispara en cualquier desmontaje, incluido algún
  // remount temprano que TanStack Start puede hacer en dev) — mapUrl nunca
  // sufría esto porque ya vivía en estado de React, no releído de
  // sessionStorage después del montaje. Mismo tratamiento acá.
  const [taskId, setTaskId] = useState<string | null>(() => loadTaskId());
  const [detectionJsonUrl, setDetectionJsonUrl] = useState<string | null>(() => loadDetectionJsonUrl());
  // Se llega aquí directo desde el sidebar ahora (antes solo vía Vista
  // Principal, que siempre dejaba un mapUrl seteado). Sin esta bandera, un
  // acceso directo sin contexto mostraría el layout roto en vez de un
  // estado vacío — se pone en true recién cuando el efecto de montaje ya
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
  // CRS proyectado del ortomosaico (HDU5) — llega junto con las detecciones,
  // se guarda para poder reproyectar geo_polygon a WGS84 más adelante (en
  // /rutas). Análisis abiertos por AC4 lo traen de record.crs.
  const [crs, setCrs] = useState<string | undefined>(undefined);
  // Centro geográfico real del ortomosaico (mismo CRS que `crs`) — a
  // diferencia del centroide de las detecciones, es el mismo sin importar
  // qué encuentre YOLO en cada corrida. rutas.tsx lo prefiere por sobre el
  // centroide de detecciones para ubicar la zona de forma consistente.
  const [orthoCenter, setOrthoCenter] = useState<[number, number] | null>(null);
  // Huella geográfica COMPLETA del ortomosaico — HDU7 la usa (no las
  // detecciones puntuales) para detectar duplicados entre análisis
  // guardados, más robusto ante corridas de YOLO que detectan la basura en
  // una posición levemente distinta. Ver backendModel/analyses.py.
  const [orthoBounds, setOrthoBounds] = useState<[number, number, number, number] | null>(null);

  // ── HDU4 / AC1 — guardar análisis: pide nombre ─────────────────────────────
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [analysisName, setAnalysisName]     = useState("");

  // AC6 — nombre duplicado
  const [duplicateExisting, setDuplicateExisting] = useState<SavedAnalysisRecord | null>(null);

  // Análisis ya guardado que se está viendo en esta sesión (llegó por AC4, o
  // ya se guardó una vez en este mismo tab). Mientras esté marcado, volver a
  // guardar sobrescribe directo, sin pedir nombre ni chequear duplicados —
  // no es un análisis nuevo, es el mismo que ya existe.
  const [currentAnalysisId, setCurrentAnalysisId]     = useState<string | null>(null);
  const [currentAnalysisName, setCurrentAnalysisName] = useState<string | null>(null);
  // Guardar/buscar duplicado ahora son llamadas HTTP (Mongo), no localStorage
  // instantáneo — sin este indicador, un click en "Guardar" durante una
  // conexión lenta no daba ninguna señal de que algo estaba pasando.
  const [savingAnalysis, setSavingAnalysis] = useState(false);

  // HDU7/AC2 — posible duplicado con un análisis anterior (>50% de área
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
  // un análisis ya guardado (AC4-de-HDU4, en el efecto de montaje) — mismo
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
    notify.success("Marcado como zona distinta", "Ambos análisis se mantienen por separado.");
  };

  // Guardado real, compartido entre el camino feliz, la sobrescritura rápida
  // y la confirmación de duplicado. AC5 — si falla, notifica por toast y no
  // cierra el modal para poder reintentar.
  const performSave = async (name: string, overwriteId?: string) => {
    if (!mapUrl) return;

    setSavingAnalysis(true);
    const result = await saveAnalysis(
      name,
      {
        mapUrl,
        thumbnailUrl,
        detections: displayDetections,
        summary: activeSummary,
        sourceTaskId: taskId ?? undefined,
        crs,
        orthoCenter,
        orthoBounds,
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
    setSaveDialogOpen(false);
    notify.success(
      overwriteId ? "Análisis actualizado" : "Análisis guardado",
      overwriteId
        ? "Los cambios se guardaron sobre el análisis existente."
        : "Puedes encontrarlo en el listado de zonas de la Vista Principal.",
    );

    // HDU7/AC1→AC2 — solo un guardado NUEVO (create_analysis en el backend)
    // puede traer un possibleDuplicateOf recién calculado; una sobrescritura
    // nunca lo dispara (ver analyses.py), así que esto es un no-op ahí.
    checkDuplicateWarning(result.record);
  };

  // AC6 (sobrescribir): la sobrescritura REEMPLAZA sourceTaskId/mapUrl en el
  // documento — si el análisis existente venía de una generación DISTINTA
  // (otro mapa/tarea) a la que se está guardando ahora, esa tarea anterior
  // y sus archivos quedan sin ninguna referencia una vez sobrescrito. Sin
  // este cleanup quedaban huérfanos para siempre en Mongo (`tasks`) y en
  // disco (result/finals/task-images) — mismo tipo de fuga que ya se
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

  // AC2 — guarda el análisis con el nombre ingresado en el listado disponible.
  // AC6 — si el nombre ya existe, pide confirmar sobrescribir en vez de guardar directo.
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

  // ── carga inicial de detecciones al montar ─────────────────────────────────
  //
  // Un solo efecto para las dos fuentes posibles, en vez de dos separados:
  // antes, el efecto de HDU4/AC4 (abrir un análisis guardado, síncrono) y el
  // de "detectionJsonUrl" (fetch asíncrono a lo que haya quedado en
  // sessionStorage de CUALQUIER sesión anterior) corrían en paralelo — el
  // fetch async terminaba después y pisaba los datos correctos del análisis
  // recién abierto con los de la última generación/tarea, sin importar cuál
  // hubieras clickeado. Al estar en el mismo efecto, si hay un análisis
  // guardado pendiente de abrir se usa ESE y no se llega a disparar el fetch.
  //
  // hasLoadedRef evita que el CUERPO del efecto corra más de una vez para el
  // mismo montaje del componente (ej. doble-render por hot-reload en dev, o
  // cualquier remount que React dispare sin que la página realmente haya
  // cambiado). consumePendingOpenId() es de un solo uso — borra la clave de
  // sessionStorage al leerla — así que una segunda ejecución del efecto no
  // la encuentra, cae al camino de "fetch en vivo", y pisa los datos
  // correctos recién cargados con lo que haya quedado viejo en
  // detectionJsonUrl. Se vio exactamente esto: un flash correcto de los
  // polígonos del análisis guardado, seguido de un cambio casi instantáneo
  // a los de otra zona.
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    // loadAnalysisById ahora es una llamada HTTP (Mongo) — el resto de este
    // efecto sigue dependiendo de que se resuelva ANTES de decidir si cae al
    // camino normal (mismo motivo documentado arriba: correr ambos caminos
    // en paralelo pisaba los datos correctos con los de la última tarea
    // vista). El await adentro de este IIFE preserva ese orden.
    (async () => {
      // HDU4 / AC4 — abrir un análisis guardado desde el listado (index.tsx)
      const pendingId = consumePendingOpenId();
      if (pendingId) {
        const record = await loadAnalysisById(pendingId);
        if (record) {
          setMapUrl(record.mapUrl);
          saveMapUrl(record.mapUrl);
          setThumbnailUrl(record.thumbnailUrl ?? null);
          saveThumbnailUrl(record.thumbnailUrl ?? null);

          const detections = (record.detections as DisplayDetection[]) ?? [];
          setDisplayDetections(detections);
          setEnabledIds(new Set(detections.map(d => d.id)));
          setCrs(record.crs);
          setOrthoCenter(record.orthoCenter ?? null);
          setOrthoBounds(record.orthoBounds ?? null);
          setStatus("done");

          setCurrentAnalysisId(record.id);
          setCurrentAnalysisName(record.name);

          // HDU7/AC2 — "al acceder al mapa del nuevo análisis" cubre tanto
          // el guardado recién hecho (performSave) como reabrirlo después
          // desde Vista Principal, que es justo este camino.
          checkDuplicateWarning(record);

          // Sin esto, "Analizar volumen" sobre una zona ya guardada fallaba con
          // "No se encontró la tarea": loadTaskId() seguía apuntando a lo que
          // hubiera quedado de la última tarea en sessionStorage (o nada), no
          // a la tarea real de ESTE análisis guardado.
          //
          // Eso resolvía taskId, pero "Analizar volumen" TAMBIÉN necesita
          // detectionJsonUrl — y un SavedAnalysisRecord no guarda esa URL (solo
          // las detecciones ya resueltas). Sin tocarla, quedaba lo que hubiera
          // en sessionStorage de la ÚLTIMA zona vista/generada, exactamente el
          // mismo patrón de dato viejo que ya arreglamos en reviewPending() —
          // por eso "Analizar volumen" fallaba con "No se encontró la tarea"
          // (o, peor, reanalizaba la zona equivocada). Se limpia primero y,
          // si el backend todavía tiene la tarea en memoria (no se reinició
          // uvicorn desde entonces), se repuebla con su propia URL.
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
            });
          } else {
            clearTaskId();
            setTaskId(null);
          }
          setInitChecked(true);
          return;
        }
      }

      // Recién acá se sabe con certeza si había o no un análisis guardado
      // para mostrar (pendingId ausente, o presente pero sin record) — antes
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
  // Link, etc.) se limpia el hand-off — si no, una vuelta directa a
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

      const response = await pollVolumeAnalysis(taskId, detectionJsonUrl, setProgress);
      if (response.status === "success") {
        const merged = mergeOverlapping(response.detections)
          .filter(d => !(d.weight_kg != null && d.weight_kg > WEIGHT_LIMIT_KG));
        setDisplayDetections(merged);
        setEnabledIds(new Set(merged.map(d => d.id)));
        setCrs(response.crs || undefined);
        setOrthoCenter(response.orthoCenter ?? null);
        setOrthoBounds(response.orthoBounds ?? null);
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
  // de arriba) — antes de esto, la navegación a /analysis ya es instantánea,
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
      <main className="grid flex-1 grid-cols-[360px_1fr] min-h-0">

        {/* ── panel lateral ── */}
        <aside
          id="dashboard"
          className="border-r border-border/35 p-5 overflow-y-auto"
        >
          <div className="flex flex-col gap-4">

            {/* título — mismo tratamiento que "Zonas monitoreadas" / "Carga
                de imágenes": sin botón de volver (la navegación ya vive en
                el sidebar persistente). */}
            <div>
              <h1 className="font-rubik text-3xl font-semibold tracking-normal text-foreground md:text-4xl">
                Análisis
              </h1>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Activa o desactiva zonas antes de ejecutar el análisis. Los totales
                reflejan únicamente las zonas activas.
              </p>
            </div>

            {/* HDU7/AC2 — posible duplicado con un análisis anterior */}
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
                    <p className="font-semibold">{activeSummary.totalVolumeM3} m³</p>
                  </div>
                  <div className="rounded-md bg-background/40 p-2">
                    <p className="text-muted-foreground">Análisis anterior</p>
                    <p className="font-semibold">
                      {duplicateWarning.older.summary
                        ? `${duplicateWarning.older.summary.totalVolumeM3} m³`
                        : "—"}
                    </p>
                  </div>
                </div>
                {/* min-w-0 + ancho de ícono reservado siempre (visible solo
                    mientras carga la acción de ESE botón puntual): antes el
                    spinner solo se agregaba al texto de "Es la misma zona",
                    lo que le cambiaba el ancho al botón en pleno click y lo
                    sacaba del borde del banner. */}
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="min-w-0 flex-1"
                    disabled={resolvingDuplicate !== null}
                    onClick={handleRejectDuplicate}
                  >
                    <span className="mr-2 inline-flex w-3.5 flex-shrink-0 justify-center">
                      {resolvingDuplicate === "reject" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    </span>
                    Son zonas distintas
                  </Button>
                  <Button
                    size="sm"
                    className="min-w-0 flex-1"
                    disabled={resolvingDuplicate !== null}
                    onClick={handleConfirmDuplicate}
                  >
                    <span className="mr-2 inline-flex w-3.5 flex-shrink-0 justify-center">
                      {resolvingDuplicate === "confirm" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    </span>
                    Es la misma zona
                  </Button>
                </div>
              </div>
            )}

            {/* ── Bloque "Control": lo que el usuario opera ── */}
            <div className="rounded-lg bg-background/40 p-3 animate-in fade-in slide-in-from-left-2 duration-500 fill-mode-both space-y-4">
              <Button
                onClick={runAnalysis}
                disabled={status === "running" || !usingGeneratedMap || status === "empty"}
                className="w-full"
              >
                {status === "running" ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analizando...</>
                ) : (
                  <><Search className="mr-2 h-4 w-4" /> Analizar volumen</>
                )}
              </Button>

              {/* HDU4/AC1 — guardar análisis */}
              <Button
                onClick={handleSaveClick}
                disabled={status !== "done" || savingAnalysis}
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

              {/* estado */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-2.5">Estado del análisis</p>
                <div className="flex items-center gap-2">
                  {status === "running"  ? <Loader2      className="h-4 w-4 animate-spin text-primary" />
                  : status === "done"    ? <CheckCircle2 className="h-4 w-4 text-success" />
                  : status === "empty"   ? <TriangleAlert className="h-4 w-4 text-warning" />
                  :                        <Clock         className="h-4 w-4 text-muted-foreground" />}
                  <p className="text-xs font-medium">{statusLabel[status]}</p>
                </div>
                <Progress value={progress} className="mt-2.5 h-1" />
                <p className="mt-1 text-[10px] text-muted-foreground">{progress}% completado</p>
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
                      : "El servicio de análisis no retornó resultados válidos para mostrar."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="rounded-lg bg-background/40 p-3 animate-in fade-in slide-in-from-left-2 duration-500 delay-100 fill-mode-both space-y-4">
                {/* métricas */}
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-2.5">Métricas</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Metric
                      label="Volumen total"
                      value={status === "done" ? `${activeSummary.totalVolumeM3} m³` : "—"}
                      icon={<Boxes className="h-4 w-4" />}
                    />
                    <Metric
                      label="Peso total"
                      value={status === "done" ? `${activeSummary.totalWeightKg} kg` : "—"}
                      icon={<Scale className="h-4 w-4" />}
                    />
                    <Metric
                      label="Área total"
                      value={status === "done" ? `${activeSummary.totalAreaM2} m²` : "—"}
                      icon={<Crosshair className="h-4 w-4" />}
                    />
                    <Metric
                      label="Zonas activas"
                      value={`${enabledIds.size} / ${displayDetections.length}`}
                      icon={<MapIcon className="h-4 w-4" />}
                    />
                  </div>
                </div>

                {/* lista de zonas */}
                <div>
                  <div className="flex items-center justify-between mb-2.5">
                    <p className="text-xs font-semibold text-muted-foreground">
                      Zonas detectadas
                    </p>
                    {displayDetections.length > 0 && (
                      <button
                        onClick={toggleAll}
                        className="text-[10px] text-primary hover:underline"
                      >
                        {allEnabled ? "Desactivar todas" : "Activar todas"}
                      </button>
                    )}
                  </div>

                  {detectionsLoading ? (
                    <div className="space-y-1.5">
                      {[0, 1, 2].map((i) => (
                        <Skeleton key={i} className="h-14 w-full rounded-md" />
                      ))}
                    </div>
                  ) : displayDetections.length > 0 ? (
                    <ul className="space-y-1.5 max-h-[340px] overflow-y-auto pr-0.5">
                      {displayDetections.map(d => {
                        const enabled = enabledIds.has(d.id);
                        const color   = classColor(d.class);
                        const hasData = d.volume_m3 != null || d.area_m2 != null;
                        return (
                          <li
                            key={d.id}
                            className={`animate-in fade-in duration-200 fill-mode-both rounded-md border transition-opacity duration-150 ${
                              enabled
                                ? "border-border/60 bg-background/60"
                                : "border-border/20 bg-background/20 opacity-40"
                            }`}
                          >
                            <div className="flex items-start gap-2 p-2">
                              <button
                                onClick={() => toggleDetection(d.id)}
                                className="mt-0.5 flex-shrink-0 rounded p-0.5 hover:bg-muted/40 transition-colors"
                                title={enabled ? "Desactivar zona" : "Activar zona"}
                              >
                                {enabled
                                  ? <Eye    className="h-3.5 w-3.5 text-primary" />
                                  : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
                              </button>
                              <span
                                className="mt-1 h-2.5 w-2.5 rounded-sm flex-shrink-0"
                                style={{ background: color }}
                              />
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium leading-tight">{d.class}</p>
                                {status === "done" && hasData ? (
                                  d.classes.length > 1 ? (
                                    // Zona fusionada — resumen promedio + desglose por tipo
                                    <div className="mt-1.5 space-y-1.5">
                                      <div className="rounded border border-primary/30 bg-primary/10 px-1.5 py-1">
                                        <p className="mono text-[8px] font-semibold uppercase tracking-wider text-primary mb-1">
                                          Promedio
                                        </p>
                                        <div className="grid grid-cols-3 gap-1">
                                          <StatBadge label="Vol"  value={`${(d.volume_m3 ?? 0).toFixed(2)} m³`} />
                                          <StatBadge label="Área" value={`${(d.area_m2  ?? 0).toFixed(2)} m²`} />
                                          <StatBadge label="Peso" value={`${Math.round(d.weight_kg ?? 0)} kg`} />
                                        </div>
                                      </div>
                                      {d.breakdown.map(b => (
                                        <div key={b.class} className="rounded bg-background/80 px-1.5 py-1">
                                          <div className="flex items-center gap-1 mb-1">
                                            <span
                                              className="h-2 w-2 rounded-sm flex-shrink-0"
                                              style={{ background: classColor(b.class) }}
                                            />
                                            <p className="text-[9px] font-semibold text-muted-foreground truncate">
                                              {b.class}
                                            </p>
                                          </div>
                                          <div className="grid grid-cols-3 gap-1">
                                            <StatBadge label="Vol"  value={b.volume_m3 != null ? `${b.volume_m3.toFixed(2)} m³` : "—"} />
                                            <StatBadge label="Área" value={b.area_m2  != null ? `${b.area_m2.toFixed(2)} m²`  : "—"} />
                                            <StatBadge label="Peso" value={b.weight_kg != null ? `${Math.round(b.weight_kg)} kg` : "—"} />
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <div className="mt-1.5 grid grid-cols-3 gap-1">
                                      <StatBadge label="Vol"  value={`${(d.volume_m3 ?? 0).toFixed(2)} m³`} />
                                      <StatBadge label="Área" value={`${(d.area_m2  ?? 0).toFixed(2)} m²`} />
                                      <StatBadge label="Peso" value={`${Math.round(d.weight_kg ?? 0)} kg`} />
                                    </div>
                                  )
                                ) : (
                                  <p className="mono text-[10px] text-muted-foreground mt-0.5">
                                    {status === "done" ? "Sin datos de volumen" : "Pendiente de análisis"}
                                  </p>
                                )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="py-3 text-center text-xs text-muted-foreground">
                      Sin detecciones cargadas.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* ── visor de mapa ── */}
        <section className="relative min-w-0 overflow-hidden bg-background animate-in fade-in duration-500">
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

              <div
                ref={containerRef}
                role="presentation"
                onWheel={onWheel}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => setDragging(false)}
                className={`h-full w-full touch-none select-none overflow-hidden ${
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
      </main>

      {/* HDU4/AC1 — modal que pide el nombre del análisis */}
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

      {/* HDU4/AC6 — confirmación cuando el nombre ya existe */}
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
              <img
                src={duplicateExisting.thumbnailUrl ?? duplicateExisting.mapUrl}
                alt={duplicateExisting.name}
                className="h-16 w-16 flex-shrink-0 rounded object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{duplicateExisting.name}</p>
                <p className="text-[10px] text-muted-foreground mb-1.5">
                  Guardado el {new Date(duplicateExisting.savedAt).toLocaleString("es-CL")}
                </p>
                {duplicateExisting.summary && (
                  <div className="flex gap-2 text-[10px] text-muted-foreground">
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

function Metric({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-background/60 px-3 py-3">
      <div className="mb-2.5 text-primary/65 [&_svg]:h-4 [&_svg]:w-4">{icon}</div>
      <p className="text-[10px] text-muted-foreground leading-none mb-1">{label}</p>
      <p className="text-base font-bold tabular-nums">{value}</p>
    </div>
  );
}

function StatBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-background/80 px-1.5 py-1 text-center">
      <p className="mono text-[8px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mono text-[10px] font-semibold tabular-nums leading-tight">{value}</p>
    </div>
  );
}
