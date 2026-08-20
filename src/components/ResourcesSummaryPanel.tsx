// =============================================================================
// CONDORFINDER — PANEL "RECURSOS DISPONIBLES" (HDU6)
// Archivo: src/components/ResourcesSummaryPanel.tsx
//
// Extraído de index.tsx (Vista Principal) para reusarlo tal cual en
// recursos.tsx — el usuario pidió ver exactamente la misma información ahí
// también, antes del botón "Definir punto". Recibe `points` ya
// cargados por el padre en vez de volver a pedirlos: ambos consumidores
// (index.tsx, recursos.tsx) ya tienen su propio listResourcePoints().
// =============================================================================

import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { ArrowRightCircle, Construction, MapPin, Truck, Users, Warehouse } from "@/components/icons/Icons";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
// Primitivo de Radix directo (no el wrapper compartido) solo para la fila
// de cada punto dentro del accordion anidado: necesita un botón "Ver en el
// mapa" como hermano del trigger, no como hijo — AccordionTrigger (el
// wrapper) mete todo lo que se le pasa DENTRO de un único <button>, y un
// <a> anidado en un <button> es inválido/rompe la interacción.
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import type { ResourcePoint } from "@/lib/resources";

const RESOURCE_ROWS = [
  { icon: Warehouse, label: "Tolvas", key: "tolvas" },
  { icon: Construction, label: "Retroexcavadoras", key: "retro" },
  { icon: Truck, label: "Camiones", key: "trucks" },
  { icon: MapPin, label: "Puntos", key: "points" },
  { icon: Users, label: "Personal", key: "personal" },
] as const;

interface ResourcesSummaryPanelProps {
  points: ResourcePoint[];
  className?: string;
}

export function ResourcesSummaryPanel({ points, className }: ResourcesSummaryPanelProps) {
  const resourceTotals = {
    tolvas: points.reduce((sum, p) => sum + p.tolvas.length, 0),
    retro: points.reduce((sum, p) => sum + p.retroexcavadoras_count, 0),
    trucks: points.reduce((sum, p) => sum + p.trucks.length, 0),
    points: points.length,
    personal: points.reduce((sum, p) => sum + p.personal_count, 0),
  };

  /** Puntos que contribuyen a un recurso — la cantidad que cada
   *  uno aporta se calcula aparte (ver pointCount) para el "{Punto}: N" de
   *  su fila dentro del accordion anidado. */
  function resourceBreakdown(key: keyof typeof resourceTotals): ResourcePoint[] {
    switch (key) {
      case "tolvas": return points.filter((p) => p.tolvas.length > 0);
      case "retro": return points.filter((p) => p.retroexcavadoras_count > 0);
      case "trucks": return points.filter((p) => p.trucks.length > 0);
      case "personal": return points.filter((p) => p.personal_count > 0);
      case "points": return points;
    }
  }

  /** Cuánto aporta UN punto puntual a un recurso — para el "{Punto}: N" de
   *  su fila dentro del accordion anidado. "points" no tiene un conteo
   *  propio (un punto siempre es 1 de sí mismo), así que no aplica. */
  function pointCount(key: keyof typeof resourceTotals, p: ResourcePoint): number | null {
    switch (key) {
      case "tolvas": return p.tolvas.length;
      case "retro": return p.retroexcavadoras_count;
      case "trucks": return p.trucks.length;
      case "personal": return p.personal_count;
      case "points": return null;
    }
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-2.5 border-l-2 border-primary/50 pl-3">
        <Truck className="h-3.5 w-3.5 text-primary/75" />
        <h3 className="text-sm font-semibold tracking-tight text-foreground">Recursos disponibles</h3>
      </div>

      {/* Totales reales sobre los puntos guardados (HDU6/AC4) —
          ya no son placeholders fijos. Cada fila se expande in-line
          (accordion, no una ventana aparte) mostrando el desglose por
          punto ("¿dónde están esas 5 tolvas?"). */}
      <Accordion type="single" collapsible className="mt-6">
        {RESOURCE_ROWS.map(({ icon: Icon, label, key }) => (
          <AccordionItem key={key} value={key} className="border-border/15">
            <AccordionTrigger className="py-3.5 hover:no-underline">
              <span className="flex flex-1 items-center gap-3">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-background/50 text-primary/50">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="flex-1 text-sm font-medium text-foreground/70">
                  {label}: <span className="mono text-muted-foreground">{resourceTotals[key]}</span>
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              {resourceBreakdown(key).length === 0 ? (
                <p className="pl-4 text-xs text-muted-foreground">Sin datos para este recurso todavía.</p>
              ) : key === "tolvas" || key === "trucks" ? (
                // Solo tolvas (capacidad) y camiones (lista por unidad)
                // tienen algo más que mostrar al expandir un punto —
                // retroexcavadoras/personal/puntos no, así
                // que esos van por la rama plana de abajo, sin chevron.
                //
                // Root propio: sin esto, estos Item no tienen estado
                // independiente y se registran en el Accordion de
                // AFUERA (el de los 5 recursos) — clickear un punto
                // terminaba cerrando "Camiones" en vez de desplegarse.
                <AccordionPrimitive.Root
                  type="single"
                  collapsible
                  className="ml-4 max-h-40 space-y-0.5 overflow-y-auto border-l border-border/40"
                >
                  {resourceBreakdown(key).map((point) => {
                    const count = pointCount(key, point);
                    return (
                      <AccordionPrimitive.Item key={point.id} value={point.id} className="border-none">
                        <div className="flex items-center gap-1">
                          <AccordionPrimitive.Header className="min-w-0 flex-1">
                            <AccordionPrimitive.Trigger className="flex w-full cursor-pointer items-center gap-1.5 py-1.5 pl-4 text-left text-xs transition-colors hover:text-foreground [&[data-state=open]>svg]:rotate-180">
                              <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-200" />
                              <span className="truncate font-semibold text-foreground">
                                {point.name}
                                {count !== null && ` (${count})`}
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
                            {(key === "trucks" ? point.trucks : point.tolvas).map((unit, i) => (
                              <p key={i} className="text-[11px] text-muted-foreground">
                                {key === "trucks" ? "Camión" : "Tolva"} {i + 1} — {unit.capacity_m3} m³
                              </p>
                            ))}
                          </div>
                        </AccordionPrimitive.Content>
                      </AccordionPrimitive.Item>
                    );
                  })}
                </AccordionPrimitive.Root>
              ) : (
                // Retroexcavadoras, personal, puntos — sin
                // desglose posible, así que es una lista plana (sin
                // chevron ni expand), solo nombre+cantidad y el link.
                <ul className="ml-4 max-h-40 space-y-0.5 overflow-y-auto border-l border-border/40">
                  {resourceBreakdown(key).map((point) => {
                    const count = pointCount(key, point);
                    return (
                      <li key={point.id} className="flex items-center gap-1 py-1.5 pl-4">
                        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                          {point.name}
                          {count !== null && ` (${count})`}
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
        ))}
      </Accordion>
    </div>
  );
}
