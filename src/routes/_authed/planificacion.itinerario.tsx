// =============================================================================
// CONDORFINDER, ITINERARIO SEMANAL (HDU14)
// Archivo: src/routes/_authed/planificacion.itinerario.tsx
//
// La grilla de LUNES a SÁBADO donde se reparten los puntos permanentes. Es la
// hoja `PERMANENTES` de la planilla municipal, que hoy mantienen a mano.
//
// ── Una sola grilla, no seis tarjetas ──
// Las columnas estuvieron como seis paneles independientes y se revirtió: un
// calendario se lee como UNA superficie continua con divisiones, no como seis
// objetos puestos uno al lado del otro. Con tarjetas separadas, el ojo cuenta
// seis cosas antes de ver una semana. Ahora es un solo marco con una fila de
// cabeceras arriba y líneas divisorias entre columnas.
//
// Lo que NO se toma de las referencias es el eje horario. Un punto permanente
// no tiene hora: tiene ORDEN de visita, y por eso las tarjetas se apilan y se
// reordenan arrastrando, en vez de ubicarse contra una regla de horas que
// nadie llenaría.
//
// ── El pasado no se planifica ──
// Un día terminado es el registro de lo que se hizo, no un plan. Los días
// pasados se dibujan atenuados, sin `+` y sin arrastre, y el backend además lo
// rechaza: una pestaña abierta desde ayer sigue teniendo botones vivos.
//
// ── Dos formas de agregar, no una ──
// El AC1 pide textualmente el botón con signo de suma que abre un listado. Eso
// está, y además se puede arrastrar desde la tabla del pie. El arrastre no
// reemplaza al botón: la API nativa no funciona con el dedo ni con el teclado.
//
// ── El orden es dato, no presentación ──
// La posición dentro de la columna es la secuencia del recorrido, así que cada
// gesto persiste la lista completa del día.
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft,
  ImageIcon,
  Layers,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "@/components/icons/Icons";
import { notify } from "@/lib/notify";
import { PuntoPermanenteDialog } from "@/components/PuntoPermanenteDialog";
import { ConfirmarBorrado } from "@/components/ConfirmarBorrado";
import { deleteZone, listZones, type ZoneRecord } from "@/lib/analysisStore";
import {
  DIAS,
  ROTULO_DIA,
  copiarSemana,
  getItinerario,
  lunesDe,
  semanaDe,
  setDia,
  yaPaso,
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

const MESES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** Filas por página de la tabla del pie. Fija y no "lo que entre": con una
 *  cantidad variable la tabla cambia de alto al filtrar, y el resto de la
 *  página salta. Mismo criterio que la tabla de recursos. */
const POR_PAGINA = 6;

function ItinerarioPage() {
  /** El lunes de la semana que se está mirando. Se guarda la FECHA y no el
   *  texto de la semana porque de ella salen también los números de cada
   *  columna y el mes que resalta el calendario chico. */
  const [lunes, setLunes] = useState(() => lunesDe(new Date()));
  const semana = useMemo(() => semanaDe(lunes), [lunes]);
  const semanaDeHoy = useMemo(() => semanaDe(new Date()), []);

  const [grilla, setGrilla] = useState<DiaItinerario[] | null>(null);
  const [catalogo, setCatalogo] = useState<ZoneRecord[] | null>(null);
  const [guardando, setGuardando] = useState<DiaSemana | null>(null);
  const [copiando, setCopiando] = useState(false);

  const [diaAbierto, setDiaAbierto] = useState<DiaSemana | null>(null);
  const [editando, setEditando] = useState<ZoneRecord | null>(null);
  const [formAbierto, setFormAbierto] = useState(false);
  const [aBorrar, setABorrar] = useState<ZoneRecord | null>(null);
  const [confirmarCopia, setConfirmarCopia] = useState(false);
  /** El reparto de la semana anterior, traído al abrir la confirmación.
   *  `null` mientras carga. Confirmar un reemplazo sin ver con qué se
   *  reemplaza es pedir un sí a ciegas. */
  const [previaCopia, setPreviaCopia] = useState<DiaItinerario[] | null>(null);

  const cargar = useCallback(async () => {
    try {
      const [g, zonas] = await Promise.all([getItinerario(semana), listZones()]);
      setGrilla(g);
      setCatalogo(zonas.filter((z) => z.kind === "permanente"));
    } catch (e) {
      notify.error("No se pudo cargar el itinerario", (e as Error).message);
      setGrilla([]);
      setCatalogo([]);
    }
  }, [semana]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const fechaDe = useCallback(
    (i: number) => {
      const d = new Date(lunes);
      d.setDate(d.getDate() + i);
      return d;
    },
    [lunes],
  );

  /** La semana entera terminó cuando su sábado quedó atrás. */
  const semanaCerrada = useMemo(() => yaPaso(fechaDe(5)), [fechaDe]);

  const puntosDe = useCallback(
    (dia: DiaSemana) => grilla?.find((d) => d.dia === dia)?.puntos ?? [],
    [grilla],
  );

  /** Pinta uno o más días en pantalla y después los manda al servidor.
   *
   *  **La pintura va primero y para TODOS los días del gesto.** Antes se
   *  persistía el destino, se esperaba la respuesta y recién entonces se
   *  tocaba el origen, así que al mover una tarjeta de lunes a miércoles
   *  aparecía en los dos hasta que volviera la red.
   *
   *  Si el servidor rechaza, se recarga todo: revertir solo una columna
   *  dejaría el resto de la grilla con lo que el servidor ya no tiene. */
  const persistir = async (cambios: Array<{ dia: DiaSemana; puntos: PuntoDelDia[] }>) => {
    setGrilla((prev) =>
      (prev ?? []).map((d) => {
        const cambio = cambios.find((c) => c.dia === d.dia);
        return cambio ? { ...d, puntos: cambio.puntos } : d;
      }),
    );
    setGuardando(cambios[0]?.dia ?? null);
    try {
      for (const c of cambios) {
        await setDia(
          c.dia,
          c.puntos.map((p) => p.id),
          semana,
        );
      }
    } catch (e) {
      notify.error("No se pudo guardar el día", (e as Error).message);
      await cargar();
    } finally {
      setGuardando(null);
    }
  };

  const quitarDelDia = (dia: DiaSemana, id: string) =>
    persistir([{ dia, puntos: puntosDe(dia).filter((p) => p.id !== id) }]);

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
      await persistir([{ dia, puntos: lista }]);
      return;
    }

    const enDestino = puntosDe(dia);
    const sacarDelOrigen = origen
      ? [{ dia: origen, puntos: puntosDe(origen).filter((p) => p.id !== id) }]
      : [];

    if (enDestino.some((p) => p.id === id)) {
      // Ya estaba en el destino, pero el gesto fue MOVER: igual hay que
      // sacarlo del origen, o queda en los dos lados.
      if (sacarDelOrigen.length) await persistir(sacarDelOrigen);
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
    await persistir([{ dia, puntos: lista }, ...sacarDelOrigen]);
  };

  const abrirEdicion = (id: string) => {
    const z = (catalogo ?? []).find((c) => c.id === id);
    if (z) {
      setEditando(z);
      setFormAbierto(true);
    }
  };

  const lunesAnterior = useCallback(() => {
    const d = new Date(lunes);
    d.setDate(d.getDate() - 7);
    return d;
  }, [lunes]);

  const pedirCopia = async () => {
    setPreviaCopia(null);
    setConfirmarCopia(true);
    try {
      setPreviaCopia(await getItinerario(semanaDe(lunesAnterior())));
    } catch {
      // Sin la previa el diálogo igual sirve: dice qué se pierde, aunque no
      // qué llega. Es mejor que bloquear la acción por una consulta caída.
      setPreviaCopia([]);
    }
  };

  const copiarAnterior = async () => {
    setCopiando(true);
    try {
      setGrilla(await copiarSemana(semanaDe(lunesAnterior()), semana));
      notify.success("Semana copiada", "Se trajo el reparto de la semana anterior.");
    } catch (e) {
      notify.error("No se pudo copiar", (e as Error).message);
    } finally {
      setCopiando(false);
    }
  };

  /** En cuántos días de ESTA semana está cada punto. Es lo que deja contrastar
   *  el reparto contra la frecuencia declarada: un punto de "2 veces por
   *  semana" que aparece una sola vez está mal repartido. */
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
  const hoyISO = new Date().toDateString();
  const fin = fechaDe(5);

  const moverSemana = (semanas: number) => {
    const d = new Date(lunes);
    d.setDate(d.getDate() + semanas * 7);
    setLunes(d);
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border/25 px-6 py-5">
        <div>
          <p className="eyebrow">Planificación</p>
          <h1 className="font-rubik text-3xl font-semibold tracking-normal text-foreground">
            Itinerario semanal
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Arrastra un punto de la tabla a un día, o usa el botón con el signo de suma de cada
            columna.
          </p>
        </div>
        <dl className="flex items-center gap-5">
          <Resumen etiqueta="Puntos" valor={String(catalogo?.length ?? 0)} />
          <Resumen etiqueta="Visitas esta semana" valor={String(totalAsignados)} />
        </dl>
      </header>

      {cargando ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <main className="flex flex-1 flex-col gap-5 p-6">
          {/* Barra de semana: flechas, rango y número, y a la derecha la acción
              principal. Es el patrón de cualquier calendario y va ARRIBA de la
              grilla, no adentro de ella. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => moverSemana(-1)}
                  className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label="Semana anterior"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => moverSemana(1)}
                  className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label="Semana siguiente"
                >
                  <ArrowLeft className="h-4 w-4 rotate-180" />
                </button>
              </div>
              <h2 className="font-rubik text-xl font-semibold text-foreground">
                {lunes.getDate()} {MESES[lunes.getMonth()]}
                {lunes.getMonth() !== fin.getMonth() ? "" : ""} - {fin.getDate()}{" "}
                {MESES[fin.getMonth()]}, {fin.getFullYear()}
              </h2>
              <span className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
                Semana {semana.slice(6)}
              </span>
              {semanaCerrada && (
                <span className="rounded-full bg-muted px-3 py-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  Cerrada
                </span>
              )}
            </div>

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

          {/* El mes chico gana ancho y la semana lo cede: el mes tenía los
              números apretados en 16rem y la semana sobraba de espacio
              horizontal con poco alto. Las dos columnas comparten alto. */}
          <div className="grid items-stretch gap-5 xl:grid-cols-[21rem_minmax(0,1fr)]">
            <MesChico
              lunes={lunes}
              onElegirSemana={setLunes}
              onCopiarAnterior={pedirCopia}
              copiando={copiando}
              semanaCerrada={semanaCerrada}
              esSemanaActual={semana === semanaDeHoy}
              onHoy={() => setLunes(lunesDe(new Date()))}
            />

            <CalendarioSemanal
              fechaDe={fechaDe}
              hoyISO={hoyISO}
              puntosDe={puntosDe}
              guardando={guardando}
              onAgregar={setDiaAbierto}
              onQuitar={(dia, id) => void quitarDelDia(dia, id)}
              onSoltar={(dia, carga, destino) => void soltar(dia, carga, destino)}
              onEditar={abrirEdicion}
            />
          </div>

          <TablaPuntos
            catalogo={catalogo ?? []}
            diasPorPunto={diasPorPunto}
            onEditar={(z) => {
              setEditando(z);
              setFormAbierto(true);
            }}
            onEliminar={setABorrar}
          />
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
          await persistir([{ dia: diaAbierto, puntos: [...conservados, ...agregados] }]);
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

      {/* Copiar REEMPLAZA el reparto de la semana, así que puede borrar
          trabajo ya hecho. Se reusa el mismo diálogo de confirmación: el gesto
          es el mismo, perder algo que no se puede recuperar. */}
      <ConfirmarBorrado
        abierto={confirmarCopia}
        onOpenChange={setConfirmarCopia}
        titulo="Copiar la semana anterior"
        descripcion={<DetalleCopia previa={previaCopia} enEstaSemana={totalAsignados} />}
        etiquetaConfirmar="Copiar"
        onConfirmar={copiarAnterior}
      />

      <ConfirmarBorrado
        abierto={aBorrar !== null}
        onOpenChange={(abierto) => !abierto && setABorrar(null)}
        titulo="Eliminar punto permanente"
        descripcion={
          aBorrar ? `Se eliminará "${aBorrar.name}" del sistema. Esto no se puede deshacer.` : ""
        }
        onConfirmar={async () => {
          if (!aBorrar) return;
          try {
            await deleteZone(aBorrar.id);
            notify.success("Punto eliminado", aBorrar.name);
            await cargar();
          } catch (e) {
            // El backend se niega si el punto está programado en algún día, y
            // ese mensaje dice en cuántos.
            notify.error("No se pudo eliminar", (e as Error).message);
          }
        }}
      />
    </div>
  );
}

/** Qué llega y qué se pierde al copiar.
 *
 *  Un "esto no se puede deshacer" sin decir con qué se reemplaza obliga a
 *  confirmar a ciegas. Acá se ve el reparto que viene, día por día. */
function DetalleCopia({
  previa,
  enEstaSemana,
}: {
  previa: DiaItinerario[] | null;
  enEstaSemana: number;
}) {
  if (previa === null) {
    return (
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Leyendo la semana anterior...
      </span>
    );
  }

  const total = previa.reduce((n, d) => n + d.puntos.length, 0);

  return (
    <span className="block space-y-3">
      {enEstaSemana > 0 && (
        <span className="block text-xs text-warning-strong">
          Esta semana tiene {enEstaSemana} visita{enEstaSemana === 1 ? "" : "s"} programada
          {enEstaSemana === 1 ? "" : "s"}. Se reemplazan y no se pueden recuperar.
        </span>
      )}

      {total === 0 ? (
        <span className="block text-xs text-muted-foreground">
          La semana anterior no tiene ningún punto programado, así que esta quedaría vacía.
        </span>
      ) : (
        <>
          <span className="block text-xs text-muted-foreground">
            Llegan {total} visita{total === 1 ? "" : "s"} desde la semana anterior:
          </span>
          <span className="block space-y-0.5 rounded-md border border-border bg-muted/40 p-2">
            {previa.map((d) => (
              <span key={d.dia} className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-muted-foreground">{ROTULO_DIA[d.dia]}</span>
                <span
                  className={`mono tabular-nums ${d.puntos.length ? "text-foreground" : "text-muted-foreground/50"}`}
                >
                  {d.puntos.length === 0
                    ? "-"
                    : `${d.puntos.length} parada${d.puntos.length === 1 ? "" : "s"}`}
                </span>
              </span>
            ))}
          </span>
        </>
      )}
    </span>
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
// EL CALENDARIO SEMANAL: UNA grilla, no seis tarjetas
// =============================================================================

function CalendarioSemanal({
  fechaDe,
  hoyISO,
  puntosDe,
  guardando,
  onAgregar,
  onQuitar,
  onSoltar,
  onEditar,
}: {
  fechaDe: (i: number) => Date;
  hoyISO: string;
  puntosDe: (dia: DiaSemana) => PuntoDelDia[];
  guardando: DiaSemana | null;
  onAgregar: (dia: DiaSemana) => void;
  onQuitar: (dia: DiaSemana, id: string) => void;
  onSoltar: (dia: DiaSemana, carga: string, destino: number) => void;
  onEditar: (id: string) => void;
}) {
  return (
    // Un solo marco, con las columnas separadas por divisores internos en vez
    // de por el aire entre tarjetas. `overflow-hidden` es lo que recorta las
    // cabeceras contra el radio del marco.
    <section className="panel flex min-h-[32rem] flex-col overflow-hidden">
      <div className="grid flex-1 grid-cols-2 divide-x divide-border sm:grid-cols-3 2xl:grid-cols-6">
        {DIAS.map((dia, i) => (
          <ColumnaDia
            key={dia}
            dia={dia}
            fecha={fechaDe(i)}
            esHoy={fechaDe(i).toDateString() === hoyISO}
            pasado={yaPaso(fechaDe(i))}
            puntos={puntosDe(dia)}
            guardando={guardando === dia}
            onAgregar={() => onAgregar(dia)}
            onQuitar={(id) => onQuitar(dia, id)}
            onSoltar={(carga, destino) => onSoltar(dia, carga, destino)}
            onEditar={onEditar}
          />
        ))}
      </div>
    </section>
  );
}

function ColumnaDia({
  dia,
  fecha,
  esHoy,
  pasado,
  puntos,
  guardando,
  onAgregar,
  onQuitar,
  onSoltar,
  onEditar,
}: {
  dia: DiaSemana;
  fecha: Date;
  esHoy: boolean;
  pasado: boolean;
  puntos: PuntoDelDia[];
  guardando: boolean;
  onAgregar: () => void;
  onQuitar: (id: string) => void;
  /** `carga` es `"<diaDeOrigen>|<id>"`, vacío el origen si vino de la tabla. */
  onSoltar: (carga: string, destino: number) => void;
  onEditar: (id: string) => void;
}) {
  const [encima, setEncima] = useState(false);

  const aceptar = (e: React.DragEvent) => {
    // Un día que pasó no recibe nada. La vista lo impide acá y el backend lo
    // vuelve a rechazar: esto solo evita el gesto, no lo garantiza.
    if (pasado || !e.dataTransfer.types.includes(MIME)) return false;
    e.preventDefault();
    return true;
  };

  return (
    <div
      className={`flex min-w-0 flex-col transition-colors ${
        encima ? "bg-cta/10" : pasado ? "bg-muted/30" : ""
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
      {/* Cabecera al estilo de un calendario: el día arriba en versales y el
          número abajo grande, que es como se lee una semana. */}
      <header
        className={`border-b px-2.5 py-2 ${
          esHoy ? "border-cta bg-cta/10" : "border-border bg-muted/40"
        }`}
      >
        <div className="flex items-start justify-between gap-1">
          <div className={pasado ? "opacity-50" : ""}>
            <p className="text-[0.5625rem] uppercase tracking-wide text-muted-foreground">
              {ROTULO_DIA[dia]}
            </p>
            <p className="mono text-xl font-semibold leading-none tabular-nums text-foreground">
              {fecha.getDate()}
            </p>
          </div>
          {/* Un día pasado no ofrece el `+`: un botón que el servidor va a
              rechazar es peor que ninguno. */}
          {!pasado && (
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
          )}
        </div>
        <p className="mt-0.5 flex h-3 items-center text-[0.5625rem] text-muted-foreground">
          {guardando ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : puntos.length > 0 ? (
            `${puntos.length} parada${puntos.length === 1 ? "" : "s"}`
          ) : (
            ""
          )}
        </p>
      </header>

      <div className="flex flex-1 flex-col gap-1.5 p-2">
        {puntos.length === 0 ? (
          // AC5, literal.
          <p className="m-auto max-w-[11rem] text-center text-[0.625rem] leading-relaxed text-muted-foreground">
            No hay puntos permanentes asociados
          </p>
        ) : (
          puntos.map((p, i) => (
            <TarjetaPunto
              key={p.id}
              punto={p}
              dia={dia}
              orden={i + 1}
              pasado={pasado}
              onDropAntes={(carga) => onSoltar(carga, i)}
              onQuitar={() => onQuitar(p.id)}
              onEditar={() => onEditar(p.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TarjetaPunto({
  punto,
  dia,
  orden,
  pasado,
  onDropAntes,
  onQuitar,
  onEditar,
}: {
  punto: PuntoDelDia;
  dia: DiaSemana;
  orden: number;
  pasado: boolean;
  onDropAntes: (carga: string) => void;
  onQuitar: () => void;
  onEditar: () => void;
}) {
  const [encima, setEncima] = useState(false);

  return (
    <article
      draggable={!pasado}
      onDragStart={(e) => {
        e.dataTransfer.setData(MIME, `${dia}|${punto.id}`);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (pasado || !e.dataTransfer.types.includes(MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        setEncima(true);
      }}
      onDragLeave={() => setEncima(false)}
      onDrop={(e) => {
        setEncima(false);
        if (pasado || !e.dataTransfer.types.includes(MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        onDropAntes(e.dataTransfer.getData(MIME));
      }}
      // La barra de color a la izquierda es el gesto de las tarjetas de
      // calendario, y acá además dice el tipo de punto.
      className={`group rounded border border-l-[3px] bg-card px-2 py-1.5 transition-colors ${
        encima ? "border-cta" : "border-border"
      } ${pasado ? "opacity-60" : "cursor-grab active:cursor-grabbing"} ${
        punto.active ? "" : "opacity-55"
      }`}
      style={{ borderLeftColor: colorDe(punto.tipo) }}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="flex min-w-0 items-start gap-1">
          <span className="mono mt-px shrink-0 text-[0.5625rem] text-muted-foreground">
            {orden}
          </span>
          <p className="min-w-0 text-[0.6875rem] font-medium leading-snug text-foreground">
            {punto.name}
          </p>
        </div>
        {/* Los controles aparecen al pasar el puntero, pero siguen existiendo
            para el teclado: `opacity-0` no los saca del foco, a diferencia de
            `hidden`. En un día pasado no existen. */}
        {!pasado && (
          <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              onClick={onEditar}
              className="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={`Editar ${punto.name}`}
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={onQuitar}
              className="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive-strong"
              aria-label={`Quitar ${punto.name} de este día`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>

      {punto.address && (
        <p className="mt-0.5 line-clamp-2 pl-3 text-[0.5625rem] leading-snug text-muted-foreground">
          {punto.address}
        </p>
      )}
      {punto.lat == null && (
        <span className="mt-0.5 flex items-center gap-0.5 pl-3 text-[0.5625rem] text-warning-strong">
          <MapPin className="h-2.5 w-2.5" />
          Sin ubicar
        </span>
      )}
    </article>
  );
}

// =============================================================================
// EL MES CHICO: elegir qué semana se planifica
// =============================================================================

function MesChico({
  lunes,
  onElegirSemana,
  onCopiarAnterior,
  copiando,
  semanaCerrada,
  esSemanaActual,
  onHoy,
}: {
  lunes: Date;
  onElegirSemana: (lunes: Date) => void;
  onCopiarAnterior: () => void;
  copiando: boolean;
  semanaCerrada: boolean;
  esSemanaActual: boolean;
  onHoy: () => void;
}) {
  /** El mes que se está mirando, que no tiene por qué ser el de la semana
   *  elegida: se puede hojear noviembre con la semana de octubre cargada. */
  const [mes, setMes] = useState(() => new Date(lunes.getFullYear(), lunes.getMonth(), 1));

  const celdas = useMemo(() => {
    // La grilla arranca el lunes de la semana del día 1 y termina el domingo
    // de la del último, así que siempre son semanas completas y cada fila es
    // una semana que se puede elegir entera.
    const primero = new Date(mes.getFullYear(), mes.getMonth(), 1);
    const inicio = lunesDe(primero);
    const ultimo = new Date(mes.getFullYear(), mes.getMonth() + 1, 0);
    const dias: Date[] = [];
    for (
      let d = new Date(inicio);
      d <= ultimo || dias.length % 7 !== 0;
      d.setDate(d.getDate() + 1)
    ) {
      dias.push(new Date(d));
    }
    return dias;
  }, [mes]);

  const lunesElegido = lunes.toDateString();
  const hoy = new Date().toDateString();

  const fin = new Date(lunes);
  fin.setDate(fin.getDate() + 5);

  return (
    <aside className="panel flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <span className="text-base font-medium capitalize text-foreground">
          {MESES[mes.getMonth()]} {mes.getFullYear()}
        </span>
        <div className="flex gap-0.5">
          <button
            type="button"
            onClick={() => setMes(new Date(mes.getFullYear(), mes.getMonth() - 1, 1))}
            className="cursor-pointer rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Mes anterior"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setMes(new Date(mes.getFullYear(), mes.getMonth() + 1, 1))}
            className="cursor-pointer rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Mes siguiente"
          >
            <ArrowLeft className="h-4 w-4 rotate-180" />
          </button>
        </div>
      </div>

      <div>
        <div className="grid grid-cols-7 gap-1 text-center">
          {["L", "M", "M", "J", "V", "S", "D"].map((d, i) => (
            <span key={i} className="text-[0.625rem] uppercase text-muted-foreground">
              {d}
            </span>
          ))}
        </div>
        {/* Se elige la SEMANA, no el día: cualquier celda carga su semana
            completa, porque es la unidad que se planifica. */}
        <div className="mt-1.5 grid grid-cols-7 gap-1">
          {celdas.map((d) => {
            const suLunes = lunesDe(d).toDateString();
            const enLaSemana = suLunes === lunesElegido;
            const otroMes = d.getMonth() !== mes.getMonth();
            return (
              <button
                key={d.toISOString()}
                type="button"
                onClick={() => onElegirSemana(lunesDe(d))}
                className={`cursor-pointer rounded py-1.5 text-xs tabular-nums transition-colors ${
                  enLaSemana
                    ? "bg-primary/15 font-semibold text-primary"
                    : otroMes
                      ? "text-muted-foreground/40 hover:bg-accent"
                      : "text-foreground hover:bg-accent"
                } ${d.toDateString() === hoy ? "ring-1 ring-cta" : ""}`}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-t border-border pt-3">
        <p className="text-[0.5625rem] uppercase tracking-wide text-muted-foreground">
          Semana cargada
        </p>
        <p className="mono mt-0.5 text-sm text-foreground">
          {lunes.getDate()} {MESES[lunes.getMonth()].slice(0, 3)} al {fin.getDate()}{" "}
          {MESES[fin.getMonth()].slice(0, 3)}
        </p>
      </div>

      {/* El aire de abajo empuja los botones al pie, que es lo que hace que
          esta tarjeta mida lo mismo que el calendario de al lado sin fijarle
          una altura a mano. */}
      <div className="mt-auto flex flex-col gap-2">
        {!esSemanaActual && (
          <Button variant="outline" size="sm" onClick={onHoy}>
            Ir a la semana actual
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={onCopiarAnterior}
          disabled={copiando || semanaCerrada}
          title={semanaCerrada ? "Esa semana ya terminó y no se puede planificar" : undefined}
        >
          {copiando ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Layers className="mr-1.5 h-3.5 w-3.5" />
          )}
          Copiar semana anterior
        </Button>
        <p className="text-[0.5625rem] leading-relaxed text-muted-foreground">
          {semanaCerrada
            ? "Esta semana ya terminó. Solo se puede planificar desde hoy en adelante."
            : "Reemplaza el reparto de esta semana con el de la anterior."}
        </p>
      </div>
    </aside>
  );
}

// =============================================================================
// LA TABLA DEL PIE: todos los puntos permanentes, con todos sus campos
//
// Es una TABLA y no una lista, y va a lo ancho, porque un punto se compara con
// otro por sus campos: dirección, barrio, tipo y frecuencia en columnas
// alineadas se leen de un vistazo, apilados en tarjetas no. Mismo criterio y
// mismo tratamiento que la tabla de recursos, paginación incluida.
// =============================================================================

function TablaPuntos({
  catalogo,
  diasPorPunto,
  onEditar,
  onEliminar,
}: {
  catalogo: ZoneRecord[];
  diasPorPunto: Map<string, number>;
  onEditar: (z: ZoneRecord) => void;
  onEliminar: (z: ZoneRecord) => void;
}) {
  const [busqueda, setBusqueda] = useState("");
  const [pagina, setPagina] = useState(0);

  const filtrados = useMemo(() => filtrar(catalogo, busqueda), [catalogo, busqueda]);
  const paginas = Math.max(1, Math.ceil(filtrados.length / POR_PAGINA));

  // Filtrar puede dejar la página actual fuera de rango. Se corrige al
  // calcular y no con un efecto, que provocaría un render de más.
  const paginaActual = Math.min(pagina, paginas - 1);
  const visibles = filtrados.slice(paginaActual * POR_PAGINA, (paginaActual + 1) * POR_PAGINA);

  // Alto fijo: la tabla no cambia de tamaño al filtrar ni al cambiar de
  // página, así que nada de lo que está alrededor salta.
  const relleno = POR_PAGINA - visibles.length;

  return (
    <section className="panel flex flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Puntos permanentes</h2>
          <p className="mt-0.5 text-[0.625rem] text-muted-foreground">
            Arrastra una fila a un día para programarla.
          </p>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={busqueda}
            onChange={(e) => {
              setBusqueda(e.target.value);
              setPagina(0);
            }}
            placeholder="Buscar punto"
            className="h-8 w-56 pl-8 text-xs"
          />
        </div>
      </header>

      {catalogo.length === 0 ? (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          Todavía no hay puntos permanentes.
        </p>
      ) : (
        <>
          <div className="px-4 pb-2 pt-2">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="w-[5.5rem]">Mapa</TableHead>
                  <TableHead>Nombre</TableHead>
                  <TableHead className="hidden md:table-cell">Dirección</TableHead>
                  <TableHead className="hidden lg:table-cell">Barrio</TableHead>
                  <TableHead className="hidden lg:table-cell">Tipo</TableHead>
                  <TableHead className="hidden xl:table-cell">Frecuencia</TableHead>
                  <TableHead className="text-right">En la semana</TableHead>
                  <TableHead className="w-[4.5rem]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibles.map((z) => {
                  const veces = diasPorPunto.get(z.id) ?? 0;
                  return (
                    <TableRow
                      key={z.id}
                      draggable
                      onDragStart={(e) => {
                        // Sin día de origen: viene de la tabla, no de una columna.
                        e.dataTransfer.setData(MIME, `|${z.id}`);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      className="cursor-grab active:cursor-grabbing"
                    >
                      <TableCell>
                        {/* La imagen del lugar es su MAPA UNIFICADO, no una
                            foto subida a mano. La columna existe aunque
                            todavía no haya vuelo: el hueco dice que falta
                            volarlo, que es información. */}
                        {z.thumbnailUrl ? (
                          <div className="detect-frame detect-frame-sm h-10 w-16 overflow-hidden rounded bg-muted">
                            <span className="detect-corners" aria-hidden="true" />
                            <img
                              src={z.thumbnailUrl}
                              alt={`Mapa de ${z.name}`}
                              className="h-full w-full object-cover"
                            />
                          </div>
                        ) : (
                          <div
                            className="flex h-10 w-16 items-center justify-center rounded border border-dashed border-border/60 bg-background/30"
                            title="Todavía no se le ha volado el dron"
                          >
                            <ImageIcon className="h-3.5 w-3.5 text-muted-foreground/50" />
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: colorDe(z.tipo) }}
                          />
                          <span className="text-xs text-foreground">{z.name}</span>
                          {!z.active && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[0.5625rem] uppercase tracking-wide text-muted-foreground">
                              Inactivo
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden max-w-[18rem] md:table-cell">
                        {z.address ? (
                          <span className="line-clamp-1 text-xs text-muted-foreground">
                            {z.address}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-warning-strong">
                            <MapPin className="h-3 w-3" />
                            Sin ubicar
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                        {z.barrio || "-"}
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                        {z.tipo || "-"}
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">
                        {z.frecuencia || "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {/* Contrastar esto con la frecuencia es la razón de ser
                            de la columna: un punto de "2 veces por semana" con
                            una sola visita está mal repartido. */}
                        <span
                          className={`mono text-xs tabular-nums ${
                            veces === 0 ? "text-warning-strong" : "text-foreground"
                          }`}
                        >
                          {veces === 0 ? "Sin programar" : `${veces} día${veces === 1 ? "" : "s"}`}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-0.5">
                          <button
                            type="button"
                            onClick={() => onEditar(z)}
                            className="cursor-pointer rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={`Editar ${z.name}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onEliminar(z)}
                            className="cursor-pointer rounded p-1.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive-strong"
                            aria-label={`Eliminar ${z.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {/* Filas vacías para mantener el alto. Sin ellas, la última
                    página o un filtro con pocos resultados encoge la tarjeta y
                    la página salta. */}
                {relleno > 0 &&
                  Array.from({ length: relleno }).map((_, i) => (
                    <TableRow key={`relleno-${i}`} className="hover:bg-transparent">
                      <TableCell colSpan={8} className="h-[3.25rem]">
                        {i === 0 && visibles.length === 0 && (
                          <span className="block text-center text-xs text-muted-foreground">
                            Ningún punto coincide con la búsqueda.
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>

          {/* La barra se dibuja SIEMPRE, aunque haya una sola página:
              apareciendo y desapareciendo movería la tarjeta justo al filtrar.
              Mismo criterio que la tabla de recursos. */}
          <footer className="flex items-center justify-between border-t border-border px-4 py-2.5">
            <span className="text-[0.625rem] text-muted-foreground">
              {filtrados.length} punto{filtrados.length === 1 ? "" : "s"}
              {busqueda && ` de ${catalogo.length}`}
            </span>
            <div className="flex items-center gap-2">
              <span className="mono text-[0.625rem] tabular-nums text-muted-foreground">
                {paginaActual + 1} / {paginas}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                disabled={paginaActual === 0}
                onClick={() => setPagina(paginaActual - 1)}
                aria-label="Página anterior"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                disabled={paginaActual >= paginas - 1}
                onClick={() => setPagina(paginaActual + 1)}
                aria-label="Página siguiente"
              >
                <ArrowLeft className="h-3.5 w-3.5 rotate-180" />
              </Button>
            </div>
          </footer>
        </>
      )}
    </section>
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
// EL CATÁLOGO DEL BOTÓN "+" (AC1, AC2, AC3, AC4)
//
// Muestra el día COMPLETO, no solo lo que falta: los que ya están vienen
// marcados y se pueden desmarcar, así que este diálogo también sirve para
// sacar puntos de un día.
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
  // con un buscador arriba, "todos" significa lo que se está viendo.
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

            <ul className="-mx-1 max-h-[22rem] flex-1 space-y-1 overflow-y-auto px-1">
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
