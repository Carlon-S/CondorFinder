// =============================================================================
// CONDORFINDER - VISTA DE ANALISIS DE VOLUMEN
// Archivo: src/routes/analysis.tsx
//
// Ruta: /analysis
//
// Implementa el frontend de HDU2:
// - Ejecutar analisis de volumen sobre el mapa unificado.
// - Mostrar volumen por poligono detectado.
// - Mostrar resumen total del analisis.
// - Cubrir el caso "No hay basura detectada en el area".
//
// Estado actual: SIMULADO
// Esta vista no ejecuta vision computacional, no calcula volumen real y no usa
// coordenadas geoespaciales. Consume `src/lib/analysis.ts`, que retorna volumenes
// predefinidos para validar el flujo de frontend antes de integrar backend.
//
// Consideraciones para continuar:
// 1. Reemplazar los volumenes simulados por resultados reales del backend.
// 2. Ocultar controles de simulacion antes de entregar una version productiva.
// =============================================================================

import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  BarChart3,
  Boxes,
  CheckCircle2,
  Clock,
  Crosshair,
  Loader2,
  Map as MapIcon,
  MousePointerClick,
  RotateCcw,
  Search,
  Trash2,
  TriangleAlert,
  ZoomIn,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { analyzeUnifiedMap, type WastePolygon } from "@/lib/analysis";
import { loadMapUrl } from "@/lib/mapState";
import { AppNavbar } from "@/components/AppNavbar";
import unifiedMapPreviewFallback from "@/assets/unified-map-preview.webp";

export const Route = createFileRoute("/analysis")({
  head: () => ({
    meta: [
      { title: "CondorFinder - Analisis de volumen" },
      {
        name: "description",
        content:
          "Vista de analisis simulado para calcular volumen de residuos por poligono sobre el mapa unificado.",
      },
    ],
  }),
  component: AnalysisPage,
});

type AnalysisStatus = "idle" | "running" | "done" | "empty" | "error";

function AnalysisPage() {
  /**
 * URL del mapa a analizar.
 * Recupera el mapa generado en HDU1 desde sessionStorage.
 * Si el usuario llega directamente a /analysis sin haber generado un mapa,
 * usa el asset local como fallback para que la vista sea funcional.
 */
const mapUrl = loadMapUrl() ?? unifiedMapPreviewFallback;

/** true si existe un mapa generado en HDU1 disponible en sessionStorage */
const usingGeneratedMap = loadMapUrl() !== null;
  // Estado principal de la demo de analisis. Cuando exista backend, estos estados
  // pueden mantenerse, pero los datos deberian venir de una respuesta real.
  const [status, setStatus] = useState<AnalysisStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [simulateEmpty, setSimulateEmpty] = useState(false);
  const [polygons, setPolygons] = useState<WastePolygon[]>([]);
  const [summary, setSummary] = useState({ areaM2: 0, volumeM3: 0 });
  const [analysisMessage, setAnalysisMessage] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // Ejecuta una secuencia de progreso visual y luego consulta el servicio simulado.
  const runAnalysis = async () => {
    setStatus("running");
    setProgress(0);
    setPolygons([]);
    setSummary({ areaM2: 0, volumeM3: 0 });
    setAnalysisMessage(null);
    for (const value of [18, 36, 58, 76, 92]) {
      await sleep(420);
      setProgress(value);
    }
    try {
      const response = await analyzeUnifiedMap(mapUrl, { forceEmpty: simulateEmpty });
      setProgress(100);
      if (response.status === "success") {
        setPolygons(response.polygons);
        setSummary(response.summary);
        setStatus("done");
        return;
      }
      if (response.status === "empty") {
        setAnalysisMessage(response.message);
        setStatus("empty");
        return;
      }
      setAnalysisMessage(response.message);
      setStatus("error");
    } catch {
      setProgress(100);
      setAnalysisMessage("No se pudo completar el analisis de volumen. Intenta nuevamente.");
      setStatus("error");
    }
  };

  const resetView = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  // ---------------------------------------------------------------------------
  // ZOOM CENTRADO EN EL CURSOR
  // Calcula el punto del mapa bajo el cursor antes del zoom y ajusta el offset
  // para que ese punto permanezca fijo en pantalla después del cambio de escala.
  // Requiere transformOrigin "0 0" en el elemento escalado para que el sistema
  // de coordenadas del offset sea coherente con la posición del cursor.
  // ---------------------------------------------------------------------------
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

    // Punto en el mapa antes del zoom
    const mapX = (px - offset.x) / scale;
    const mapY = (py - offset.y) / scale;

    // Nueva escala
    const next = Math.min(4, Math.max(0.7, scale + (event.deltaY < 0 ? 0.14 : -0.14)));
    const newScale = Number(next.toFixed(2));

    // Nuevo offset para mantener el punto bajo el cursor
    setOffset({
      x: px - mapX * newScale,
      y: py - mapY * newScale,
    });
    setScale(newScale);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
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

  return (
    <div
      className="flex flex-col h-screen overflow-hidden bg-background text-foreground gis-gradient-bg"
      style={{ "--scrollbar-compensation": "15px" } as React.CSSProperties}
    >
      <AppNavbar />
      <main className="grid flex-1 grid-cols-[360px_1fr] min-h-0">
        <aside id="dashboard" className="border-r border-border bg-card/95 backdrop-blur p-4 shadow-2xl">
          <div className="flex h-full flex-col gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 text-primary">
                  <BarChart3 className="h-4 w-4" />
                </span>
                <div>
                  <h1 className="text-lg font-semibold">Analisis de volumen</h1>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Ejecuta el analisis sobre el mapa unificado para estimar el volumen asociado a cada
                poligono detectado.
              </p>
              <div className={`mt-3 flex items-center gap-2 rounded-md border px-3 py-2 text-[11px] ${
                usingGeneratedMap
                  ? "border-success/30 bg-success/10 text-success"
                  : "border-border bg-background/40 text-muted-foreground"
              }`}>
                <MapIcon className="h-3.5 w-3.5 flex-shrink-0" />
                {usingGeneratedMap
                  ? "Usando el mapa generado en Carga"
                  : "Usando mapa de referencia (sin mapa generado aún)"}
              </div>
            </div>

            <div className="rounded-md border border-border bg-background/40 p-3">
              <Button onClick={runAnalysis} disabled={status === "running"} className="w-full">
                {status === "running" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analizando...
                  </>
                ) : (
                  <>
                    <Search className="mr-2 h-4 w-4" /> Analizar volumen
                  </>
                )}
              </Button>
              <label className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={simulateEmpty}
                  onChange={(event) => setSimulateEmpty(event.target.checked)}
                  disabled={status === "running"}
                  className="h-3 w-3 accent-[var(--primary)]"
                />
                Simular analisis sin basura detectada
              </label>
            </div>

            <div className="rounded-md border border-border bg-background/40 p-3">
              <p className="mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Estado del analisis
              </p>
              <div className="mt-2 flex items-center gap-2">
                {status === "running" ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                ) : status === "done" ? (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                ) : status === "empty" ? (
                  <TriangleAlert className="h-4 w-4 text-warning" />
                ) : (
                  <Clock className="h-4 w-4 text-muted-foreground" />
                )}
                <p className="text-xs font-medium">{statusLabel[status]}</p>
              </div>
              <Progress value={progress} className="mt-3 h-1" />
              <p className="mono mt-1 text-[10px] text-muted-foreground">{progress}% completado</p>
            </div>

            {status === "empty" || status === "error" ? (
              <div className="flex flex-1 flex-col items-center justify-center rounded-md border border-warning/40 bg-warning/10 p-5 text-center">
                {status === "empty" ? (
                  <Trash2 className="mb-3 h-8 w-8 text-warning" />
                ) : (
                  <TriangleAlert className="mb-3 h-8 w-8 text-warning" />
                )}
                <p className="text-sm font-semibold">
                  {analysisMessage || "No hay basura detectada en el área"}
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {status === "empty"
                    ? "El analisis finalizo correctamente, pero no encontro poligonos de residuos en el mapa unificado."
                    : "El servicio de analisis no retorno resultados validos para mostrar."}
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Metric
                    label="Volumen total"
                    value={`${summary.volumeM3} m3`}
                    icon={<Boxes className="h-4 w-4" />}
                  />
                  <Metric
                    label="Area total"
                    value={`${summary.areaM2} m2`}
                    icon={<Crosshair className="h-4 w-4" />}
                  />
                  <Metric
                    label="Poligonos"
                    value={String(polygons.length)}
                    icon={<MapIcon className="h-4 w-4" />}
                  />
                  <Metric label="Preview" value="WEBP" icon={<ZoomIn className="h-4 w-4" />} />
                </div>

                <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background/40">
                  <div className="border-b border-border px-3 py-2">
                    <p className="mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Volumen por poligono
                    </p>
                  </div>
                  {status === "done" ? (
                    <ul className="h-full overflow-y-auto pb-8">
                      {polygons.map((polygon) => (
                        <li key={polygon.id} className="border-b border-border p-3">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold">{polygon.name}</p>
                            <p className="text-[10px] text-muted-foreground">
                              Resultado simulado de volumen
                            </p>
                          </div>
                          <div className="mt-2 grid grid-cols-3 gap-2 text-[10px]">
                            <MiniStat label="Vol." value={`${polygon.volumeM3} m3`} />
                            <MiniStat label="Area" value={`${polygon.areaM2} m2`} />
                            <MiniStat label="Conf." value={`${polygon.confidence}%`} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="flex h-full items-center justify-center p-5 text-center text-xs text-muted-foreground">
                      Presiona Analizar volumen para calcular los poligonos detectados.
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </aside>

        <section className="relative min-w-0 overflow-hidden bg-[#1d1d1d]">
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
              <img
                src={mapUrl}
                alt="Mapa unificado para analisis de volumen"
                className="h-full w-full object-contain p-4"
                draggable={false}
              />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

const statusLabel: Record<AnalysisStatus, string> = {
  idle: "Esperando inicio del analisis",
  running: "Calculando poligonos y volumenes...",
  done: "Analisis completado",
  empty: "Analisis completado sin detecciones",
  error: "Error en el analisis",
};

function Metric({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="mb-2 text-muted-foreground">{icon}</div>
      <p className="mono text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-base font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-card/60 px-2 py-1">
      <p className="mono text-[8px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}