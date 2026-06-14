import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
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
  Scale,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { startVolumeAnalysis, pollVolumeAnalysis, type EnrichedDetection } from "@/lib/analysis";
import { loadMapUrl, MAP_READY_EVENT } from "@/lib/mapState";
import { loadNoWasteDetected, loadDetectionJsonUrl, loadTaskId } from "@/lib/imageState";
import { AppNavbar } from "@/components/AppNavbar";

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
      area_m2:    aggArea   || null,
      volume_m3:  aggVolume || null,
      weight_kg:  aggWeight || null,
      breakdown,
    };
  });
}

// ── ruta ──────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/analysis")({
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
  const usingGeneratedMap = mapUrl !== null;

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
  const [enabledIds, setEnabledIds]               = useState<Set<number>>(new Set());
  const [imgNaturalSize, setImgNaturalSize]        = useState<{ w: number; h: number } | null>(null);

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

  // ── carga detecciones al montar ────────────────────────────────────────────

  useEffect(() => {
    const jsonUrl = loadDetectionJsonUrl();
    if (!jsonUrl) return;
    fetch(jsonUrl)
      .then(r => r.json())
      .then(data => {
        const merged = mergeOverlapping(data.detections ?? [])
          .filter(d => !(d.weight_kg != null && d.weight_kg > WEIGHT_LIMIT_KG));
        setDisplayDetections(merged);
        setEnabledIds(new Set(merged.map(d => d.id)));
      })
      .catch(() => {});
  }, []);

  // ── sincronización si el mapa termina mientras se está en esta vista ───────

  useEffect(() => {
    const handler = (e: Event) => {
      const url = (e as CustomEvent<{ url: string }>).detail.url;
      setMapUrl(url);
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
    const taskId = loadTaskId();
    const jsonUrl = loadDetectionJsonUrl();
    if (!mapUrl || !taskId || !jsonUrl) {
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

      const response = await pollVolumeAnalysis(taskId, jsonUrl, setProgress);
      if (response.status === "success") {
        const merged = mergeOverlapping(response.detections)
          .filter(d => !(d.weight_kg != null && d.weight_kg > WEIGHT_LIMIT_KG));
        setDisplayDetections(merged);
        setEnabledIds(new Set(merged.map(d => d.id)));
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

  return (
    <div
      className="flex flex-col h-screen overflow-hidden bg-background text-foreground gis-gradient-bg"
      style={{ "--scrollbar-compensation": "15px" } as React.CSSProperties}
    >
      <AppNavbar />
      <main className="grid flex-1 grid-cols-[360px_1fr] min-h-0">

        {/* ── panel lateral ── */}
        <aside
          id="dashboard"
          className="border-r border-border/35 p-5 overflow-y-auto"
        >
          <div className="flex flex-col divide-y divide-border/25">

            {/* título */}
            <div className="pb-4">
              <div className="flex items-center gap-2.5 border-l-2 border-primary/50 pl-3">
                <BarChart3 className="h-4 w-4 text-primary/75" />
                <h1 className="text-lg font-bold tracking-tight">Análisis de volumen</h1>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Activa o desactiva zonas antes de ejecutar el análisis. Los totales
                reflejan únicamente las zonas activas.
              </p>
            </div>

            {/* botón análisis */}
            <div className="py-4">
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
            </div>

            {/* estado */}
            <div className="py-4">
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

            {/* empty / error */}
            {(status === "empty" || status === "error") ? (
              <div className="py-4">
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
              <>
                {/* métricas */}
                <div className="py-4">
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
                <div className="py-4">
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

                  {displayDetections.length > 0 ? (
                    <ul className="space-y-1.5 max-h-[340px] overflow-y-auto pr-0.5">
                      {displayDetections.map(d => {
                        const enabled = enabledIds.has(d.id);
                        const color   = classColor(d.class);
                        const hasData = d.volume_m3 != null || d.area_m2 != null;
                        return (
                          <li
                            key={d.id}
                            className={`rounded-md border transition-opacity duration-150 ${
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
              </>
            )}
          </div>
        </aside>

        {/* ── visor de mapa ── */}
        <section className="relative min-w-0 overflow-hidden bg-background">
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
              <Link to="/">
                <Button variant="secondary" size="sm">
                  Ir a Unificación de imágenes
                </Button>
              </Link>
            </div>
          )}
        </section>
      </main>
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
