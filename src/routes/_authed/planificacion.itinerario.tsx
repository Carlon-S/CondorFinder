// =============================================================================
// CONDORFINDER, ITINERARIO SEMANAL (HDU14)
// Archivo: src/routes/_authed/planificacion.itinerario.tsx
//
// La grilla de LUNES a SÁBADO donde se reparten los puntos permanentes. Es la
// hoja `PERMANENTES` de la planilla municipal, que hoy mantienen a mano.
//
// ── Por qué parece un calendario y no una tabla ──
// Un itinerario semanal SE LEE como un calendario: columnas por día, tarjetas
// dentro, y el gesto de mover una tarjeta de un día a otro. Las referencias de
// las que sale este diseño (Google Calendar y similares) comparten tres cosas
// que acá sí aplican: cabecera de día destacada, color por categoría, y un
// panel lateral con la lista completa y sus filtros.
//
// Lo que NO se toma es el eje horario. Un punto permanente no tiene hora: lo
// que tiene es ORDEN de visita dentro del día, y por eso las tarjetas se
// apilan y se reordenan arrastrando, en vez de ubicarse contra una regla de
// horas que nadie llenaría.
//
// El color de la tarjeta sale del TIPO (Microbasural o VIRS), que es la
// categoría con la que la municipalidad clasifica sus puntos, no de una paleta
// decorativa.
//
// ── Dos formas de agregar, no una ──
// El AC1 pide textualmente el botón con signo de suma que abre un listado. Eso
// está, y además se puede arrastrar desde el panel lateral a una columna y
// reordenar dentro de ella. El arrastre no reemplaza al botón: la API nativa
// no funciona con el dedo ni con el teclado, y el `+` es el camino que sirve
// siempre.
//
// ── Sin dependencia de arrastre ──
// API nativa de HTML5 y no `@dnd-kit`, que son unos 30 kB para mover tarjetas
// entre listas. Este proyecto ya carga recharts y jsPDF de forma diferida
// justo para no engordar el paquete inicial.
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
import { deleteZone, listZones, type ZoneRecord } from "@/lib/analysisStore";
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
 *  con un id inventado.
 *
 *  El valor tiene la forma `"<diaDeOrigen>|<id>"`. El origen viaja porque la
 *  columna que recibe el soltar no tiene forma de saber de dónde salió el
 *  punto, y sin eso mover entre días lo dejaba en los dos. */
const MIME = "application/x-condorfinder-punto";

/** Color por TIPO, que es la categoría real de la municipalidad.
 *
 *  Literales y no variables del tema porque son categorías de datos, no roles
 *  de la interfaz: un microbasural no es "primario" ni "de advertencia". */
const COLOR_TIPO: Record<string, string> = {
  Microbasural: "#0ea5e9",
  VIRS: "#f97316",
};
const COLOR_SIN_TIPO = "#94a3b8";

function colorDe(tipo: string | null | undefined): string {
  return (tipo && COLOR_TIPO[tipo]) || COLOR_SIN_TIPO;
}

function ItinerarioPage() {
  const [grilla, setGrilla] = useState<DiaItinerario[] | null>(null);
  const [catalogo, setCatalogo] = useState<ZoneRecord[] | null>(null);
  const [guardando, setGuardando] = useState<DiaSemana | null>(null);

  const [diaAbierto, setDiaAbierto] = useState<DiaSemana | null>(null);
  const [editando, setEditando] = useState<ZoneRecord | null>(null);
  const [formAbierto, setFormAbierto] = useState(false);
  const [borrando, setBorrando] = useState<string | null>(null);

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

  const puntosDe = useCallback(
    (dia: DiaSemana) => grilla?.find((d) => d.dia === dia)?.puntos ?? [],
    [grilla],
  );

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

  const agregarAlDia = async (dia: DiaSemana, ids: string[]) => {
    const actuales = puntosDe(dia);
    const yaEstan = new Set(actuales.map((p) => p.id));
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

  /** Suelta un punto en un día. Ver el comentario de `MIME` sobre `carga`.
   *  `destino` es el índice donde cae; `-1` significa al final de la columna. */
  const soltar = async (dia: DiaSemana, carga: string, destino: number) => {
    const sep = carga.indexOf("|");
    const origen = (sep >= 0 ? carga.slice(0, sep) : "") as DiaSemana | "";
    const id = sep >= 0 ? carga.slice(sep + 1) : carga;

    // ── Dentro del mismo día: reordenar ──
    if (origen === dia) {
      const lista = [...puntosDe(dia)];
      const desde = lista.findIndex((p) => p.id === id);
      if (desde === -1) return;
      const [movido] = lista.splice(desde, 1);
      // El índice de destino se calculó sobre la lista ORIGINAL, así que sacar
      // el elemento primero lo corre un lugar cuando venía de más arriba.
      const ajustado = destino < 0 ? lista.length : destino > desde ? destino - 1 : destino;
      lista.splice(ajustado, 0, movido);
      await persistir(dia, lista);
      return;
    }

    const enDestino = puntosDe(dia);
    if (enDestino.some((p) => p.id === id)) {
      // Ya estaba en el destino, pero el gesto fue MOVER: igual hay que sacarlo
      // del origen, o queda en los dos lados.
      if (origen)
        await persistir(
          origen,
          puntosDe(origen).filter((p) => p.id !== id),
        );
      return;
    }

    const punto =
      (origen ? puntosDe(origen).find((p) => p.id === id) : undefined) ??
      (() => {
        const z = (catalogo ?? []).find((c) => c.id === id);
        return z ? comoPunto(z) : undefined;
      })();
    if (!punto) return;

    const lista = [...enDestino];
    lista.splice(destino < 0 ? lista.length : destino, 0, punto);

    // Las dos listas se calculan ANTES de persistir ninguna: `persistir`
    // actualiza el estado de forma optimista, y leer `puntosDe` entre las dos
    // llamadas devolvería lo que React todavía no aplicó.
    const listaOrigen = origen ? puntosDe(origen).filter((p) => p.id !== id) : null;

    await persistir(dia, lista);
    if (origen && listaOrigen) await persistir(origen, listaOrigen);
  };

  const eliminarPunto = async (z: ZoneRecord) => {
    setBorrando(z.id);
    try {
      await deleteZone(z.id);
      notify.success("Punto eliminado", z.name);
      await cargar();
    } catch (e) {
      notify.error("No se pudo eliminar", (e as Error).message);
    } finally {
      setBorrando(null);
    }
  };

  const abrirEdicion = (id: string) => {
    const z = (catalogo ?? []).find((c) => c.id === id);
    if (z) {
      setEditando(z);
      setFormAbierto(true);
    }
  };

  /** En cuántos días está cada punto. Es lo que deja contrastar el reparto
   *  contra la frecuencia declarada: un punto de "2 veces por semana" que
   *  aparece una sola vez está mal repartido, y hoy eso no se ve en ningún
   *  lado. */
  const diasPorPunto = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of grilla ?? []) {
      for (const p of d.puntos) m.set(p.id, (m.get(p.id) ?? 0) + 1);
    }
    return m;
  }, [grilla]);

  const totalAsignados = useMemo(
    () => (grilla ?? []).reduce((n, d) => n + d.puntos.length, 0),
    [grilla],
  );

  const cargando = grilla === null || catalogo === null;

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border/25 px-6 py-5">
        <div>
          <p className="eyebrow">Planificación</p>
          <h1 className="font-rubik text-3xl font-semibold tracking-normal text-foreground">
            Itinerario semanal
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Arrastra un punto del panel a un día, o usa el botón con el signo de suma de cada
            columna.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <dl className="flex items-center gap-5">
            <Resumen etiqueta="Puntos" valor={String(catalogo?.length ?? 0)} />
            <Resumen etiqueta="Visitas en la semana" valor={String(totalAsignados)} />
          </dl>
          <Button
            onClick={() => {
              setEditando(null);
              setFormAbierto(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Crear punto permanente
          </Button>
        </div>
      </header>

      {cargando ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        // Panel a la izquierda y calendario a la derecha, como en las
        // referencias. Bajo 80rem el panel pasa arriba a ancho completo: con
        // menos de eso, seis columnas y un panel no entran sin que las
        // columnas queden más angostas que una tarjeta.
        <main className="grid flex-1 gap-5 p-6 xl:grid-cols-[19rem_minmax(0,1fr)]">
          <PanelPuntos
            catalogo={catalogo ?? []}
            diasPorPunto={diasPorPunto}
            borrando={borrando}
            onEditar={(z) => {
              setEditando(z);
              setFormAbierto(true);
            }}
            onEliminar={eliminarPunto}
            onCrear={() => {
              setEditando(null);
              setFormAbierto(true);
            }}
          />

          <section className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
            {DIAS.map((dia) => (
              <ColumnaDia
                key={dia}
                dia={dia}
                puntos={puntosDe(dia)}
                guardando={guardando === dia}
                onAgregar={() => setDiaAbierto(dia)}
                onQuitar={(id) => void quitarDelDia(dia, id)}
                onSoltar={(carga, destino) => void soltar(dia, carga, destino)}
                onEditar={abrirEdicion}
              />
            ))}
          </section>
        </main>
      )}

      <CatalogoDialog
        open={diaAbierto !== null}
        onOpenChange={(abierto) => !abierto && setDiaAbierto(null)}
        dia={diaAbierto}
        catalogo={catalogo ?? []}
        yaEnElDia={diaAbierto ? puntosDe(diaAbierto).map((p) => p.id) : []}
        onConfirmar={async (ids) => {
          if (!diaAbierto) return;
          // Se manda la lista COMPLETA del día y no solo lo agregado: el
          // diálogo permite desmarcar lo que ya estaba, así que lo que vuelve
          // es el resultado, no un incremento.
          const actuales = puntosDe(diaAbierto);
          const elegidos = new Set(ids);
          const conservados = actuales.filter((p) => elegidos.has(p.id));
          const agregados = (catalogo ?? [])
            .filter((z) => elegidos.has(z.id) && !actuales.some((p) => p.id === z.id))
            .map(comoPunto);
          await persistir(diaAbierto, [...conservados, ...agregados]);
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

function Resumen({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div>
      <dt className="text-[0.5625rem] uppercase tracking-wide text-muted-foreground">{etiqueta}</dt>
      <dd className="mono text-lg font-semibold tabular-nums text-foreground">{valor}</dd>
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
// PANEL LATERAL: el listado de puntos permanentes
//
// Crear un punto no lo agrega a ningún día, así que sin este panel el catálogo
// solo era visible desde adentro del diálogo del `+`, o sea escondido detrás
// de un gesto que sirve para otra cosa. Acá se ve, se busca, se edita y se
// elimina, igual que la tabla de recursos.
//
// Y muestra en cuántos días está cada punto, que es lo que deja contrastar el
// reparto contra la frecuencia declarada.
// =============================================================================

function PanelPuntos({
  catalogo,
  diasPorPunto,
  borrando,
  onEditar,
  onEliminar,
  onCrear,
}: {
  catalogo: ZoneRecord[];
  diasPorPunto: Map<string, number>;
  borrando: string | null;
  onEditar: (z: ZoneRecord) => void;
  onEliminar: (z: ZoneRecord) => void;
  onCrear: () => void;
}) {
  const [busqueda, setBusqueda] = useState("");

  const filtrados = useMemo(() => filtrar(catalogo, busqueda), [catalogo, busqueda]);

  return (
    <aside className="panel flex max-h-[calc(100vh-11rem)] min-h-[20rem] flex-col xl:sticky xl:top-6">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium text-foreground">Puntos permanentes</h2>
        <p className="mt-0.5 text-[0.625rem] text-muted-foreground">
          Arrastra uno a un día para programarlo.
        </p>
      </header>

      {catalogo.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-xs text-muted-foreground">Todavía no hay puntos permanentes.</p>
          <Button size="sm" onClick={onCrear}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Crear el primero
          </Button>
        </div>
      ) : (
        <>
          <div className="relative px-4 py-3">
            <Search className="absolute left-6 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar punto"
              className="h-8 pl-7 text-xs"
            />
          </div>

          <ul className="flex-1 space-y-1.5 overflow-y-auto px-4 pb-4">
            {filtrados.length === 0 && (
              <li className="py-6 text-center text-[0.6875rem] text-muted-foreground">
                Ningún punto coincide.
              </li>
            )}
            {filtrados.map((z) => {
              const veces = diasPorPunto.get(z.id) ?? 0;
              return (
                <li
                  key={z.id}
                  draggable
                  onDragStart={(e) => {
                    // Sin día de origen: viene del panel, no de una columna.
                    e.dataTransfer.setData(MIME, `|${z.id}`);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  className={`group cursor-grab rounded-md border border-border bg-card/60 px-2.5 py-2 transition-colors hover:border-border/80 active:cursor-grabbing ${
                    borrando === z.id ? "pointer-events-none opacity-40" : ""
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span
                      aria-hidden="true"
                      className="mt-1 h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: colorDe(z.tipo) }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-foreground">{z.name}</p>
                      <p className="truncate text-[0.625rem] text-muted-foreground">
                        {z.address || "Sin dirección"}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => onEditar(z)}
                        className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label={`Editar ${z.name}`}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onEliminar(z)}
                        className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive-strong"
                        aria-label={`Eliminar ${z.name}`}
                      >
                        {borrando === z.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[0.5625rem] uppercase tracking-wide text-muted-foreground">
                    {z.frecuencia && <span>{z.frecuencia}</span>}
                    <span className={veces === 0 ? "text-warning-strong" : "text-primary"}>
                      {veces === 0 ? "Sin programar" : `${veces} día${veces === 1 ? "" : "s"}`}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </aside>
  );
}

function filtrar(lista: ZoneRecord[], busqueda: string): ZoneRecord[] {
  const q = busqueda.trim().toLowerCase();
  if (!q) return lista;
  return lista.filter(
    (z) =>
      z.name.toLowerCase().includes(q) ||
      (z.address ?? "").toLowerCase().includes(q) ||
      (z.barrio ?? "").toLowerCase().includes(q),
  );
}

// =============================================================================
// UNA COLUMNA DEL CALENDARIO
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
  /** `carga` es `"<diaDeOrigen>|<id>"`, vacío el origen si vino del panel. */
  onSoltar: (carga: string, destino: number) => void;
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
      className={`panel flex min-h-[22rem] flex-col transition-colors ${
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
      {/* Cabecera de día al estilo de un calendario: el rótulo pesa, y el
          contador va al lado como dato secundario. */}
      <header className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="font-rubik text-sm font-semibold text-foreground">{ROTULO_DIA[dia]}</h2>
          {guardando ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : (
            <span className="mono text-[0.625rem] text-muted-foreground">
              {puntos.length > 0 ? `${puntos.length} parada${puntos.length === 1 ? "" : "s"}` : ""}
            </span>
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

      <div className="flex flex-1 flex-col gap-2 p-2.5">
        {puntos.length === 0 ? (
          // AC5, literal.
          <p className="m-auto max-w-[13rem] text-center text-[0.6875rem] leading-relaxed text-muted-foreground">
            No hay puntos permanentes asociados
          </p>
        ) : (
          puntos.map((p, i) => (
            <TarjetaPunto
              key={p.id}
              punto={p}
              dia={dia}
              orden={i + 1}
              onDropAntes={(carga) => onSoltar(carga, i)}
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
  dia,
  orden,
  onDropAntes,
  onQuitar,
  onEditar,
}: {
  punto: PuntoDelDia;
  dia: DiaSemana;
  orden: number;
  onDropAntes: (carga: string) => void;
  onQuitar: () => void;
  onEditar: () => void;
}) {
  const [encima, setEncima] = useState(false);

  return (
    <article
      draggable
      onDragStart={(e) => {
        // El día de origen viaja junto al id: la columna que recibe el soltar
        // no tiene forma de saber de dónde salió, y sin eso mover entre
        // columnas deja el punto en las dos.
        e.dataTransfer.setData(MIME, `${dia}|${punto.id}`);
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
      // La barra de color a la izquierda es el gesto de las tarjetas de
      // calendario, y acá además dice el tipo de punto.
      className={`group cursor-grab rounded-md border border-l-[3px] bg-card px-2.5 py-2 transition-colors active:cursor-grabbing ${
        encima ? "border-cta" : "border-border"
      } ${punto.active ? "" : "opacity-55"}`}
      style={{ borderLeftColor: colorDe(punto.tipo) }}
    >
      <div className="flex items-start justify-between gap-1.5">
        <div className="flex min-w-0 items-start gap-1.5">
          <span className="mono mt-px shrink-0 text-[0.5625rem] text-muted-foreground">
            {orden}
          </span>
          <p className="min-w-0 text-xs font-medium leading-snug text-foreground">{punto.name}</p>
        </div>
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
        <p className="mt-1 line-clamp-2 pl-3.5 text-[0.625rem] leading-snug text-muted-foreground">
          {punto.address}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-3.5 text-[0.625rem] text-muted-foreground">
        {punto.barrio && <span>{punto.barrio}</span>}
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
// EL CATÁLOGO DEL BOTÓN "+" (AC1, AC2, AC3, AC4)
//
// Muestra el día COMPLETO, no solo lo que falta: los que ya están vienen
// marcados y se pueden desmarcar, así que este diálogo también sirve para
// sacar puntos de un día. Antes aparecían bloqueados con la leyenda "Ya está",
// y desmarcar uno obligaba a cerrar el diálogo y buscar su equis en la
// columna.
// =============================================================================

function CatalogoDialog({
  open,
  onOpenChange,
  dia,
  catalogo,
  yaEnElDia,
  onConfirmar,
  onCrear,
  onEditar,
}: {
  open: boolean;
  onOpenChange: (abierto: boolean) => void;
  dia: DiaSemana | null;
  catalogo: ZoneRecord[];
  yaEnElDia: string[];
  onConfirmar: (ids: string[]) => Promise<void>;
  onCrear: () => void;
  onEditar: (z: ZoneRecord) => void;
}) {
  const [elegidos, setElegidos] = useState<Set<string>>(new Set());
  const [busqueda, setBusqueda] = useState("");

  useEffect(() => {
    if (open) {
      setElegidos(new Set(yaEnElDia));
      setBusqueda("");
    }
    // `yaEnElDia` se recalcula en cada render de la anfitriona, así que
    // incluirlo acá reiniciaría la selección mientras la persona marca
    // casillas. Lo que importa es el momento de abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const filtrados = useMemo(() => filtrar(catalogo, busqueda), [catalogo, busqueda]);

  const alternar = (id: string) => {
    setElegidos((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  };

  // Seleccionar todos actúa sobre lo FILTRADO, no sobre el catálogo entero:
  // con un buscador arriba, "todos" significa lo que se está viendo. Marcar
  // 54 puntos invisibles sería lo contrario de lo que alguien espera.
  const todosFiltradosMarcados = filtrados.length > 0 && filtrados.every((z) => elegidos.has(z.id));

  const alternarTodos = () => {
    setElegidos((prev) => {
      const s = new Set(prev);
      for (const z of filtrados) {
        if (todosFiltradosMarcados) s.delete(z.id);
        else s.add(z.id);
      }
      return s;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Puntos del {dia ? ROTULO_DIA[dia].toLowerCase() : "día"}</DialogTitle>
          <DialogDescription>
            Marca los puntos que se visitan ese día y desmarca los que no.
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
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  placeholder="Buscar por nombre, dirección o barrio"
                  className="pl-8"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={alternarTodos}
                disabled={filtrados.length === 0}
              >
                {todosFiltradosMarcados ? "Ninguno" : "Todos"}
              </Button>
            </div>

            <p className="text-[0.625rem] text-muted-foreground">
              {elegidos.size} de {catalogo.length} marcados
              {busqueda && ` · ${filtrados.length} coinciden con la búsqueda`}
            </p>

            <ul className="-mx-1 flex-1 space-y-1 overflow-y-auto px-1">
              {filtrados.length === 0 && (
                <li className="py-8 text-center text-xs text-muted-foreground">
                  Ningún punto coincide con la búsqueda.
                </li>
              )}
              {filtrados.map((z) => (
                <li
                  key={z.id}
                  className="flex items-center gap-3 rounded-md border border-border px-3 py-2 hover:bg-accent"
                >
                  <Checkbox
                    checked={elegidos.has(z.id)}
                    onCheckedChange={() => alternar(z.id)}
                    aria-label={`Elegir ${z.name}`}
                  />
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: colorDe(z.tipo) }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">{z.name}</p>
                    <p className="truncate text-[0.625rem] text-muted-foreground">
                      {[z.address, z.barrio, z.frecuencia].filter(Boolean).join(" · ") ||
                        "Sin dirección"}
                    </p>
                  </div>
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
              ))}
            </ul>

            <DialogFooter className="sm:justify-between">
              <Button variant="ghost" onClick={onCrear}>
                <Plus className="mr-2 h-4 w-4" />
                Crear punto permanente
              </Button>
              <Button onClick={() => void onConfirmar([...elegidos])}>Guardar día</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
