// =============================================================================
// CONDORFINDER, BARRA DE VERSIONES DE UNA ZONA (HDU10)
// Archivo: src/components/VersionBar.tsx
//
// Navegación horizontal entre las capturas de una zona, al pie de la vista de
// Análisis, con el mismo gesto que cambiar de diapositiva. Cada casilla es un
// VUELO, no una medición: sobre un mismo vuelo puede haber varios análisis y
// todos comparten mapa y fecha, así que una casilla por análisis llenaría la
// barra de miniaturas idénticas.
//
// No consulta nada por su cuenta. Recibe las versiones ya agrupadas por
// buildVersions() y avisa cuál se eligió: la vista es la dueña del estado.
// =============================================================================

import type { ZoneVersion } from "@/lib/volumeReport";
import { zoneTotals } from "@/lib/volumeReport";

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "sin fecha";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "sin fecha" : d.toLocaleDateString("es-CL");
}

export function VersionBar({
  versions,
  activeTaskId,
  onSelect,
}: {
  versions: ZoneVersion[];
  /** sourceTaskId de la versión que se está viendo. */
  activeTaskId: string | null;
  onSelect: (version: ZoneVersion) => void;
}) {
  // Con una sola captura no hay entre qué navegar y la barra solo ocuparía
  // alto. La vista sigue completa sin ella.
  if (versions.length < 2) return null;

  return (
    <div className="flex-shrink-0 border-t border-border/40 bg-card/60 px-4 py-3">
      <div className="mb-2 flex items-baseline gap-2">
        <p className="text-xs font-semibold text-muted-foreground">Capturas de esta zona</p>
        <span className="mono text-[0.58rem] text-muted-foreground">
          {versions.length} versiones
        </span>
      </div>

      {/* Scroll horizontal cuando hay más capturas que ancho. Las casillas no
          se encogen: una miniatura diminuta no ayuda a reconocer el terreno,
          que es justo para lo que sirve esta barra. */}
      <ol className="flex gap-2 overflow-x-auto pb-1">
        {versions.map((version, i) => {
          const ultimo = version.analyses[version.analyses.length - 1];
          const total = zoneTotals(ultimo);
          const activa = version.sourceTaskId === activeTaskId;
          const vigente = i === versions.length - 1;

          return (
            <li key={version.sourceTaskId} className="flex-shrink-0">
              <button
                type="button"
                onClick={() => onSelect(version)}
                aria-current={activa ? "true" : undefined}
                className={`flex w-[9.5rem] flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors ${
                  activa
                    ? "border-primary bg-primary/5"
                    : "border-border/60 hover:bg-muted/50"
                }`}
              >
                <div className="detect-frame detect-frame-sm h-[3.75rem] w-full overflow-hidden rounded bg-muted">
                  <span className="detect-corners" aria-hidden="true" />
                  <img
                    src={version.thumbnailUrl ?? version.mapUrl}
                    alt={`Captura del ${formatDate(version.captureDate)}`}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                </div>

                <div className="flex items-center justify-between gap-1">
                  <span className="text-[0.69rem] font-semibold text-foreground">
                    {formatDate(version.captureDate)}
                  </span>
                  {vigente ? (
                    <span className="mono text-[0.53rem] text-success">vigente</span>
                  ) : (
                    <span className="mono text-[0.53rem] text-muted-foreground">consulta</span>
                  )}
                </div>

                <div className="flex items-center justify-between gap-1">
                  <span className="mono text-[0.58rem] text-muted-foreground">
                    {total.volumeM3.toLocaleString("es-CL")} m³
                  </span>
                  {/* Ninguna foto traía fecha y se usó la de carga. Sin
                      decirlo, una fecha inventada se lee como real. */}
                  {version.captureDateEstimated && (
                    <span
                      className="mono text-[0.53rem] text-warning"
                      title="Ninguna foto traía fecha de captura; se usó la de carga"
                    >
                      estimada
                    </span>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
