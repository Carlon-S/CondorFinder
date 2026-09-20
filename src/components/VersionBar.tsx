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
// Se puede plegar: en pantallas de poco alto, o cuando ya se eligió la captura
// con la que se va a trabajar, esas casillas son espacio que le sirve más al
// mapa. Plegada deja su encabezado a la vista, que es lo que permite volver a
// abrirla.
//
// No consulta nada por su cuenta. Recibe las versiones ya agrupadas por
// buildVersions() y avisa cuál se eligió: la vista es la dueña del estado.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Loader2, Trash2 } from "@/components/icons/Icons";
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
  onDelete,
  loading = false,
}: {
  versions: ZoneVersion[];
  /** sourceTaskId de la versión que se está viendo. */
  activeTaskId: string | null;
  onSelect: (version: ZoneVersion) => void;
  /** Eliminar una captura concreta de la zona. Sin esto solo se podía borrar
   *  desde Vista Principal, y para llegar a una versión intermedia había que
   *  saber que estaba escondida bajo el filtro "Historial". Se omite cuando la
   *  zona tiene una sola captura: eso ya no es borrar una versión, es borrar
   *  la zona, y ese camino vive en Vista Principal con su confirmación. */
  onDelete?: (version: ZoneVersion) => void;
  /** Las capturas se piden al backend después de montar la vista. Sin este
   *  aviso, la barra aparecía de golpe un momento después y empujaba el
   *  contenido; con él, el espacio queda reservado desde el principio. */
  loading?: boolean;
}) {
  const pista = useRef<HTMLOListElement>(null);
  const [puedeIzquierda, setPuedeIzquierda] = useState(false);
  const [puedeDerecha, setPuedeDerecha] = useState(false);
  const [plegada, setPlegada] = useState(false);

  // Las flechas solo tienen sentido cuando hay más casillas que ancho. Se
  // recalcula al cambiar las versiones, al desplazar, al plegar y al
  // redimensionar.
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
  }, [versions, plegada]);

  const desplazar = (direccion: -1 | 1) => {
    const el = pista.current;
    if (!el) return;
    el.scrollBy({ left: direccion * el.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <div className="flex-shrink-0 border-t border-border/40 bg-card/60 px-4 py-2.5">
      {/* El encabezado es también el control de plegado: es la única parte que
          queda visible cerrada, así que tiene que ser lo que la vuelve a abrir.
          Va en el color de texto pleno, no en gris apagado: es un
          título de sección y además el control que abre y cierra la barra, así
          que tiene que leerse como algo con lo que se puede interactuar. El
          gris queda para lo accesorio. */}
      <button
        type="button"
        onClick={() => setPlegada((v) => !v)}
        aria-expanded={!plegada}
        className="mx-auto flex cursor-pointer items-center gap-2 rounded px-2 py-0.5 transition-colors hover:bg-muted/50"
      >
        <span className="text-xs font-semibold text-foreground">Capturas de esta zona</span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        <ChevronDown
          className={`h-3.5 w-3.5 text-foreground transition-transform duration-300 ${
            plegada ? "-rotate-90" : ""
          }`}
          aria-hidden="true"
        />
      </button>

      {/* Se pliega animando el alto máximo, no montando y desmontando: así el
          cierre y la apertura se ven como un movimiento y no como un salto. */}
      <div
        className={`overflow-hidden transition-all duration-300 ease-out ${
          plegada ? "max-h-0 opacity-0" : "mt-2 max-h-[12rem] opacity-100"
        }`}
      >
        <div className="relative">
          {puedeIzquierda && <Flecha lado="izquierda" onClick={() => desplazar(-1)} />}
          {puedeDerecha && <Flecha lado="derecha" onClick={() => desplazar(1)} />}

          {/* Mientras cargan NO se dibujan casillas de mentira. Antes se
              pintaban dos placeholders con forma de miniatura y, durante el par
              de segundos que tarda la consulta, se leían como si la zona
              tuviera dos capturas que después cambiaban solas. Se reserva el
              mismo alto con una línea de estado, que no se puede confundir con
              contenido real. */}
          {loading ? (
            <div className="flex h-[7.5rem] items-center justify-center text-xs text-muted-foreground">
              Cargando capturas...
            </div>
          ) : (
            // justify-center centra las casillas cuando caben; cuando no, el
            // navegador ignora el centrado y la pista se desplaza con
            // normalidad, que es justo el comportamiento deseado.
            <ol
              ref={pista}
              onScroll={revisarFlechas}
              className="flex justify-center gap-2 overflow-x-auto pb-1"
            >
              {versions.map((version, i) => {
                const ultimo = version.analyses[version.analyses.length - 1];
                const total = zoneTotals(ultimo);
                const activa = version.sourceTaskId === activeTaskId;
                const vigente = i === versions.length - 1;

                return (
                  // relative: la papelera va superpuesta a la casilla, no
                  // dentro de su <button>. Un botón anidado dentro de otro es
                  // HTML inválido y el click del interior activa igual al
                  // exterior, o sea que borrar habría cambiado de versión
                  // antes de abrir la confirmación.
                  <li key={version.sourceTaskId} className="group relative flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => onSelect(version)}
                      aria-current={activa ? "true" : undefined}
                      className={`flex w-[9.5rem] flex-col gap-1.5 rounded-lg border p-2 text-left transition-all duration-200 hover:-translate-y-0.5 ${
                        activa
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border/60 hover:border-border hover:bg-muted/50"
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
                          <span className="text-[0.63rem] text-success-strong">vigente</span>
                        ) : (
                          <span className="text-[0.63rem] text-muted-foreground">consulta</span>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-1">
                        <span className="mono text-[0.63rem] tabular-nums text-muted-foreground">
                          {total.volumeM3.toLocaleString("es-CL")} m³
                        </span>
                        {/* Ninguna foto traía fecha y se usó la de carga. Sin
                            decirlo, una fecha inventada se lee como real. */}
                        {version.captureDateEstimated && (
                          <span
                            className="text-[0.63rem] text-warning"
                            title="Ninguna foto traía fecha de captura; se usó la de carga"
                          >
                            estimada
                          </span>
                        )}
                      </div>
                    </button>

                    {/* Aparece al pasar por encima. Siempre visible sería ruido
                        constante sobre una acción destructiva que casi nunca se
                        usa; y con foco de teclado también se muestra, para que
                        no quede inalcanzable sin ratón. */}
                    {onDelete && (
                      <button
                        type="button"
                        onClick={() => onDelete(version)}
                        title="Eliminar esta captura"
                        aria-label={`Eliminar la captura del ${formatDate(version.captureDate)}`}
                        className="absolute right-1 top-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md bg-card/90 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition-all duration-150 hover:bg-destructive/15 hover:text-destructive-strong focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
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
