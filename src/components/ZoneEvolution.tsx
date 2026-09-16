// =============================================================================
// CONDORFINDER — EVOLUCIÓN DE UNA ZONA (HDU10)
// Archivo: src/components/ZoneEvolution.tsx
//
// Muestra cómo cambió el volumen de una zona a lo largo de sus versiones
// (vuelos) y de los análisis hechos sobre cada una. La aritmética no vive acá:
// sale de src/lib/volumeReport.ts, el mismo módulo que usa el informe PDF, para
// que el gráfico y el documento nunca cuenten historias distintas.
//
// Grafica con recharts a través de src/components/ui/chart.tsx, ambos ya
// presentes en el proyecto: no agrega ninguna dependencia.
// =============================================================================

import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import type { SavedAnalysisRecord, ZoneRecord } from "@/lib/analysisStore";
import {
  evolutionSeries,
  hasMixedAlgorithms,
  zoneHistory,
  zoneTotals,
  type ZoneVersion,
} from "@/lib/volumeReport";

const chartConfig = {
  volumeM3: { label: "Volumen m³", color: "var(--chart-1)" },
} satisfies ChartConfig;

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "sin fecha";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "sin fecha" : d.toLocaleDateString("es-CL");
}

export function ZoneEvolution({
  zone,
  analyses,
  onOpenAnalysis,
}: {
  zone: ZoneRecord;
  /** Todos los análisis cargados; el componente filtra los de esta zona. */
  analyses: SavedAnalysisRecord[];
  /** Abre un análisis en el visor. La vista de análisis lo mostrará en solo
   *  lectura si su vuelo ya no es el más reciente de la zona. */
  onOpenAnalysis: (analysisId: string) => void;
}) {
  const versions: ZoneVersion[] = useMemo(() => zoneHistory(zone, analyses), [zone, analyses]);
  const points = useMemo(() => evolutionSeries(versions), [versions]);
  const mixedAlgorithms = useMemo(() => hasMixedAlgorithms(points), [points]);

  // AC3 — una zona de una sola versión no tiene con qué compararse. Se dice
  // explícitamente en vez de dibujar un gráfico de un punto, que parece un
  // error de datos.
  if (versions.length <= 1) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/30 p-6 text-center">
        <p className="text-sm font-medium text-foreground">Sin versiones anteriores</p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Esta zona tiene una sola captura, así que todavía no hay evolución que comparar.
          Cuando se cargue un vuelo nuevo del mismo terreno, aquí aparecerá cómo cambió su volumen.
        </p>
      </div>
    );
  }

  const chartData = points.map((p) => ({
    fecha: formatDate(p.date),
    volumeM3: p.volumeM3,
    analysisId: p.analysisId,
  }));

  return (
    <div className="space-y-5">
      {mixedAlgorithms && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[0.69rem] leading-relaxed text-foreground">
          Estas mediciones se calcularon con distintas versiones del algoritmo. Parte de la
          variación puede venir de mejoras en la medición y no de un cambio real en el terreno.
        </p>
      )}

      {/* AC2 — volumen estimado de cada versión por fecha */}
      <ChartContainer config={chartConfig} className="h-[13rem] w-full">
        <LineChart data={chartData} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="fecha" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} />
          <YAxis tickLine={false} axisLine={false} tickMargin={8} fontSize={11} width={44} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Line
            dataKey="volumeM3"
            type="monotone"
            stroke="var(--color-volumeM3)"
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        </LineChart>
      </ChartContainer>

      {/* AC1 — la cadena completa de versiones, ordenada cronológicamente.
          AC4 — click en una versión abre su análisis en el visor. */}
      <ol className="space-y-2">
        {versions.map((version, i) => {
          const ultimo = version.analyses[version.analyses.length - 1];
          const total = zoneTotals(ultimo);
          const esVigente = i === versions.length - 1;

          return (
            <li
              key={version.sourceTaskId}
              className="flex items-center gap-3 rounded-lg border border-border/60 bg-card p-2.5"
            >
              {/* El mapa de cada versión: es lo que más interesa ver cambiar
                  al recorrer la zona en el tiempo. */}
              <div className="detect-frame detect-frame-sm h-14 w-20 flex-shrink-0 overflow-hidden rounded bg-muted">
                <span className="detect-corners" aria-hidden="true" />
                <img
                  src={version.thumbnailUrl ?? version.mapUrl}
                  alt={`Mapa de la captura del ${formatDate(version.captureDate)}`}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-foreground">
                    {formatDate(version.captureDate)}
                  </p>
                  {version.captureDateEstimated && (
                    <span className="mono text-[0.58rem] text-muted-foreground" title="Ninguna foto traía fecha de captura; se usó la de carga">
                      fecha estimada
                    </span>
                  )}
                  {esVigente && (
                    <span className="mono text-[0.58rem] text-success">vigente</span>
                  )}
                </div>
                <p className="mono text-[0.63rem] text-muted-foreground">
                  {total.volumeM3.toLocaleString("es-CL")} m³ · {version.analyses.length} análisis
                </p>
              </div>

              <Button
                size="sm"
                variant="secondary"
                className="h-7 flex-shrink-0 px-3 text-xs"
                onClick={() => onOpenAnalysis(ultimo.id)}
              >
                Ver
              </Button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
