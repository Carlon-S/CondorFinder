// =============================================================================
// CONDORFINDER, ITINERARIO SEMANAL (HDU14)
// Archivo: src/routes/_authed/planificacion.itinerario.tsx
//
// La grilla de LUNES a SÁBADO donde se reparten los puntos permanentes. Es la
// hoja `PERMANENTES` de la planilla municipal, que hoy mantienen a mano.
//
// ── Dos formas de agregar, no una ──
// El AC1 pide textualmente el botón con signo de suma que abre un listado. Eso
// es lo que está, y además se puede arrastrar desde el catálogo a una columna y
// reordenar dentro de ella.
//
// El arrastre no reemplaza al botón y no es redundancia: es más rápido para
// quien ya sabe qué busca, pero la API nativa de arrastre no funciona con el
// dedo ni con el teclado. El `+` es el camino que sirve siempre.
//
// ── Sin dependencia de arrastre ──
// Se usa la API nativa de HTML5 y no `@dnd-kit`, que son unos 30 kB para mover
// tarjetas entre listas. Este proyecto ya carga recharts y jsPDF de forma
// diferida justo para no engordar el paquete inicial.
//
// ── El orden es dato, no presentación ──
// La posición dentro de la columna es la secuencia del recorrido, así que cada
// gesto persiste la lista completa del día. Por eso el endpoint reemplaza en
// vez de dar de alta: después de arrastrar, lo que la vista tiene es el
// resultado final, no una diferencia.
// =============================================================================

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, MapPin, Pencil, Plus, Search, Trash2, X } from "@/components/icons/Icons";
import { notify } from "@/lib/notify";
import { PuntoPermanenteDialog } from "@/components/PuntoPermanenteDialog";
import { listZones, type ZoneRecord } from "@/lib/analysisStore";
import {
  DIAS,
  ROTULO_DIA,
  getItinerario,
  setDia,
  type DiaItinerario,
  type DiaSemana,
  type PuntoDelDia,
} from "@/lib/itinerario";

export const Route = createFileRoute("/_authed/planificacion/itinerario")({
  component: ItinerarioPage,
});

/** El tipo MIME propio del arrastre.
 *
 *  Uno a medida y no `text/plain` para que soltar texto cualquiera sobre una
 *  columna (una selección de la página, un enlace) no intente agregar un punto
 *  con un id inventado. */
const MIME = "application/x-condorfinder-punto";

function ItinerarioPage() {
  const [grilla, setGrilla] = useState<DiaItinerario[] | null>(null);
  const [catalogo, setCatalogo] = useState<ZoneRecord[] | null>(null);
  const [guardando, setGuardando] = useState<DiaSemana | null>(null);

  const [diaAbierto, setDiaAbierto] = useState<DiaSemana | null>(null);
  const [editando, setEditando] = useState<ZoneRecord | null>(null);
  const [formAbierto, setFormAbierto] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const [g, zonas] = await Promise.all([getItinerario(), listZones()]);
      setGrilla(g);
      setCatalogo(zonas.filter((z) => z.kind === "permanente"));
    } catch (e) {
      notify.error("No se pudo cargar el itinerario", (e as Error).message);
      setGrilla([]);
      setCatalogo([]);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /** Persiste un día y deja la grilla como quedó.
   *
   *  Optimista: la columna se actualiza en pantalla antes de la respuesta,
   *  porque arrastrar algo que tarda medio segundo en moverse se siente roto.
   *  Si el servidor rechaza, se recarga todo y se avisa: revertir solo esa
   *  columna dejaría el resto de la grilla con lo que el servidor ya no tiene. */
  const persistir = async (dia: DiaSemana, puntos: PuntoDelDia[]) => {
    setGrilla((prev) => (prev ?? []).map((d) => (d.dia === dia ? { ...d, puntos } : d)));
    setGuardando(dia);
    try {
      await setDia(
        dia,
        puntos.map((p) => p.id),
      );
    } catch (e) {
      notify.error("No se pudo guardar el día", (e as Error).message);
      await cargar();
    } finally {
      setGuardando(null);
    }
  };

  const puntosDe = (dia: DiaSemana) => grilla?.find((d) => d.dia === dia)?.puntos ?? [];

  const agregarAlDia = async (dia: DiaSemana, ids: string[]) => {
    const actuales = puntosDe(dia);
    const yaEstan = new Set(actuales.map((p) => p.id));
    // Agregar uno que ya está es un gesto sin efecto, no un error: en la
    // planilla una columna nunca repite un punto, y pasar dos veces el mismo
    // día por el mismo lugar no es algo que alguien quiera.
    const nuevos = (catalogo ?? [])
      .filter((z) => ids.includes(z.id) && !yaEstan.has(z.id))
      .map(comoPunto);
    if (nuevos.length === 0) return;
    await persistir(dia, [...actuales, ...nuevos]);
  };

  const quitarDelDia = async (dia: DiaSemana, id: string) => {
    await persistir(
      dia,
      puntosDe(dia).filter((p) => p.id !== id),
    );
  };

  /** Mueve un punto dentro de un día o lo trae desde otro.
   *
   *  `destino` es el índice donde cae; `-1` significa al final de la columna. */
  const soltar = async (dia: DiaSemana, id: string, destino: number) => {
    const actuales = puntosDe(dia);
    const desde = actuales.findIndex((p) => p.id === id);

    if (desde === -1) {
      const zona = (catalogo ?? []).find((z) => z.id === id);
      if (!zona) return;
      const lista = [...actuales];
      lista.splice(destino < 0 ? lista.length : destino, 0, comoPunto(zona));
      await persistir(dia, lista);
      return;
    }

    const lista = [...actuales];
    const [movido] = lista.splice(desde, 1);
    // El índice de destino se calculó sobre la lista ORIGINAL, así que sacar
    // el elemento primero lo corre un lugar cuando venía de más arriba.
    const ajustado = destino < 0 ? lista.length : destino > desde ? destino - 1 : destino;
    lista.splice(ajustado, 0, movido);
    await persistir(dia, lista);
  };

  const cargando = grilla === null || catalogo === null;

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Planificación</p>
          <h1 className="font-rubik text-2xl font-semibold text-foreground">Itinerario semanal</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Los puntos permanentes que toca visitar cada día. El orden dentro de cada columna es la
            secuencia del recorrido.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setEditando(null);
            setFormAbierto(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          Crear punto permanente
        </Button>
      </header>

      {cargando ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {DIAS.map((dia) => (
            <ColumnaDia
              key={dia}
              dia={dia}
              puntos={puntosDe(dia)}
              guardando={guardando === dia}
              onAgregar={() => setDiaAbierto(dia)}
              onQuitar={(id) => void quitarDelDia(dia, id)}
              onSoltar={(id, destino) => void soltar(dia, id, destino)}
              onEditar={(id) => {
                const z = (catalogo ?? []).find((c) => c.id === id);
                if (z) {
                  setEditando(z);
                  setFormAbierto(true);
                }
              }}
            />
          ))}
        </div>
      )}

      <CatalogoDialog
        open={diaAbierto !== null}
        onOpenChange={(abierto) => !abierto && setDiaAbierto(null)}
        dia={diaAbierto}
        catalogo={catalogo ?? []}
        yaEnElDia={new Set(diaAbierto ? puntosDe(diaAbierto).map((p) => p.id) : [])}
        onAgregar={async (ids) => {
          if (diaAbierto) await agregarAlDia(diaAbierto, ids);
          setDiaAbierto(null);
        }}
        onCrear={() => {
          setDiaAbierto(null);
          setEditando(null);
          setFormAbierto(true);
        }}
        onEditar={(z) => {
          setDiaAbierto(null);
          setEditando(z);
          setFormAbierto(true);
        }}
      />

      <PuntoPermanenteDialog
        open={formAbierto}
        onOpenChange={setFormAbierto}
        punto={editando}
        onGuardado={() => void cargar()}
      />
    </div>
  );
}

/** Una zona del catálogo vista como punto del día. Los campos son los mismos,
 *  el backend ya los devuelve así al leer la grilla. */
function comoPunto(z: ZoneRecord): PuntoDelDia {
  return {
    id: z.id,
    name: z.name,
    address: z.address ?? null,
    barrio: z.barrio ?? null,
    tipo: z.tipo ?? null,
    frecuencia: z.frecuencia ?? null,
    photoUrl: z.photoUrl ?? null,
    lat: z.lat ?? null,
    lng: z.lng ?? null,
    active: z.active,
  };
}

// =============================================================================
// UNA COLUMNA
// =============================================================================

function ColumnaDia({
  dia,
  puntos,
  guardando,
  onAgregar,
  onQuitar,
  onSoltar,
  onEditar,
}: {
  dia: DiaSemana;
  puntos: PuntoDelDia[];
  guardando: boolean;
  onAgregar: () => void;
  onQuitar: (id: string) => void;
  onSoltar: (id: string, destino: number) => void;
  onEditar: (id: string) => void;
}) {
  const [encima, setEncima] = useState(false);

  const aceptar = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(MIME)) return false;
    e.preventDefault();
    return true;
  };

  return (
    <section
      className={`panel flex min-h-[18rem] flex-col transition-colors ${
        encima ? "ring-2 ring-cta" : ""
      }`}
      onDragOver={(e) => {
        if (aceptar(e)) setEncima(true);
      }}
      onDragLeave={() => setEncima(false)}
      onDrop={(e) => {
        setEncima(false);
        if (!aceptar(e)) return;
        onSoltar(e.dataTransfer.getData(MIME), -1);
      }}
    >
      <header className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-foreground">{ROTULO_DIA[dia]}</h2>
          {guardando ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : (
            puntos.length > 0 && (
              <span className="mono text-[0.625rem] text-muted-foreground">{puntos.length}</span>
            )
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onAgregar}
          aria-label={`Agregar puntos al ${ROTULO_DIA[dia]}`}
          title={`Agregar puntos al ${ROTULO_DIA[dia]}`}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </header>

      <div className="flex flex-1 flex-col gap-2 p-3">
        {puntos.length === 0 ? (
          // AC5, literal.
          <p className="m-auto max-w-[14rem] text-center text-xs leading-relaxed text-muted-foreground">
            No hay puntos permanentes asociados
          </p>
        ) : (
          puntos.map((p, i) => (
            <TarjetaPunto
              key={p.id}
              punto={p}
              onDropAntes={(id) => onSoltar(id, i)}
              onQuitar={() => onQuitar(p.id)}
              onEditar={() => onEditar(p.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function TarjetaPunto({
  punto,
  onDropAntes,
  onQuitar,
  onEditar,
}: {
  punto: PuntoDelDia;
  onDropAntes: (id: string) => void;
  onQuitar: () => void;
  onEditar: () => void;
}) {
  const [encima, setEncima] = useState(false);

  return (
    <article
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(MIME, punto.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        setEncima(true);
      }}
      onDragLeave={() => setEncima(false)}
      onDrop={(e) => {
        setEncima(false);
        if (!e.dataTransfer.types.includes(MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        onDropAntes(e.dataTransfer.getData(MIME));
      }}
      className={`group cursor-grab rounded-md border bg-card/60 px-2.5 py-2 transition-colors active:cursor-grabbing ${
        encima ? "border-cta" : "border-border"
      } ${punto.active ? "" : "opacity-55"}`}
    >
      <div className="flex items-start justify-between gap-1.5">
        <p className="text-xs font-medium leading-snug text-foreground">{punto.name}</p>
        {/* Los dos controles aparecen al pasar el puntero, pero siguen
            existiendo para el teclado: `opacity-0` no los saca del foco, a
            diferencia de `hidden`. */}
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            onClick={onEditar}
            className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={`Editar ${punto.name}`}
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onQuitar}
            className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive-strong"
            aria-label={`Quitar ${punto.name} de este día`}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {punto.address && (
        <p className="mt-1 line-clamp-2 text-[0.625rem] leading-snug text-muted-foreground">
          {punto.address}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.625rem] text-muted-foreground">
        {punto.barrio && <span>{punto.barrio}</span>}
        {punto.tipo && <span className="text-primary">{punto.tipo}</span>}
        {!punto.active && <span className="text-warning-strong">Inactivo</span>}
        {punto.lat == null && (
          // Sin coordenada el punto no se puede dibujar ni meter en una ruta.
          // Se dice acá y no al guardar, porque es un estado del punto y no un
          // error de ese momento.
          <span className="flex items-center gap-0.5 text-warning-strong">
            <MapPin className="h-2.5 w-2.5" />
            Sin ubicar
          </span>
        )}
      </div>
    </article>
  );
}

// =============================================================================
// EL CATÁLOGO (AC1, AC2, AC3, AC4)
// =============================================================================

function CatalogoDialog({
  open,
  onOpenChange,
  dia,
  catalogo,
  yaEnElDia,
  onAgregar,
  onCrear,
  onEditar,
}: {
  open: boolean;
  onOpenChange: (abierto: boolean) => void;
  dia: DiaSemana | null;
  catalogo: ZoneRecord[];
  yaEnElDia: Set<string>;
  onAgregar: (ids: string[]) => Promise<void>;
  onCrear: () => void;
  onEditar: (z: ZoneRecord) => void;
}) {
  const [elegidos, setElegidos] = useState<Set<string>>(new Set());
  const [busqueda, setBusqueda] = useState("");

  useEffect(() => {
    if (open) {
      setElegidos(new Set());
      setBusqueda("");
    }
  }, [open]);

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return catalogo;
    return catalogo.filter(
      (z) =>
        z.name.toLowerCase().includes(q) ||
        (z.address ?? "").toLowerCase().includes(q) ||
        (z.barrio ?? "").toLowerCase().includes(q),
    );
  }, [catalogo, busqueda]);

  const alternar = (id: string) => {
    setElegidos((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Agregar puntos{dia ? ` al ${ROTULO_DIA[dia].toLowerCase()}` : ""}
          </DialogTitle>
          <DialogDescription>
            Elegí los puntos permanentes que se visitan ese día. Podés marcar varios.
          </DialogDescription>
        </DialogHeader>

        {catalogo.length === 0 ? (
          // AC2, literal.
          <div className="flex flex-col items-center gap-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">No se encontraron puntos permanentes</p>
            <Button onClick={onCrear}>
              <Plus className="mr-2 h-4 w-4" />
              Crear punto permanente
            </Button>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar por nombre, dirección o barrio"
                className="pl-8"
              />
            </div>

            <ul className="-mx-1 flex-1 space-y-1 overflow-y-auto px-1">
              {filtrados.length === 0 && (
                <li className="py-8 text-center text-xs text-muted-foreground">
                  Ningún punto coincide con la búsqueda.
                </li>
              )}
              {filtrados.map((z) => {
                const repetido = yaEnElDia.has(z.id);
                return (
                  <li
                    key={z.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(MIME, z.id);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    className={`flex items-center gap-3 rounded-md border border-border px-3 py-2 ${
                      repetido ? "opacity-50" : "cursor-grab hover:bg-accent"
                    }`}
                  >
                    <Checkbox
                      checked={elegidos.has(z.id)}
                      disabled={repetido}
                      onCheckedChange={() => alternar(z.id)}
                      aria-label={`Elegir ${z.name}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-foreground">{z.name}</p>
                      <p className="truncate text-[0.625rem] text-muted-foreground">
                        {[z.address, z.barrio, z.frecuencia].filter(Boolean).join(" · ") ||
                          "Sin dirección"}
                      </p>
                    </div>
                    {repetido && (
                      <span className="shrink-0 text-[0.625rem] text-muted-foreground">
                        Ya está
                      </span>
                    )}
                    {/* AC4: el botón de edición, en la esquina de cada punto. */}
                    <button
                      type="button"
                      onClick={() => onEditar(z)}
                      className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label={`Editar ${z.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>

            <DialogFooter className="sm:justify-between">
              <Button variant="ghost" onClick={onCrear}>
                <Plus className="mr-2 h-4 w-4" />
                Crear punto permanente
              </Button>
              <Button disabled={elegidos.size === 0} onClick={() => void onAgregar([...elegidos])}>
                Agregar {elegidos.size > 0 ? `(${elegidos.size})` : ""}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
