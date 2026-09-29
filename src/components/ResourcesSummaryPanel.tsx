// =============================================================================
// CONDORFINDER — PANEL "RECURSOS DISPONIBLES" (HDU6 + HDU8)
// Archivo: src/components/ResourcesSummaryPanel.tsx
//
// Extraído de index.tsx para reusarlo en recursos.tsx y rutas.tsx. Recibe
// `points` y `resources` ya cargados por el padre en vez de volver a pedirlos:
// los consumidores ya tienen sus propias consultas.
//
// Las filas ya no son una lista fija de categorías. Antes eran cinco
// constantes (Tolvas, Retroexcavadoras, Camiones, Puntos, Personal) porque el
// punto guardaba exactamente esos contadores. Con los recursos individuales de
// HDU8 los tipos salen de los datos: la flota real tiene nueve, y una lista
// escrita a mano se quedaría corta el día que la municipalidad compre algo que
// no esté en ella, sin que nadie lo note.
//
// Cada tipo muestra "disponibles de total", no solo el total. Un patio con seis
// tolvas de las que cuatro están en taller no tiene seis tolvas para planificar,
// y ese es justamente el dato que el panel existe para dar.
// =============================================================================

import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { ArrowRightCircle, Boxes, MapPin, Truck, Users } from "@/components/icons/Icons";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Skeleton } from "@/components/ui/skeleton";
// Primitivo de Radix directo (no el wrapper compartido) solo para la fila
// de cada punto dentro del accordion anidado: necesita un botón "Ver en el
// mapa" como hermano del trigger, no como hijo — AccordionTrigger (el
// wrapper) mete todo lo que se le pasa DENTRO de un único <button>, y un
// <a> anidado en un <button> es inválido/rompe la interacción.
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import type { Resource, ResourcePoint } from "@/lib/resources";

interface ResourcesSummaryPanelProps {
  points: ResourcePoint[];
  /** Recursos de todos los puntos. El padre los carga con listResources(). */
  resources: Resource[];
  className?: string;
  /** Mientras el padre todavía está esperando la respuesta de Mongo — sin
   * esto, points llegaba como [] antes de resolver y esta tabla mostraba
   * "0" en cada fila por un instante, en vez de un estado de carga. */
  loading?: boolean;
}

/** Fila del panel. `tipo` presente = fila de un tipo de recurso; ausente = una
 *  de las dos filas fijas (puntos, personal), que no salen de los recursos. */
interface Fila {
  clave: string;
  etiqueta: string;
  valor: string;
  tipo?: string;
  icono: typeof Truck;
}

export function ResourcesSummaryPanel({
  points,
  resources,
  className,
  loading,
}: ResourcesSummaryPanelProps) {
  // Capacidad de transporte disponible: la misma cifra que usa el ruteo, y la
  // misma que el backend calcula por punto. Se suma desde los puntos y no
  // recontando los recursos acá, para que no haya dos aritméticas que puedan
  // discrepar sobre el mismo número.
  const capacidadTotal = points.reduce((sum, p) => sum + p.capacity_m3, 0);

  // Tipos presentes, ordenados por cantidad descendente: el patio se lee por lo
  // que más tiene.
  const porTipo = new Map<string, { total: number; disponibles: number }>();
  for (const r of resources) {
    const acumulado = porTipo.get(r.tipo) ?? { total: 0, disponibles: 0 };
    acumulado.total += 1;
    if (r.disponible) acumulado.disponibles += 1;
    porTipo.set(r.tipo, acumulado);
  }

  const filas: Fila[] = [
    {
      clave: "capacidad",
      etiqueta: "Capacidad de transporte",
      valor: `${capacidadTotal} m³`,
      icono: Boxes,
    },
    ...[...porTipo.entries()]
      .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
      .map(([tipo, { total, disponibles }]) => ({
        clave: `tipo:${tipo}`,
        etiqueta: tipo,
        valor: `${disponibles} de ${total}`,
        tipo,
        icono: Truck,
      })),
    { clave: "puntos", etiqueta: "Puntos", valor: String(points.length), icono: MapPin },
    {
      clave: "personal",
      etiqueta: "Personal",
      valor: String(points.reduce((sum, p) => sum + p.personal_count, 0)),
      icono: Users,
    },
  ];

  /** Puntos que aportan algo a esta fila. */
  function puntosDe(fila: Fila): ResourcePoint[] {
    if (fila.tipo) {
      const conEseTipo = new Set(
        resources.filter((r) => r.tipo === fila.tipo).map((r) => r.point_id),
      );
      return points.filter((p) => conEseTipo.has(p.id));
    }
    if (fila.clave === "personal") return points.filter((p) => p.personal_count > 0);
    if (fila.clave === "capacidad") return points.filter((p) => p.capacity_m3 > 0);
    return points;
  }

  /** Cuánto aporta un punto a esta fila, o null cuando no aplica (un punto
   *  siempre es 1 de sí mismo). */
  function aporteDe(fila: Fila, p: ResourcePoint): string | null {
    if (fila.tipo) {
      const unidades = resources.filter((r) => r.point_id === p.id && r.tipo === fila.tipo);
      const disponibles = unidades.filter((r) => r.disponible).length;
      return `${disponibles} de ${unidades.length}`;
    }
    if (fila.clave === "personal") return String(p.personal_count);
    if (fila.clave === "capacidad") return `${p.capacity_m3} m³`;
    return null;
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-2.5 border-l-2 border-primary/50 pl-3">
        <Truck className="h-3.5 w-3.5 text-foreground/70" />
        <h3 className="text-sm font-semibold tracking-tight text-foreground">Recursos disponibles</h3>
      </div>

      {loading ? (
        <div className="mt-6 space-y-3.5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3 py-1">
              <Skeleton className="h-8 w-8 flex-shrink-0 rounded-md" />
              <Skeleton className="h-4 w-32" />
            </div>
          ))}
        </div>
      ) : (
        <Accordion type="single" collapsible className="mt-6">
          {filas.map((fila) => {
            const Icono = fila.icono;
            const aportantes = puntosDe(fila);
            return (
              <AccordionItem key={fila.clave} value={fila.clave} className="border-border/15">
                <AccordionTrigger className="py-3.5 hover:no-underline">
                  <span className="flex flex-1 items-center gap-3">
                    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-background/50 text-foreground/60">
                      <Icono className="h-4 w-4" />
                    </span>
                    <span className="flex-1 text-left text-sm font-medium text-foreground/70">
                      {fila.etiqueta}: <span className="mono text-muted-foreground">{fila.valor}</span>
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  {aportantes.length === 0 ? (
                    <p className="pl-4 text-xs text-muted-foreground">
                      Sin datos para este recurso todavía.
                    </p>
                  ) : fila.tipo ? (
                    // Solo las filas de tipo tienen unidades que listar al
                    // expandir un punto. Las dos fijas van por la rama plana.
                    //
                    // Root propio: sin esto, estos Item no tienen estado
                    // independiente y se registran en el Accordion de AFUERA,
                    // así que clickear un punto cerraba la fila en vez de
                    // desplegarse.
                    <AccordionPrimitive.Root
                      type="single"
                      collapsible
                      className="ml-4 max-h-40 space-y-0.5 overflow-y-auto border-l border-border/40"
                    >
                      {aportantes.map((point) => (
                        <AccordionPrimitive.Item
                          key={point.id}
                          value={point.id}
                          className="border-none"
                        >
                          <div className="flex items-center gap-1">
                            <AccordionPrimitive.Header className="min-w-0 flex-1">
                              <AccordionPrimitive.Trigger className="flex w-full cursor-pointer items-center gap-1.5 py-1.5 pl-4 text-left text-xs transition-colors hover:text-foreground [&[data-state=open]>svg]:rotate-180">
                                <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-200" />
                                <span className="truncate font-semibold text-foreground">
                                  {point.name} ({aporteDe(fila, point)})
                                </span>
                              </AccordionPrimitive.Trigger>
                            </AccordionPrimitive.Header>
                            <Link
                              to="/recursos"
                              search={{ point: point.id }}
                              aria-label={`Ver ${point.name} en el mapa`}
                              title="Ver en el mapa"
                              className="flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                            >
                              <ArrowRightCircle className="h-3.5 w-3.5" />
                            </Link>
                          </div>
                          <AccordionPrimitive.Content className="overflow-hidden text-sm data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down">
                            <div className="space-y-1 py-1 pb-2 pl-9">
                              {resources
                                .filter((r) => r.point_id === point.id && r.tipo === fila.tipo)
                                .map((r) => (
                                  <p
                                    key={r.id}
                                    className={`text-[0.6875rem] ${
                                      r.disponible
                                        ? "text-muted-foreground"
                                        : "text-muted-foreground/60 line-through"
                                    }`}
                                  >
                                    {r.numero_equipo || "sin N°"}
                                    {r.patente && ` · ${r.patente}`}
                                    {/* Cada familia dice lo suyo, y "sin
                                        capacidad" solo tiene sentido en las que
                                        sí deberían tenerla: un carro de arrastre
                                        no transporta, no es que le falte un
                                        dato. */}
                                    {r.familia === "carga" &&
                                      ` · ${r.capacidad_m3 != null ? `${r.capacidad_m3} m³` : "sin capacidad"}`}
                                    {r.familia === "maquina" &&
                                      ` · balde ${r.capacidad_balde_m3 != null ? `${r.capacidad_balde_m3} m³` : "sin dato"}`}
                                  </p>
                                ))}
                            </div>
                          </AccordionPrimitive.Content>
                        </AccordionPrimitive.Item>
                      ))}
                    </AccordionPrimitive.Root>
                  ) : (
                    <ul className="ml-4 max-h-40 space-y-0.5 overflow-y-auto border-l border-border/40">
                      {aportantes.map((point) => {
                        const aporte = aporteDe(fila, point);
                        return (
                          <li key={point.id} className="flex items-center gap-1 py-1.5 pl-4">
                            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                              {point.name}
                              {aporte !== null && ` (${aporte})`}
                            </span>
                            <Link
                              to="/recursos"
                              search={{ point: point.id }}
                              aria-label={`Ver ${point.name} en el mapa`}
                              title="Ver en el mapa"
                              className="flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                            >
                              <ArrowRightCircle className="h-3.5 w-3.5" />
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      )}
    </div>
  );
}
