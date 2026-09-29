// =============================================================================
// CONDORFINDER, RECURSOS (HDU6 + HDU8)
// Archivo: src/routes/_authed/planificacion.recursos.tsx
//
// Los puntos desde donde sale la flota y, a través de cada uno, sus vehículos.
//
// Vista SEPARADA de /planificacion/rutas, aunque las dos cuelguen del mismo
// grupo del menú. Estuvieron fusionadas en una sola pantalla y no funcionó: son
// dos tareas con ritmos distintos. Administrar puntos y flota es CONFIGURACIÓN
// (se hace una vez, es precisa, vive en formularios y tablas); generar una ruta
// es OPERACIÓN (se hace a diario, es exploratoria, vive en el mapa). Fusionadas,
// la configuración se quedaba permanentemente con un tercio de la pantalla
// operativa, y el panel lateral terminaba con dos tarjetas que no se hablan
// compitiendo por la misma columna.
//
// Acá el mapa NO es el contenido: sirve para ubicar un punto y para verificar
// dónde quedó. El contenido es la tabla de puntos al pie, que es lo que se
// compara. Al revés que en la vista de rutas.
// =============================================================================

import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRightCircle, Loader2, MapPin, Pencil } from "@/components/icons/Icons";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GeoMap, type GeoMapPoint } from "@/components/GeoMap";
import { PanelPuntos, type PanelPuntosMapProps } from "@/components/PanelPuntos";
import { notify } from "@/lib/notify";
import { listResourcePoints, type ResourcePoint } from "@/lib/resources";

export const Route = createFileRoute("/_authed/planificacion/recursos")({
  component: RecursosPage,
});

function RecursosPage() {
  const navigate = useNavigate();
  const [points, setPoints] = useState<ResourcePoint[]>([]);
  const [loading, setLoading] = useState(true);
  // Lo que el panel necesita del mapa mientras se ubica un punto. Vive acá
  // porque el mapa es de esta vista, no del panel.
  const [mapProps, setMapProps] = useState<PanelPuntosMapProps>({
    marker: null,
    onMapClick: null,
    focusPoint: null,
  });
  const [puntoSeleccionado, setPuntoSeleccionado] = useState<string | null>(null);
  const [puntoAEditar, setPuntoAEditar] = useState<string | null>(null);

  const recargar = async () => {
    try {
      setPoints(await listResourcePoints());
    } catch (err) {
      notify.error(
        "No se pudieron cargar los puntos",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    recargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totales = {
    puntos: points.filter((p) => p.active).length,
    recursos: points.reduce((sum, p) => sum + p.resource_count, 0),
    disponibles: points.reduce((sum, p) => sum + p.available_count, 0),
    capacidad: points.reduce((sum, p) => sum + p.capacity_m3, 0),
  };

  const mapPoints: GeoMapPoint[] = points.map((p) => ({
    id: p.id,
    position: [p.lat, p.lng] as [number, number],
    label: p.active
      ? `${p.name} · ${p.capacity_m3} m³`
      : `${p.name} (inactivo) · ${p.capacity_m3} m³`,
    muted: !p.active,
  }));

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border/25 px-6 py-4">
        <div>
          <p className="eyebrow">Planificación</p>
          <h1 className="font-rubik text-2xl font-semibold tracking-normal text-foreground md:text-3xl">
            Recursos
          </h1>
        </div>
        <div className="flex flex-wrap items-center divide-x divide-border/10">
          <Cifra etiqueta="Puntos activos" valor={String(totales.puntos)} />
          <Cifra etiqueta="Recursos" valor={String(totales.recursos)} />
          <Cifra etiqueta="Disponibles" valor={`${totales.disponibles} de ${totales.recursos}`} />
          <Cifra etiqueta="Capacidad" valor={`${totales.capacidad} m³`} />
        </div>
      </div>

      <main className="flex flex-1 flex-col gap-5 p-6">
        {/* Panel y mapa en una fila de alto acotado. El mapa acompaña, no manda:
            acá se está configurando, y lo que se compara está en la tabla. */}
        <div className="grid gap-5 lg:grid-cols-[clamp(19rem,28vw,26rem)_1fr]">
          <aside className="rounded-xl border border-border bg-card p-5">
            <PanelPuntos
              onMapProps={setMapProps}
              onPuntosCambiaron={recargar}
              puntoSeleccionadoId={puntoSeleccionado}
              puntoAEditarId={puntoAEditar}
            />
          </aside>

          <section className="relative h-[clamp(18rem,38vh,28rem)] overflow-hidden rounded-xl border border-border bg-background">
            <GeoMap
              className="h-full w-full"
              points={mapPoints}
              onPointClick={(p) => setPuntoSeleccionado(p.id)}
              marker={mapProps.marker}
              onMapClick={mapProps.onMapClick ?? undefined}
              focusPoint={mapProps.focusPoint}
              lockToMaipu
            />
            {loading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/60">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}
          </section>
        </div>

        {/* El contenido de la vista. Un punto se compara con otro por sus cifras,
            y eso necesita filas, no marcadores. */}
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
            <span className="flex items-center gap-2.5 border-l-2 border-primary/50 pl-3">
              <MapPin className="h-3.5 w-3.5 text-foreground/70" />
              <h2 className="text-sm font-semibold tracking-tight text-foreground">Puntos</h2>
            </span>
          </div>

          <div className="px-5 pb-5">
            {loading ? (
              <div className="space-y-2 pt-4">
                {[0, 1].map((i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-md" />
                ))}
              </div>
            ) : points.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <MapPin className="h-10 w-10 text-muted-foreground/30" />
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Todavía no hay puntos
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Un punto es el lugar donde está la flota. Sin al menos uno no se puede
                    planificar ninguna ruta. Se define desde el panel de arriba.
                  </p>
                </div>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableHead>Punto</TableHead>
                    <TableHead>Dirección</TableHead>
                    <TableHead className="w-[8rem] text-right">Recursos</TableHead>
                    <TableHead className="w-[8rem] text-right">
                      Capacidad <span className="mono opacity-70">(m³)</span>
                    </TableHead>
                    <TableHead className="w-[6rem]">Estado</TableHead>
                    <TableHead className="w-[5rem]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {points.map((p) => (
                    <TableRow
                      key={p.id}
                      onClick={() =>
                        navigate({
                          to: "/planificacion/recursos/$pointId",
                          params: { pointId: p.id },
                        })
                      }
                      title="Ver la flota de este punto"
                      className="group cursor-pointer hover:bg-card/60"
                    >
                      <TableCell className="text-xs font-medium text-foreground transition-colors group-hover:text-primary">
                        {p.name}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {[p.address === p.name ? null : p.address, p.comuna]
                          .filter(Boolean)
                          .join(", ") || "-"}
                      </TableCell>
                      <TableCell className="mono text-right text-xs tabular-nums">
                        {p.available_count} de {p.resource_count}
                      </TableCell>
                      <TableCell className="mono text-right text-xs tabular-nums">
                        {p.capacity_m3}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide ${
                            p.active
                              ? "bg-success/15 text-success-strong"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {p.active ? "Activo" : "Inactivo"}
                        </span>
                      </TableCell>
                      {/* Dos acciones sobre la misma fila, y por eso el lápiz
                          corta la propagación: la fila abre la FLOTA del punto
                          (otra pantalla) y el lápiz lo abre para EDITARLO en el
                          panel de arriba, sin salir de acá. */}
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPuntoAEditar(p.id);
                            }}
                            title="Editar este punto"
                            aria-label={`Editar ${p.name}`}
                            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <ArrowRightCircle
                            aria-hidden="true"
                            className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary"
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/** Una cifra de la cabecera. Sin ícono ni pastilla: son cuatro seguidas y a
 *  este tamaño lo que las separa es el divisor vertical, no un adorno por
 *  cifra. */
function Cifra({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="flex-shrink-0 px-4">
      <p className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">{etiqueta}</p>
      <p className="mono text-lg font-semibold tabular-nums text-foreground">{valor}</p>
    </div>
  );
}
