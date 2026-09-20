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
// Se muestra SIEMPRE, incluso con una sola captura. Aparecer y desaparecer
// según la cantidad de versiones movía el resto de la vista y hacía dudar de si
// la barra existía; con una sola captura simplemente se ve una casilla.
//
// No consulta nada por su cuenta. Recibe las versiones ya agrupadas por
// buildVersions() y avisa cuál se eligió: la vista es la dueña del estado.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
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
  loading = false,
}: {
  versions: ZoneVersion[];
  /** sourceTaskId de la versión que se está viendo. */
  activeTaskId: string | null;
  onSelect: (version: ZoneVersion) => void;
  /** Las capturas se piden al backend después de montar la vista. Sin este
   *  aviso, la barra aparecía de golpe un momento después y empujaba el
   *  contenido; con él, el espacio queda reservado desde el principio. */
  loading?: boolean;
}) {
  const pista = useRef<HTMLOListElement>(null);
  const [puedeIzquierda, setPuedeIzquierda] = useState(false);
  const [puedeDerecha, setPuedeDerecha] = useState(false);

  // Las flechas solo tienen sentido cuando hay más casillas que ancho. Se
  // recalcula al cambiar las versiones, al desplazar y al redimensionar.
  const revisarFlechas = () => {
    const el = pista.current;
    if (!el) return;
    setPuedeIzquierda(el.scrollLeft > 4);
    setPuedeDerecha(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };

  useEffect(() => {
    revisarFlechas();
    window.addEventListener("resize", revisarFlechas);
    return () => window.removeEventListener("resize", revisarFlechas);
  }, [versions]);

  const desplazar = (direccion: -1 | 1) => {
    const el = pista.current;
    if (!el) return;
    el.scrollBy({ left: direccion * el.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <div className="flex-shrink-0 border-t border-border/40 bg-card/60 px-4 py-3">
      <div className="mb-2 flex items-baseline justify-center gap-2">
        <p className="text-xs font-semibold text-muted-foreground">Capturas de esta zona</p>
        {!loading && (
          <span className="mono text-[0.58rem] text-muted-foreground">
            {versions.length === 1 ? "1 versión" : `${versions.length} versiones`}
          </span>
        )}
      </div>

      <div className="relative">
        {puedeIzquierda && <Flecha lado="izquierda" onClick={() => desplazar(-1)} />}
        {puedeDerecha && <Flecha lado="derecha" onClick={() => desplazar(1)} />}

        {/* justify-center centra las casillas cuando caben; cuando no, el
            navegador ignora el centrado y la pista se desplaza con normalidad,
            que es justo el comportamiento deseado. */}
        <ol
          ref={pista}
          onScroll={revisarFlechas}
          className="flex justify-center gap-2 overflow-x-auto pb-1"
        >
          {loading
            ? [0, 1].map((i) => (
                <li key={i} className="flex-shrink-0">
                  <Skeleton className="h-[7.5rem] w-[9.5rem] rounded-lg" />
                </li>
              ))
            : versions.map((version, i) => {
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
    </div>
  );
}

function Flecha({ lado, onClick }: { lado: "izquierda" | "derecha"; onClick: () => void }) {
  const Icono = lado === "izquierda" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={lado === "izquierda" ? "Ver capturas anteriores" : "Ver capturas siguientes"}
      className={`absolute top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card shadow-md transition-colors hover:bg-muted ${
        lado === "izquierda" ? "left-0" : "right-0"
      }`}
    >
      <Icono className="h-4 w-4" />
    </button>
  );
}
