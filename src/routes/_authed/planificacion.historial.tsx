// =============================================================================
// CONDORFINDER, HISTORIAL DE RUTAS (C6 de HDU5.2)
// Archivo: src/routes/_authed/planificacion.historial.tsx
//
// *"Dado los registros de rutas anteriores, cuando el trabajador aprete la
// pestaña de historial de rutas, el sistema le mostrarán todas rutas generadas
// anteriormente, ordenadas por día, y se advertirá que se está viendo un
// historial."*
//
// El criterio tiene cuatro partes y cada una se comprueba por separado: una
// PESTAÑA (no un diálogo escondido), TODAS las rutas, ordenadas POR DÍA, y una
// ADVERTENCIA de que es historial.
//
// -----------------------------------------------------------------------------
// EL MOLDE YA EXISTÍA
// -----------------------------------------------------------------------------
// El diálogo de puntos diarios de `/rutas` resolvió este mismo problema para
// otro objeto, así que de ahí salen dos decisiones en vez de inventarlas:
//
//   - **Una sola agregación** para saber qué días tienen datos y cuántos
//     (`fechasConRutas()`). Con una consulta por día, navegar un mes costaría
//     31 viajes a Mongo.
//   - **La advertencia va en ÁMBAR y no en gris.** Lo que dice cambia lo que se
//     puede esperar de la pantalla: acá nada es accionable sobre la jornada de
//     hoy, es lectura de lo que ya se planificó.
//
// -----------------------------------------------------------------------------
// LA FECHA ES UN ENCABEZADO, NO UNA COLUMNA
// -----------------------------------------------------------------------------
// "Ordenadas por día" se dibuja agrupando, con la fecha como título de cada
// bloque. Como columna repetida, el mismo día se imprimiría una vez por fila y
// el ojo tendría que compararlas para descubrir dónde cambia. Es el mismo
// criterio por el que la unidad va en el encabezado de la columna y no en cada
// celda.
// =============================================================================

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { FiltroDropdown } from "@/components/FiltroDropdown";
import { CerrarRutaDialog } from "@/components/CerrarRutaDialog";
import { ConfirmarBorrado } from "@/components/ConfirmarBorrado";
import { RouteTimeline } from "@/components/RouteTimeline";
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
  CheckCircle2,
  ChevronDown,
  Clock,
  Loader2,
  MapPin,
  Pencil,
  Route as RouteIcon,
  Search,
  Trash2,
  TriangleAlert,
  Truck,
} from "@/components/icons/Icons";
import { cifra, entero, volumen } from "@/lib/formato";
import { notify } from "@/lib/notify";
import { guardarRutaCargada } from "@/lib/rutaState";
import {
  cambiarEstadoRuta,
  cerrarRuta,
  eliminarRuta,
  fechasConRutas,
  listarRutas,
  obtenerRuta,
  TRANSICIONES,
  type DiaConRutas,
  type EstadoRuta,
  type RutaGuardada,
  type RutaGuardadaCompleta,
  type ZonaDeRuta,
} from "@/lib/routePlans";

export const Route = createFileRoute("/_authed/planificacion/historial")({
  component: HistorialPage,
});

/** Cómo se ve cada estado. Los cuatro están declarados aunque hoy solo exista
 *  `generada`: el ciclo de vida es la pieza 2.1 y el backend ya los define, así
 *  que una tabla que conoce uno solo habría que tocarla en cuanto exista el
 *  segundo. */
const ESTILO_ESTADO: Record<EstadoRuta, string> = {
  generada: "border-border bg-muted text-muted-foreground",
  "en curso": "border-warning-strong/40 bg-warning/10 text-warning-strong",
  terminada: "border-success-strong/40 bg-success/10 text-success-strong",
  cancelada: "border-destructive-strong/40 bg-destructive/10 text-destructive-strong",
};

/** Cómo se llama cada salto en el botón que lo dispara.
 *
 *  El verbo y no el estado: un botón que dice "en curso" obliga a deducir que
 *  apretarlo la pone en curso, mientras que "Despachar" dice lo que va a pasar.
 *  Es la misma razón por la que el botón de generar no dice "generada". */
const VERBO_ESTADO: Record<EstadoRuta, string> = {
  generada: "Volver a generada",
  "en curso": "Despachar",
  terminada: "Marcar terminada",
  cancelada: "Cancelar",
};

/** Qué se anuncia al conseguirlo. */
const ANUNCIO_ESTADO: Record<EstadoRuta, string> = {
  generada: "Ruta devuelta a generada",
  "en curso": "Ruta despachada",
  terminada: "Ruta terminada",
  cancelada: "Ruta cancelada",
};

/** Los estados por los que se filtra, en el orden del ciclo de vida. */
const ESTADOS_FILTRO: EstadoRuta[] = ["generada", "en curso", "terminada", "cancelada"];

type FiltroEstado = "todos" | EstadoRuta;

/** Rutas por página. Ocho y no cinco como en recursos: una fila de ruta es más
 *  baja que la de un punto (que lleva foto), y con cinco queda media tarjeta
 *  vacía. */
const POR_PAGINA = 8;

/** El día de una fecha ISO, en hora de Chile.
 *
 *  **Zona horaria explícita y no la del navegador.** Las fechas se guardan en
 *  UTC, y en Chile hay tres horas de diferencia: un plan generado a las 21:30
 *  cae al día siguiente en UTC, así que agrupar sin convertir lo mostraría bajo
 *  una fecha en la que nadie trabajó. Es la misma corrección que ya costó un
 *  defecto en los puntos diarios. */
function diaDe(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Santiago" });
}

function horaDe(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-CL", {
    timeZone: "America/Santiago",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** La fecha como la lee una persona: "lunes 3 de noviembre de 2026". */
function fechaLarga(dia: string): string {
  // `dia` es `YYYY-MM-DD` y `new Date("2026-11-03")` lo interpreta como UTC
  // medianoche, que en Chile es el día ANTERIOR a las 21:00. Se arma con los
  // componentes para que el rótulo diga el día que dice la agrupación.
  const [a, m, d] = dia.split("-").map(Number);
  return new Date(a, m - 1, d).toLocaleDateString("es-CL", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function HistorialPage() {
  const [rutas, setRutas] = useState<RutaGuardada[]>([]);
  const [dias, setDias] = useState<DiaConRutas[]>([]);
  const [cargando, setCargando] = useState(true);
  /** El día que se está mirando, o null para "todos". */
  const [diaElegido, setDiaElegido] = useState<string | null>(null);
  /** La ruta abierta en detalle. Es la única lectura que trae la geometría. */
  const [abierta, setAbierta] = useState<RutaGuardadaCompleta | null>(null);
  const [abriendo, setAbriendo] = useState<string | null>(null);
  /** Las rutas que se van a eliminar, de a una o varias. Una sola lista y no
   *  dos estados: eliminar con la papelera y eliminar lo seleccionado son el
   *  mismo gesto con distinta cantidad, y con dos caminos el texto de la
   *  confirmación y el manejo de errores se habrían separado. */
  const [aBorrar, setABorrar] = useState<RutaGuardada[] | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [filtroEstado, setFiltroEstado] = useState<FiltroEstado>("todos");
  /** Página actual, desde 1, igual que las tablas de recursos. */
  const [pagina, setPagina] = useState(1);
  /** Los ids marcados para eliminar. Persiste entre páginas: marcar en una y
   *  pasar a la siguiente no puede soltar lo ya marcado. */
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const navigate = useNavigate();
  const [cambiando, setCambiando] = useState<string | null>(null);
  /** La ruta que se está cerrando, ya con su plan completo.
   *
   *  **Hay que ir a buscarla**: el listado no trae las paradas (las proyecta
   *  fuera para no descargar la geometría de cada ruta), y el diálogo de cierre
   *  pregunta una cifra POR PARADA. */
  const [cerrando, setCerrando] = useState<RutaGuardadaCompleta | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      // Las dos juntas: el listado y los días con datos se dibujan en la misma
      // pantalla, así que pedirlas en serie mostraría la tabla y después la
      // tira de atajos apareciendo encima.
      const [lista, fechas] = await Promise.all([
        listarRutas(diaElegido ? { desde: diaElegido, hasta: diaElegido } : undefined),
        fechasConRutas(),
      ]);
      setRutas(lista);
      setDias(fechas);
    } catch (e) {
      notify.error("No se pudo cargar el historial", (e as Error).message);
      setRutas([]);
    } finally {
      setCargando(false);
    }
  }, [diaElegido]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /** Lo que el buscador reconoce de una ruta: su origen, su estado y el nombre
   *  de cada lugar que visita. Buscar solo por origen dejaría sin respuesta la
   *  pregunta más frecuente del historial: "¿cuándo fuimos a Rebeca Sur?". */
  const textoDe = (r: RutaGuardada) =>
    [r.resumen.origenNombre, r.estado, ...(r.resumen.zonas ?? []).map((z) => z.nombre)]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return rutas.filter(
      (r) =>
        (filtroEstado === "todos" || r.estado === filtroEstado) && (!q || textoDe(r).includes(q)),
    );
  }, [rutas, busqueda, filtroEstado]);

  const totalPaginas = Math.max(1, Math.ceil(visibles.length / POR_PAGINA));
  // Filtrar deja la página actual fuera de rango (estabas en la 3 y ahora hay
  // una): sin esto la tabla se ve vacía aunque haya resultados.
  useEffect(() => setPagina((p) => Math.min(p, totalPaginas)), [totalPaginas]);
  const paginaActual = Math.min(pagina, totalPaginas);
  const desde = (paginaActual - 1) * POR_PAGINA;
  const enPagina = visibles.slice(desde, desde + POR_PAGINA);

  /** Los totales de CADA día sobre todo lo filtrado, no solo sobre la página: el
   *  encabezado de un día dice cuántas rutas tuvo, y partido por la paginación
   *  diría "1 ruta" donde hubo cuatro. */
  const totalesPorDia = useMemo(() => {
    const m = new Map<string, { rutas: number; retirado: number }>();
    for (const r of visibles) {
      const d = diaDe(r.fecha);
      const prev = m.get(d) ?? { rutas: 0, retirado: 0 };
      m.set(d, {
        rutas: prev.rutas + 1,
        retirado: prev.retirado + (r.resumen.volumenRetiradoM3 ?? 0),
      });
    }
    return m;
  }, [visibles]);

  /** Las filas de la página, con el encabezado de día en la primera ruta de cada
   *  día. El orden es el que devolvió el backend (fecha descendente): reordenar
   *  acá sería una segunda respuesta a la misma pregunta. */
  const filas: FilaHistorial[] = useMemo(() => {
    let previo: string | null = null;
    return enPagina.map((ruta) => {
      const dia = diaDe(ruta.fecha);
      const nuevo = dia !== previo;
      previo = dia;
      const tot = totalesPorDia.get(dia);
      return {
        ruta,
        encabezadoDia: nuevo && tot ? { dia, rutas: tot.rutas, retirado: tot.retirado } : undefined,
      };
    });
  }, [enPagina, totalesPorDia]);

  // Una ruta en curso no se elimina, así que no se puede marcar.
  const borrables = useMemo(() => visibles.filter((r) => r.estado !== "en curso"), [visibles]);
  const seleccionadas = useMemo(
    () => rutas.filter((r) => seleccion.has(r.id) && r.estado !== "en curso"),
    [rutas, seleccion],
  );

  const alternarSeleccion = (r: RutaGuardada) =>
    setSeleccion((prev) => {
      const sig = new Set(prev);
      if (sig.has(r.id)) sig.delete(r.id);
      else sig.add(r.id);
      return sig;
    });

  /** La casilla del encabezado: marca las de ESTA página, o las suelta si ya
   *  estaban todas. Las del resto de las páginas no se tocan. */
  const alternarPagina = () => {
    const ids = enPagina.filter((r) => r.estado !== "en curso").map((r) => r.id);
    setSeleccion((prev) => {
      const sig = new Set(prev);
      const todas = ids.length > 0 && ids.every((id) => sig.has(id));
      for (const id of ids) {
        if (todas) sig.delete(id);
        else sig.add(id);
      }
      return sig;
    });
  };

  // Lo que ya no existe se suelta solo: tras eliminar o recargar, un id marcado
  // que desapareció no puede seguir contando como seleccionado.
  useEffect(() => {
    setSeleccion((prev) => {
      const vivos = new Set(rutas.map((r) => r.id));
      const sig = new Set([...prev].filter((id) => vivos.has(id)));
      return sig.size === prev.size ? prev : sig;
    });
  }, [rutas]);

  const abrir = async (r: RutaGuardada) => {
    setAbriendo(r.id);
    try {
      setAbierta(await obtenerRuta(r.id));
    } catch (e) {
      notify.error("No se pudo abrir la ruta", (e as Error).message);
    } finally {
      setAbriendo(null);
    }
  };

  /** Abre esta ruta en `/rutas` para regenerarla (C5).
   *
   *  **Editar es regenerar**, así que no hay un editor aparte: se reconstruye
   *  lo que esa ruta tenía cargado (paradas, volúmenes y prioridades) en el
   *  mismo estado que `/rutas` usa siempre, y esa vista lo restaura con el
   *  mecanismo que ya existía. Un editor propio habría sido una segunda
   *  pantalla que decide lo mismo, y las dos se habrían separado a la primera
   *  corrección.
   *
   *  Hay que ir a buscar el plan completo porque el listado no trae `peticion`:
   *  lo proyecta fuera a propósito, para que abrir el historial no descargue la
   *  geometría de cada ruta.
   */
  const editar = async (r: RutaGuardada) => {
    setAbriendo(r.id);
    try {
      const completa = await obtenerRuta(r.id);
      const peticion = completa.peticion;
      if (!peticion) {
        notify.error(
          "No se puede editar esta ruta",
          "El registro no guardó con qué se generó, así que no hay nada que precargar.",
        );
        return;
      }
      const paradas = peticion.stops ?? [];
      guardarRutaCargada({
        analisis: paradas.filter((s) => s.kind === "analysis").map((s) => s.id),
        diarios: paradas.filter((s) => s.kind === "punto_diario").map((s) => s.id),
        // Los volúmenes vuelven como TEXTO porque así los tiene el campo del
        // formulario mientras se escribe. Convertirlos acá obligaría a decidir
        // cómo se imprime cada uno, y el campo ya sabe hacerlo.
        volumenes: Object.fromEntries(
          paradas.filter((s) => s.retirarM3 != null).map((s) => [s.id, String(s.retirarM3)]),
        ),
        prioritarias: peticion.priorityStopIds ?? [],
        editandoPlanId: r.id,
        // **Las condiciones de la jornada también se precargan**, y no es un
        // detalle: son lo que decide cuántos viajes entran y cuántos convoyes
        // salen. Reabrir una ruta de 10 horas y 2 convoyes con el 8 y el 1 por
        // omisión la regeneraría más corta, y el trabajador vería desaparecer
        // paradas que él no quitó.
        horas: peticion.availableHours != null ? String(peticion.availableHours) : null,
        convoyes: peticion.convoyesPorPunto ?? null,
      });
      await navigate({ to: "/planificacion/rutas" });
    } catch (e) {
      notify.error("No se pudo abrir la ruta para editar", (e as Error).message);
    } finally {
      setAbriendo(null);
    }
  };

  /** Mueve una ruta por su ciclo de vida.
   *
   *  **Recarga la lista en vez de parchear la fila.** El cambio de estado
   *  escribe además `despachadaEn` o `cerradaEn`, y la fila los muestra: con un
   *  parche local habría que replicar acá la regla de cuál se escribe en cada
   *  salto, o sea una segunda copia de algo que el servidor ya decidió. */
  const cambiarEstado = async (r: RutaGuardada, estado: EstadoRuta) => {
    // Terminar no es un cambio de estado a secas: pasa por el cierre, que
    // además registra lo retirado. Se bifurca acá para que los botones de la
    // fila sigan saliendo de una sola tabla de transiciones.
    if (estado === "terminada") {
      void abrirCierre(r);
      return;
    }
    setCambiando(r.id);
    try {
      await cambiarEstadoRuta(r.id, estado);
      notify.success(ANUNCIO_ESTADO[estado], r.resumen.origenNombre ?? "");
      await cargar();
    } catch (e) {
      // El backend responde 409 si ese salto no existe desde donde está la
      // ruta, y su mensaje nombra los que sí. Se muestra tal cual.
      notify.error("No se pudo cambiar el estado", (e as Error).message);
    } finally {
      setCambiando(null);
    }
  };

  /** Terminar una ruta pasa por el cierre del retiro (pieza 2.4).
   *
   *  **No es un cambio de estado más**, y por eso no va por `cambiarEstado`:
   *  cerrar es la única transición que además registra un hecho, cuánto salió
   *  de cada lugar. Ese registro es lo que después le da historial de volumen a
   *  un punto que nadie voló nunca.
   */
  const abrirCierre = async (r: RutaGuardada) => {
    setCambiando(r.id);
    try {
      setCerrando(await obtenerRuta(r.id));
    } catch (e) {
      notify.error("No se pudo abrir el cierre", (e as Error).message);
    } finally {
      setCambiando(null);
    }
  };

  /** Elimina las rutas de la confirmación, de a una y tolerando que alguna
   *  falle. Mismo criterio que "Todos disponibles" de la flota y el borrado
   *  múltiple de puntos diarios: dejar la tabla mostrando el estado anterior
   *  después de ocho borrados reales sería mentir, así que lo ya borrado se
   *  refleja aunque otra haya fallado. */
  const borrar = async () => {
    const lista = aBorrar ?? [];
    if (lista.length === 0) return;
    let hechas = 0;
    const errores: string[] = [];
    for (const r of lista) {
      try {
        await eliminarRuta(r.id);
        hechas++;
      } catch (e) {
        // El backend se niega con 409 si la ruta está en curso, y ese mensaje
        // explica cuál es el caso. Se muestra tal cual: la regla vive allá.
        errores.push((e as Error).message);
      }
    }
    if (hechas > 0) {
      notify.success(
        hechas === 1 ? "Ruta eliminada" : `${hechas} rutas eliminadas`,
        lista.length === 1 ? `Del ${fechaLarga(diaDe(lista[0].fecha))}.` : undefined,
      );
      setSeleccion(new Set());
      await cargar();
    }
    if (errores.length > 0) {
      notify.error(
        `No se pudo eliminar ${errores.length} ruta${errores.length === 1 ? "" : "s"}`,
        errores[0],
      );
      // Si no se borró NINGUNA el diálogo queda abierto (lanzar es lo que lo
      // mantiene): cerrarlo escondería el motivo justo cuando hay que leerlo.
      if (hechas === 0) throw new Error(errores[0]);
    }
  };

  if (abierta) {
    return <DetalleRuta ruta={abierta} onVolver={() => setAbierta(null)} />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <div className="border-b border-border/25 px-6 py-4">
        <p className="eyebrow">Planificación</p>
        <h1 className="text-xl font-semibold">Historial de rutas</h1>
      </div>

      <div className="flex-1 space-y-4 p-6">
        {/* **La advertencia del criterio.** En ámbar y no en gris: lo que dice
            cambia lo que se puede esperar de la pantalla. Acá nada actúa sobre
            la jornada de hoy, es lectura de lo que ya se planificó. */}
        <p className="flex items-start gap-2 rounded-lg border border-warning-strong/40 bg-warning/10 px-3 py-2 text-[0.6875rem] leading-relaxed text-warning-strong">
          <TriangleAlert className="mt-px h-3.5 w-3.5 flex-shrink-0" />
          <span>
            Estás viendo un <strong>historial</strong>. Son planes ya generados, no la jornada en
            curso: lo que ves acá no despacha ningún camión. Para armar una ruta nueva, ve a Rutas.
          </span>
        </p>

        {/* Los días con rutas, como atajos. **Una tira y no un calendario**, por
            el mismo motivo que en el diálogo de puntos diarios: un calendario
            arrastra problemas de recorte y de z-index, y una tira responde la
            misma pregunta sin capa flotante. */}
        {dias.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setDiaElegido(null)}
              className={`cursor-pointer rounded-md border px-2.5 py-1 text-[0.6875rem] transition-colors ${
                diaElegido === null
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border/60 text-muted-foreground hover:bg-accent"
              }`}
            >
              Todos ({dias.reduce((s, d) => s + d.total, 0)})
            </button>
            {dias.map((d) => (
              <button
                key={d.fecha}
                type="button"
                onClick={() => setDiaElegido(d.fecha)}
                className={`cursor-pointer rounded-md border px-2.5 py-1 text-[0.6875rem] transition-colors ${
                  diaElegido === d.fecha
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border/60 text-muted-foreground hover:bg-accent"
                }`}
              >
                {d.fecha} ({d.total})
              </button>
            ))}
          </div>
        )}

        {/* El total de lo que se está mirando. Cambia con el filtro de día, y es
            lo que permite saber de un vistazo cuánto se planificó contra cuánto
            salió. Las canceladas no cuentan como planificado: nunca se hicieron,
            y sumarlas inflaría el denominador. */}
        {!cargando && rutas.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Cifra icono={RouteIcon} etiqueta="Rutas" valor={entero(rutas.length)} />
            <Cifra
              icono={Truck}
              etiqueta="Planificado"
              valor={`${volumen(
                rutas
                  .filter((r) => r.estado !== "cancelada")
                  .reduce((s, r) => s + (r.resumen.volumenM3 ?? 0), 0),
              )} m³`}
              nota="sin contar las canceladas"
            />
            <Cifra
              icono={CheckCircle2}
              etiqueta="Retirado"
              valor={`${volumen(rutas.reduce((s, r) => s + (r.resumen.volumenRetiradoM3 ?? 0), 0))} m³`}
              nota="de las rutas cerradas con cifra"
            />
          </div>
        )}

        {/* **La misma tabla que la de puntos y la de la flota**: buscador y filtro
            de estado arriba, alto fijo con scroll, y la barra de paginación
            siempre visible. Dos tablas que hacen lo mismo y se ven distinto
            obligan a reaprender la segunda. */}
        <div className="panel overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
            <span className="flex items-center gap-2.5 border-l-2 border-primary/50 pl-3">
              <RouteIcon className="h-3.5 w-3.5 text-foreground/70" />
              <h2 className="text-sm font-semibold tracking-tight text-foreground">Rutas</h2>
            </span>

            <div className="relative min-w-[12rem] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={busqueda}
                onChange={(e) => {
                  setBusqueda(e.target.value);
                  setPagina(1);
                }}
                placeholder="Buscar por origen, lugar o estado"
                className="h-8 pl-8 text-xs"
              />
            </div>

            <FiltroDropdown
              etiqueta="Estado"
              valor={filtroEstado}
              opciones={[
                { valor: "todos", etiqueta: "Todos", conteo: rutas.length },
                ...ESTADOS_FILTRO.map((e) => ({
                  valor: e,
                  etiqueta: e.charAt(0).toUpperCase() + e.slice(1),
                  conteo: rutas.filter((r) => r.estado === e).length,
                })),
              ]}
              onCambio={(v) => {
                setFiltroEstado(v);
                setPagina(1);
              }}
            />
          </div>

          {/* **La barra de selección SIEMPRE ocupa su lugar.** Apareciendo solo
              con algo marcado, empujaba la tabla hacia abajo justo al marcar la
              primera casilla, que es cuando uno tiene el cursor puesto en ella.
              Sin selección dice cómo se usa, así que tampoco es espacio muerto. */}
          <div className="flex min-h-[2.75rem] flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-5 py-1.5">
            {seleccionadas.length === 0 ? (
              <p className="text-[0.6875rem] text-muted-foreground">
                Marca las casillas para eliminar varias rutas juntas.
              </p>
            ) : (
              <>
                <span className="text-xs font-semibold text-foreground">
                  {seleccionadas.length} seleccionada{seleccionadas.length === 1 ? "" : "s"}
                </span>
                {borrables.length > seleccionadas.length && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[0.6875rem] text-primary"
                    onClick={() => setSeleccion(new Set(borrables.map((r) => r.id)))}
                  >
                    Seleccionar las {borrables.length} del filtro
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[0.6875rem]"
                  onClick={() => setSeleccion(new Set())}
                >
                  Deseleccionar
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="ml-auto h-7 px-3 text-[0.6875rem]"
                  onClick={() => setABorrar(seleccionadas)}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Eliminar seleccionadas
                </Button>
              </>
            )}
          </div>

          {/* Alto FIJO, haya dos rutas o veinte: con el alto siguiendo al
              contenido, la tarjeta crecía y encogía al filtrar o al cambiar de
              página, y los controles de paginación se movían justo cuando hay
              que apretarlos dos veces seguidas. En rem porque toda la interfaz
              escala con el clamp de html. */}
          <div className="h-[34rem] overflow-y-auto">
            {cargando ? (
              <div className="flex justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : rutas.length === 0 ? (
              <p className="px-4 py-12 text-center text-xs leading-relaxed text-muted-foreground">
                {diaElegido
                  ? "No se generó ninguna ruta ese día."
                  : "Todavía no se ha generado ninguna ruta. Las que generes en Rutas van a aparecer acá."}
              </p>
            ) : visibles.length === 0 ? (
              <p className="px-4 py-12 text-center text-xs text-muted-foreground">
                Ninguna ruta coincide con la búsqueda o el filtro.
              </p>
            ) : (
              <TablaHistorial
                filas={filas}
                seleccion={seleccion}
                abriendo={abriendo}
                cambiando={cambiando}
                onSeleccionar={alternarSeleccion}
                onSeleccionarPagina={alternarPagina}
                onAbrir={(r) => void abrir(r)}
                onEditar={(r) => void editar(r)}
                onBorrar={(r) => setABorrar([r])}
                onEstado={(r, e) => void cambiarEstado(r, e)}
              />
            )}
          </div>

          {/* La barra va SIEMPRE, incluso con una sola página: apareciendo solo
              cuando sobran filas, cambiaba el alto de la tarjeta al filtrar. Con
              una página los botones quedan deshabilitados, que ya dice que no
              hay a dónde ir. */}
          {!cargando && rutas.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
              <p className="text-xs text-muted-foreground">
                Mostrando{" "}
                <span className="mono tabular-nums text-foreground">
                  {visibles.length === 0 ? 0 : desde + 1}-
                  {Math.min(desde + POR_PAGINA, visibles.length)}
                </span>{" "}
                de <span className="mono tabular-nums text-foreground">{visibles.length}</span>
              </p>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={paginaActual === 1}
                  onClick={() => setPagina(paginaActual - 1)}
                >
                  Anterior
                </Button>
                {Array.from({ length: totalPaginas }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setPagina(n)}
                    aria-current={n === paginaActual ? "page" : undefined}
                    className={`mono h-8 w-8 cursor-pointer rounded-md text-xs tabular-nums transition-colors ${
                      n === paginaActual
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    {n}
                  </button>
                ))}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={paginaActual === totalPaginas}
                  onClick={() => setPagina(paginaActual + 1)}
                >
                  Siguiente
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <CerrarRutaDialog
        abierto={cerrando !== null}
        onOpenChange={(a) => !a && setCerrando(null)}
        stops={cerrando?.plan?.stops ?? []}
        onCerrar={async (retiros) => {
          if (!cerrando) return;
          try {
            await cerrarRuta(cerrando.id, retiros);
            notify.success(
              "Ruta cerrada",
              retiros.length > 0
                ? `Se registró el retiro de ${retiros.length} parada(s).`
                : "Se cerró sin registrar cifras.",
            );
            setCerrando(null);
            await cargar();
          } catch (e) {
            notify.error("No se pudo cerrar la ruta", (e as Error).message);
          }
        }}
      />

      <ConfirmarBorrado
        abierto={aBorrar !== null}
        onOpenChange={(a) => !a && setABorrar(null)}
        titulo={
          (aBorrar?.length ?? 0) > 1
            ? `Eliminar ${aBorrar?.length} rutas del historial`
            : "Eliminar esta ruta del historial"
        }
        etiquetaConfirmar={(aBorrar?.length ?? 0) > 1 ? `Eliminar ${aBorrar?.length}` : "Eliminar"}
        descripcion={
          aBorrar && aBorrar.length > 0 ? (
            <>
              {aBorrar.length === 1 ? (
                <>
                  Se eliminará el plan generado el{" "}
                  <strong>{fechaLarga(diaDe(aBorrar[0].fecha))}</strong> a las{" "}
                  {horaDe(aBorrar[0].fecha)}.
                </>
              ) : (
                <>
                  Se eliminarán <strong>{aBorrar.length} rutas</strong> del historial.
                </>
              )}{" "}
              Esto no se puede deshacer.
              {/* **Hay que decir que se lleva el retiro**, porque cambia una
                  cifra fuera de esta pantalla: el volumen que Vista Principal
                  muestra de esa zona vuelve a subir. Borrarlo en silencio
                  dejaría a alguien buscando por qué cambió un número que él no
                  tocó. Y es la coherencia correcta: si la ruta no ocurrió, su
                  registro de lo retirado tampoco. Con varias, la cifra es la
                  suma. */}
              {(() => {
                const retirado = aBorrar
                  .filter((r) => r.estado === "terminada")
                  .reduce((s, r) => s + (r.resumen.volumenRetiradoM3 ?? 0), 0);
                return retirado > 0 ? (
                  <>
                    {" "}
                    Se {aBorrar.length === 1 ? "borrará" : "borrarán"} también{" "}
                    {aBorrar.length === 1 ? "el retiro" : "los retiros"} de{" "}
                    <strong>{cifra(retirado)} m³</strong> que quedó registrado al cerrar
                    {aBorrar.length === 1 ? "la" : "las"}, así que ese volumen vuelve a contarse en
                    sus zonas.
                  </>
                ) : null;
              })()}
            </>
          ) : (
            ""
          )
        }
        onConfirmar={borrar}
      />
    </div>
  );
}

/** Cómo se llama cada salto en el botón de la tabla, en corto.
 *
 *  `VERBO_ESTADO` es la versión larga y va en el `title`; acá no cabe "Marcar
 *  terminada" al lado de los otros botones de la fila. El verbo sigue siendo el
 *  mismo: "Terminar" dice lo que va a pasar, "terminada" obliga a deducirlo. */
const VERBO_CORTO: Record<EstadoRuta, string> = {
  generada: "Volver a generada",
  "en curso": "Despachar",
  terminada: "Terminar",
  cancelada: "Cancelar",
};

/** El color de cada acción de estado, por lo que HACE y no por el estado al que
 *  lleva. Despachar es la acción principal de una ruta generada (navy), terminar
 *  es la que cierra con éxito (verde) y cancelar la que no tiene vuelta
 *  (rojo). Con los tres del mismo gris, el trabajador tenía que leer cada
 *  etiqueta para distinguir la que cierra de la que descarta, justo en la fila
 *  donde se equivoca más caro. */
const BOTON_ESTADO: Record<EstadoRuta, string> = {
  generada: "border-border bg-background text-foreground hover:bg-accent",
  "en curso": "border-primary/50 bg-primary/10 text-primary hover:bg-primary/20",
  terminada:
    "border-success-strong/50 bg-success/10 text-success-strong hover:bg-success/20 hover:text-success-strong",
  cancelada:
    "border-destructive-strong/50 bg-destructive/10 text-destructive-strong hover:bg-destructive/20 hover:text-destructive-strong",
};

/** Qué es cada lugar, con las palabras que usa la municipalidad: un punto
 *  permanente es el que tiene análisis (un lugar que se sigue en el tiempo) y un
 *  punto diario es el retiro que se pidió para ese día. */
const ETIQUETA_TIPO: Record<string, string> = {
  analysis: "Punto permanente",
  punto_diario: "Punto diario",
};

/** Orden en que se agrupan los lugares dentro de una ruta: primero los puntos
 *  permanentes y después los diarios. */
const ORDEN_TIPO: Record<string, number> = { analysis: 0, punto_diario: 1 };

/** El desglose por lugar de una ruta.
 *
 *  Sale del resumen cuando existe. Para una ruta guardada antes de ese campo se
 *  arma desde las paradas del plan, sin cifra retirada: es lo único que se sabe,
 *  y decir "0" afirmaría algo que nadie midió. Un lugar visitado varias veces
 *  figura una sola vez, con lo planificado sumado. */
function zonasDeRuta(
  zonas: ZonaDeRuta[] | undefined,
  paradas:
    | { stopId?: string; kind?: string; label: string; removedVolumeM3?: number }[]
    | undefined,
): ZonaDeRuta[] {
  if (zonas && zonas.length > 0) return zonas;
  const por: Map<string, ZonaDeRuta> = new Map();
  for (const s of paradas ?? []) {
    if (!s.stopId) continue;
    const kind = (s.kind ?? "analysis") as ZonaDeRuta["kind"];
    const clave = `${kind}:${s.stopId}`;
    const previa = por.get(clave);
    if (previa) {
      previa.planificadoM3 =
        Math.round((previa.planificadoM3 + (s.removedVolumeM3 ?? 0)) * 100) / 100;
    } else {
      por.set(clave, {
        stopId: s.stopId,
        kind,
        nombre: s.label,
        planificadoM3: s.removedVolumeM3 ?? 0,
        retiradoM3: null,
        completado: null,
      });
    }
  }
  return Array.from(por.values());
}

/** Cómo va un lugar de la ruta: pendiente, completo, parcial o sin cifra. */
function estadoDeZona(z: ZonaDeRuta, estadoRuta: EstadoRuta): { texto: string; estilo: string } {
  if (estadoRuta !== "terminada") {
    return {
      texto: estadoRuta === "cancelada" ? "No se hizo" : "Pendiente",
      estilo: "border-border bg-muted text-muted-foreground",
    };
  }
  if (z.retiradoM3 == null) {
    return { texto: "Sin cifra", estilo: "border-border bg-muted text-muted-foreground" };
  }
  if (z.completado === false || z.retiradoM3 + 0.005 < z.planificadoM3) {
    return {
      texto: "Parcial",
      estilo: "border-warning-strong/40 bg-warning/10 text-warning-strong",
    };
  }
  return {
    texto: "Completo",
    estilo: "border-success-strong/40 bg-success/10 text-success-strong",
  };
}

/** Cuánto volumen se retiró de cada lugar de una ruta.
 *
 *  Es lo que la tabla del historial no podía decir con una sola cifra por ruta:
 *  "87 m³ retirados" no dice de dónde salieron ni cuál lugar quedó corto. Cada
 *  fila compara lo retirado con lo planificado y lo dibuja como una barra, que
 *  se lee de un vistazo sin comparar dos números.
 *
 *  **Los puntos permanentes y los diarios van en bloques separados por una línea
 *  más marcada.** Son dos cosas distintas (una zona medida por el dron y un
 *  retiro pedido para ese día), y con la misma línea fina entre todas las filas
 *  se leían como una sola lista donde el tipo era una columna más. */
function TablaZonas({ zonas, estadoRuta }: { zonas: ZonaDeRuta[]; estadoRuta: EstadoRuta }) {
  if (zonas.length === 0) {
    return (
      <p className="py-2 text-[0.6875rem] text-muted-foreground">
        Esta ruta no guardó el desglose por lugar.
      </p>
    );
  }
  // Orden estable: los permanentes primero, y dentro de cada tipo el orden de
  // visita que ya traían.
  const ordenadas = [...zonas].sort(
    (a, b) => (ORDEN_TIPO[a.kind] ?? 9) - (ORDEN_TIPO[b.kind] ?? 9),
  );
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-[0.625rem] text-muted-foreground">
          <th className="py-1.5 pr-3 font-medium">Lugar</th>
          <th className="hidden px-3 py-1.5 font-medium md:table-cell">Tipo</th>
          <th className="px-3 py-1.5 text-center font-medium">Planificado (m³)</th>
          <th className="px-3 py-1.5 text-center font-medium">Retirado (m³)</th>
          <th className="hidden w-40 px-3 py-1.5 font-medium sm:table-cell">Avance</th>
          <th className="py-1.5 pl-3 text-center font-medium">Estado</th>
        </tr>
      </thead>
      <tbody>
        {ordenadas.map((z, i) => {
          const est = estadoDeZona(z, estadoRuta);
          // La barra solo existe cuando hay con qué comparar. Sin cifra retirada
          // queda vacía y no llena: un 0 % dibujado afirmaría que no salió nada.
          const pct =
            z.retiradoM3 != null && z.planificadoM3 > 0
              ? Math.max(0, Math.min(100, (z.retiradoM3 / z.planificadoM3) * 100))
              : null;
          const cambiaDeTipo = i > 0 && ordenadas[i - 1].kind !== z.kind;
          return (
            <tr
              key={`${z.kind}:${z.stopId}`}
              className={
                i === 0
                  ? "border-t border-border"
                  : cambiaDeTipo
                    ? // La línea que separa un bloque del otro: más gruesa y más
                      // oscura que la que separa filas del mismo tipo.
                      "border-t-2 border-foreground/25"
                    : "border-t border-border/60"
              }
            >
              <td className="max-w-[16rem] truncate py-2 pr-3 font-medium text-foreground">
                {z.nombre ?? "Sin nombre"}
              </td>
              <td className="hidden px-3 py-2 text-muted-foreground md:table-cell">
                {ETIQUETA_TIPO[z.kind] ?? z.kind}
              </td>
              <td className="mono px-3 py-2 text-center tabular-nums text-muted-foreground">
                {volumen(z.planificadoM3)}
              </td>
              <td className="mono px-3 py-2 text-center font-semibold tabular-nums text-foreground">
                {z.retiradoM3 != null ? volumen(z.retiradoM3) : "-"}
              </td>
              <td className="hidden px-3 py-2 sm:table-cell">
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                  role="img"
                  aria-label={
                    pct != null
                      ? `Se retiró el ${Math.round(pct)} % de lo planificado`
                      : "Sin cifra retirada para comparar"
                  }
                >
                  {pct != null && (
                    <div
                      className={`h-full rounded-full ${pct >= 99.5 ? "bg-success" : "bg-warning"}`}
                      style={{ width: `${pct}%` }}
                    />
                  )}
                </div>
              </td>
              <td className="py-2 pl-3 text-center">
                <span
                  className={`inline-block rounded-full border px-2 py-0.5 text-[0.625rem] font-medium ${est.estilo}`}
                >
                  {est.texto}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Una fila de la tabla: la ruta, y el día si es la primera de ese día en la
 *  página. */
export interface FilaHistorial {
  ruta: RutaGuardada;
  /** Presente solo en la primera ruta de cada día DENTRO de la página. */
  encabezadoDia?: { dia: string; rutas: number; retirado: number };
}

/** Las rutas de una página, como tabla.
 *
 *  Una tabla y no una lista de tarjetas: lo que se hace con el historial es
 *  comparar rutas entre sí (cuánto se planificó, cuánto salió, cuánto tardó), y
 *  eso pide cifras alineadas en columnas con su unidad en el encabezado, igual
 *  que Vista Principal y las tablas de recursos.
 *
 *  **La fecha sigue siendo un ENCABEZADO de bloque y no una columna**: repetida
 *  por fila, el mismo día se imprimiría una vez por ruta. Se dibuja como una fila
 *  que atraviesa la tabla, así el agrupado por día (C6) convive con la
 *  paginación sin partirse en una tabla por día. */
function TablaHistorial({
  filas,
  seleccion,
  abriendo,
  cambiando,
  onSeleccionar,
  onSeleccionarPagina,
  onAbrir,
  onEditar,
  onBorrar,
  onEstado,
}: {
  filas: FilaHistorial[];
  seleccion: Set<string>;
  abriendo: string | null;
  cambiando: string | null;
  onSeleccionar: (r: RutaGuardada) => void;
  onSeleccionarPagina: () => void;
  onAbrir: (r: RutaGuardada) => void;
  onEditar: (r: RutaGuardada) => void;
  onBorrar: (r: RutaGuardada) => void;
  onEstado: (r: RutaGuardada, estado: EstadoRuta) => void;
}) {
  const [abiertas, setAbiertas] = useState<Set<string>>(new Set());
  const alternar = (id: string) =>
    setAbiertas((prev) => {
      const sig = new Set(prev);
      if (sig.has(id)) sig.delete(id);
      else sig.add(id);
      return sig;
    });

  // La casilla del encabezado habla de los que se PUEDEN seleccionar. Una ruta
  // en curso no se borra, así que no cuenta ni para marcar todo ni para el
  // estado intermedio.
  const seleccionables = filas.filter((f) => f.ruta.estado !== "en curso");
  const marcadas = seleccionables.filter((f) => seleccion.has(f.ruta.id)).length;
  const estadoCasilla: boolean | "indeterminate" =
    seleccionables.length > 0 && marcadas === seleccionables.length
      ? true
      : marcadas > 0
        ? "indeterminate"
        : false;

  // Todas las columnas centradas comparten la misma clase para que no se
  // desalineen entre encabezado y celdas.
  const centro = "px-3 text-center";

  return (
    <Table>
      <TableHeader>
        <TableRow className="border-b border-border/60 bg-muted/40 hover:bg-muted/40">
          <TableHead className="w-10 px-3">
            <Checkbox
              checked={estadoCasilla}
              onCheckedChange={onSeleccionarPagina}
              disabled={seleccionables.length === 0}
              aria-label="Seleccionar las rutas de esta página"
            />
          </TableHead>
          <TableHead className="w-10 px-1" />
          <TableHead className="w-[9.5rem] whitespace-nowrap px-3 text-[0.6875rem]">Hora</TableHead>
          <TableHead className="px-3 text-[0.6875rem]">Origen</TableHead>
          <TableHead className={`w-[7rem] text-[0.6875rem] ${centro}`}>Estado</TableHead>
          <TableHead className={`w-[5rem] text-[0.6875rem] ${centro}`}>Paradas</TableHead>
          <TableHead className={`w-[8rem] whitespace-nowrap text-[0.6875rem] ${centro}`}>
            Planificado (m³)
          </TableHead>
          <TableHead className={`w-[8rem] whitespace-nowrap text-[0.6875rem] ${centro}`}>
            Retirado (m³)
          </TableHead>
          <TableHead
            className={`hidden w-[7rem] whitespace-nowrap text-[0.6875rem] xl:table-cell ${centro}`}
          >
            Distancia (km)
          </TableHead>
          <TableHead
            className={`hidden w-[6.5rem] whitespace-nowrap text-[0.6875rem] xl:table-cell ${centro}`}
          >
            Duración (h)
          </TableHead>
          <TableHead
            className={`hidden w-[5rem] whitespace-nowrap text-[0.6875rem] xl:table-cell ${centro}`}
          >
            Viajes
          </TableHead>
          <TableHead className="px-3 text-right">
            <span className="sr-only">Acciones</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {filas.map(({ ruta, encabezadoDia }) => {
          const r = ruta.resumen;
          const zonas = zonasDeRuta(r.zonas, undefined);
          const abierta = abiertas.has(ruta.id);
          const ocupada = cambiando === ruta.id;
          const marcada = seleccion.has(ruta.id);
          const diferencia =
            r.volumenRetiradoM3 != null && r.volumenM3 != null
              ? r.volumenRetiradoM3 - r.volumenM3
              : 0;
          return (
            <Fragment key={ruta.id}>
              {encabezadoDia && (
                <TableRow className="border-b border-border/60 bg-muted/60 hover:bg-muted/60">
                  <TableCell colSpan={12} className="px-4 py-2">
                    <span className="flex items-baseline gap-2 text-xs font-semibold capitalize text-foreground">
                      {fechaLarga(encabezadoDia.dia)}
                      <span className="text-[0.625rem] font-normal normal-case text-muted-foreground">
                        {encabezadoDia.rutas} ruta{encabezadoDia.rutas === 1 ? "" : "s"}
                        {encabezadoDia.retirado > 0 &&
                          ` · ${volumen(encabezadoDia.retirado)} m³ retirados`}
                      </span>
                    </span>
                  </TableCell>
                </TableRow>
              )}
              <TableRow
                className={`border-b border-border/40 ${marcada ? "bg-primary/5 hover:bg-primary/10" : ""}`}
              >
                <TableCell className="px-3 py-3">
                  <Checkbox
                    checked={marcada}
                    onCheckedChange={() => onSeleccionar(ruta)}
                    disabled={ruta.estado === "en curso"}
                    aria-label={
                      ruta.estado === "en curso"
                        ? "Una ruta en curso no se puede eliminar"
                        : `Seleccionar la ruta de las ${horaDe(ruta.fecha)}`
                    }
                    title={ruta.estado === "en curso" ? "En curso: se cancela antes" : undefined}
                  />
                </TableCell>

                <TableCell className="px-1 py-3">
                  {zonas.length > 0 ? (
                    // Resaltado a propósito: es la única forma de ver cuánto salió
                    // de cada lugar sin abrir la ruta, y como ícono gris suelto
                    // pasaba desapercibido.
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => alternar(ruta.id)}
                      aria-expanded={abierta}
                      aria-controls={`zonas-${ruta.id}`}
                      aria-label={
                        abierta ? "Ocultar el retiro por lugar" : "Ver el retiro por lugar"
                      }
                      title={abierta ? "Ocultar el retiro por lugar" : "Ver el retiro por lugar"}
                      className="h-7 w-7 border-primary/40 bg-primary/5 text-primary hover:bg-primary/15 hover:text-primary"
                    >
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${abierta ? "" : "-rotate-90"}`}
                      />
                    </Button>
                  ) : null}
                </TableCell>

                {/* nowrap: la hora tiene que verse COMPLETA en una línea ("07:12
                    p. m."), y la marca de edición también. Partidas en dos
                    líneas dejaban la columna ilegible. */}
                <TableCell className="whitespace-nowrap px-3 py-3">
                  <span className="mono block text-xs font-semibold tabular-nums text-foreground">
                    {horaDe(ruta.fecha)}
                  </span>
                  {/* **Dice CUÁNDO se editó, no solo que se editó.** Una ruta
                      regenerada reemplaza su registro conservando la fecha
                      original (el historial ordena por día de planificación),
                      así que sin esta hora no queda rastro de que lo que se mira
                      no es lo que se generó esa mañana. */}
                  {ruta.editadoEn && (
                    <span
                      className="block text-[0.625rem] text-muted-foreground"
                      title={`Regenerada el ${fechaLarga(diaDe(ruta.editadoEn))} a las ${horaDe(ruta.editadoEn)}`}
                    >
                      editada {horaDe(ruta.editadoEn)}
                    </span>
                  )}
                </TableCell>

                <TableCell className="px-3 py-3">
                  <span className="block max-w-[18rem] truncate text-xs font-medium text-foreground">
                    {r.origenNombre ?? "Sin punto de origen"}
                    {r.recorridos > 1 && (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        y {r.recorridos - 1} más
                      </span>
                    )}
                  </span>
                  {/* Las zonas que quedaron fuera, si hubo: delata que el plan no
                      cubrió todo lo que se cargó, sin abrir la ruta. */}
                  {r.sinAsignar > 0 && (
                    <span className="mt-0.5 inline-block rounded-full bg-warning/15 px-2 py-0.5 text-[0.5625rem] font-medium text-warning-strong">
                      {r.sinAsignar} sin asignar
                    </span>
                  )}
                </TableCell>

                <TableCell className={`py-3 ${centro}`}>
                  <span
                    className={`inline-block rounded-full border px-2 py-0.5 text-[0.625rem] font-medium capitalize ${
                      ESTILO_ESTADO[ruta.estado] ?? ESTILO_ESTADO.generada
                    }`}
                  >
                    {ruta.estado}
                  </span>
                </TableCell>

                <TableCell className={`mono py-3 text-xs tabular-nums text-foreground ${centro}`}>
                  {entero(r.paradas)}
                </TableCell>

                <TableCell
                  className={`mono py-3 text-xs tabular-nums text-muted-foreground ${centro}`}
                >
                  {r.volumenM3 != null ? volumen(r.volumenM3) : "-"}
                </TableCell>

                {/* **Lo retirado es la cifra que manda cuando existe**, y queda
                    más fuerte que lo planificado. Una ruta cerrada sin cifra dice
                    "sin cifra" y no un 0: nadie midió. */}
                <TableCell className={`py-3 ${centro}`}>
                  {r.volumenRetiradoM3 != null ? (
                    <>
                      <span className="mono block text-xs font-semibold tabular-nums text-foreground">
                        {volumen(r.volumenRetiradoM3)}
                      </span>
                      {Math.abs(diferencia) > 0.005 && (
                        <span className="mono block text-[0.5625rem] tabular-nums text-warning-strong">
                          {diferencia < 0 ? "-" : "+"}
                          {volumen(Math.abs(diferencia))} vs plan
                        </span>
                      )}
                    </>
                  ) : ruta.estado === "terminada" ? (
                    <span className="text-[0.625rem] text-muted-foreground">sin cifra</span>
                  ) : (
                    <span className="mono text-xs text-muted-foreground">-</span>
                  )}
                </TableCell>

                <TableCell
                  className={`mono hidden py-3 text-xs tabular-nums text-muted-foreground xl:table-cell ${centro}`}
                >
                  {r.distanciaKm != null ? cifra(r.distanciaKm) : "-"}
                </TableCell>
                <TableCell
                  className={`mono hidden py-3 text-xs tabular-nums text-muted-foreground xl:table-cell ${centro}`}
                >
                  {r.duracionHoras != null ? cifra(r.duracionHoras) : "-"}
                </TableCell>
                <TableCell
                  className={`mono hidden py-3 text-xs tabular-nums text-muted-foreground xl:table-cell ${centro}`}
                >
                  {entero(r.viajes)}
                </TableCell>

                <TableCell className="px-3 py-3">
                  {/* El orden es el que se pidió: primero VER, al final la
                      papelera, y en medio lo que cambia el estado y editar. */}
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => onAbrir(ruta)}
                      className="h-7 px-3 text-[0.6875rem] font-semibold"
                    >
                      {abriendo === ruta.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "Ver"
                      )}
                    </Button>

                    {ocupada ? (
                      <Loader2 className="mx-2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    ) : (
                      // Los saltos posibles DESDE donde está, uno por botón. Se
                      // leen de la tabla espejada del backend, así que una ruta
                      // terminada no ofrece ninguno y no hay que acordarse de
                      // esconderlos a mano.
                      (TRANSICIONES[ruta.estado] ?? []).map((destino) => (
                        <Button
                          key={destino}
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onEstado(ruta, destino)}
                          title={VERBO_ESTADO[destino]}
                          className={`h-7 px-2.5 text-[0.6875rem] font-semibold ${BOTON_ESTADO[destino]}`}
                        >
                          {VERBO_CORTO[destino]}
                        </Button>
                      ))
                    )}

                    {/* Editar solo mientras la ruta no haya salido: una en curso
                        se cancela y una terminada es historia. El backend lo
                        vuelve a verificar; acá solo se evita ofrecer un botón que
                        va a ser rechazado. */}
                    {ruta.estado === "generada" && (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => onEditar(ruta)}
                        aria-label="Editar esta ruta"
                        title="Editar: la abre en Rutas para volver a generarla"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}

                    {/* **Se borra cualquiera menos una EN CURSO.** El historial
                        se llena de planes de prueba y de rutas canceladas que
                        nunca salieron, y eso es ruido sobre lo que sí se hizo. La
                        que no se borra es la que está en la calle ahora mismo:
                        esa se cancela. Va ÚLTIMA, lejos de "Ver". */}
                    {ruta.estado !== "en curso" && (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => onBorrar(ruta)}
                        aria-label="Eliminar esta ruta del historial"
                        title="Eliminar del historial"
                        className="h-7 w-7 border-destructive-strong/30 text-destructive-strong hover:bg-destructive/15 hover:text-destructive-strong"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>

              {abierta && (
                <TableRow
                  id={`zonas-${ruta.id}`}
                  className="border-b border-border/40 bg-muted/30 hover:bg-muted/30"
                >
                  <TableCell colSpan={12} className="px-6 py-3">
                    <TablaZonas zonas={zonas} estadoRuta={ruta.estado} />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Un plan guardado, en solo lectura.
 *
 *  **Reusa `RouteTimeline` sin modificarlo.** Es lo que justifica guardar la
 *  respuesta tal cual venía: reabrir un plan es pasarle el mismo objeto a los
 *  mismos componentes, sin una capa de traducción que podría desincronizarse.
 *
 *  La hora de salida es la de GENERACIÓN y no "ahora", así que las horas de
 *  llegada que muestra son las que ese plan calculó en su momento. Un plan
 *  cuyas horas cambian por volver a mirarlo no sirve para explicar qué se hizo. */
function DetalleRuta({ ruta, onVolver }: { ruta: RutaGuardadaCompleta; onVolver: () => void }) {
  const plan = ruta.plan;
  const salida = useMemo(() => new Date(ruta.fecha), [ruta.fecha]);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <div className="flex items-center gap-3 border-b border-border/25 px-6 py-4">
        <Button variant="ghost" size="icon" onClick={onVolver} aria-label="Volver al historial">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <p className="eyebrow">Historial</p>
          <h1 className="truncate text-xl font-semibold capitalize">
            {fechaLarga(diaDe(ruta.fecha))}
          </h1>
        </div>
      </div>

      <div className="flex-1 space-y-4 p-6">
        <p className="flex items-start gap-2 rounded-lg border border-warning-strong/40 bg-warning/10 px-3 py-2 text-[0.6875rem] leading-relaxed text-warning-strong">
          <TriangleAlert className="mt-px h-3.5 w-3.5 flex-shrink-0" />
          <span>
            Plan generado el {fechaLarga(diaDe(ruta.fecha))} a las {horaDe(ruta.fecha)}. Las horas
            de llegada son las que se calcularon entonces, no las de ahora.
          </span>
        </p>

        {/* **El volumen faltaba, y es la cifra por la que existe el plan.**
            Estaban paradas, distancia, duración y viajes, o sea todo menos
            cuánta basura se mueve. Va primero por eso.

            Y es DOS cifras cuando la ruta se cerró: lo planificado queda
            congelado al generar y lo retirado es lo que la cuadrilla anotó.
            Mostrando solo el primero, corregir una cifra al cerrar no se veía
            en ninguna parte. */}
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Cifra
            icono={Trash2}
            // **"Planificado" y no "Volumen" cuando la ruta se cerró sin cifra.**
            // La tarjeta mostraba lo planificado bajo el rótulo "Volumen", y en
            // una ruta ya terminada eso se leía como lo que salió.
            etiqueta={
              ruta.resumen.volumenRetiradoM3 != null
                ? "Retirado"
                : ruta.estado === "terminada"
                  ? "Planificado"
                  : "Volumen"
            }
            valor={
              ruta.resumen.volumenRetiradoM3 != null
                ? `${cifra(ruta.resumen.volumenRetiradoM3)} m³`
                : ruta.resumen.volumenM3 != null
                  ? `${cifra(ruta.resumen.volumenM3)} m³`
                  : "-"
            }
            nota={
              ruta.resumen.volumenRetiradoM3 != null && ruta.resumen.volumenM3 != null
                ? `se planificaron ${cifra(ruta.resumen.volumenM3)} m³`
                : ruta.estado === "terminada"
                  ? // **Dos cierres distintos que daban el mismo texto.** "Cerrar
                    // sin registrar" no guarda ninguna parada; "Cerrar y
                    // registrar" con todos los campos vacíos SÍ guarda cada una
                    // (con su casilla de completo) pero sin volumen medido.
                    // Decir "se cerró sin registrar" en el segundo contradice lo
                    // que se hizo: hay un registro por parada, falta la cifra.
                    (ruta.resumen.paradasRegistradas ?? 0) > 0
                    ? `${entero(ruta.resumen.paradasRegistradas ?? 0)} parada${
                        ruta.resumen.paradasRegistradas === 1 ? "" : "s"
                      } registrada${
                        ruta.resumen.paradasRegistradas === 1 ? "" : "s"
                      }, sin volumen medido`
                    : "se cerró sin registrar"
                  : undefined
            }
          />
          <Cifra icono={MapPin} etiqueta="Paradas" valor={entero(ruta.resumen.paradas)} />
          <Cifra
            icono={RouteIcon}
            etiqueta="Distancia"
            valor={ruta.resumen.distanciaKm != null ? `${cifra(ruta.resumen.distanciaKm)} km` : "-"}
          />
          <Cifra
            icono={Clock}
            etiqueta="Duración"
            valor={
              ruta.resumen.duracionHoras != null ? `${cifra(ruta.resumen.duracionHoras)} h` : "-"
            }
          />
          <Cifra icono={Truck} etiqueta="Viajes" valor={entero(ruta.resumen.viajes)} />
        </div>

        {/* **Cuánto salió de cada lugar.** Es lo que la cifra total no puede
            decir: "87 m³" no dice de dónde ni cuál lugar quedó corto. Sale del
            mismo desglose que la tabla del listado, así que las dos pantallas no
            pueden contradecirse. */}
        <section className="panel space-y-2 p-4">
          <h2 className="text-xs font-semibold text-foreground">Retiro por lugar</h2>
          <TablaZonas
            zonas={zonasDeRuta(ruta.resumen.zonas, plan?.stops)}
            estadoRuta={ruta.estado}
          />
        </section>

        {!plan || (plan.segments ?? []).length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 px-4 py-8 text-center text-xs text-muted-foreground">
            Este registro no tiene el detalle del recorrido.
          </p>
        ) : (
          (plan.segments ?? []).map((seg, i) => (
            <section key={i} className="panel space-y-3 p-4">
              <h2 className="text-xs font-semibold text-foreground">
                Recorrido {i + 1}
                <span className="ml-2 font-normal text-muted-foreground">{seg.originName}</span>
              </h2>
              <RouteTimeline segment={seg} stops={plan.stops} salida={salida} />
            </section>
          ))
        )}

        {/* Lo que quedó fuera, con su motivo tal como el plan lo escribió. Es
            parte del registro: un plan que dejó zonas afuera y no lo dice
            después parece haber cubierto todo. */}
        {(plan?.unassignedZones ?? []).length > 0 && (
          <section className="panel space-y-2 p-4">
            <h2 className="text-xs font-semibold text-warning-strong">
              {plan!.unassignedZones!.length} zona
              {plan!.unassignedZones!.length === 1 ? "" : "s"} sin asignar
            </h2>
            <ul className="space-y-1.5">
              {plan!.unassignedZones!.map((z, i) => (
                <li key={i} className="rounded-md border border-border/60 px-3 py-2">
                  <p className="text-xs font-medium text-foreground">{z.name}</p>
                  <p className="text-[0.625rem] leading-relaxed text-muted-foreground">
                    {z.reason}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function Cifra({
  icono: Icono,
  etiqueta,
  valor,
  nota,
}: {
  icono: (p: { className?: string }) => React.ReactElement;
  etiqueta: string;
  valor: string;
  /** Una línea de contexto bajo la cifra. La usa el volumen para decir contra
   *  qué se compara lo retirado, que es la mitad del dato: "35 m³" no significa
   *  nada sin saber que se planificaron 40. */
  nota?: string;
}) {
  return (
    <div className="panel flex items-center gap-3 p-3">
      <Icono className="h-4 w-4 flex-shrink-0 text-primary" />
      <div className="min-w-0">
        <p className="text-[0.5625rem] uppercase tracking-wide text-muted-foreground">{etiqueta}</p>
        <p className="mono text-sm font-semibold tabular-nums text-foreground">{valor}</p>
        {nota && <p className="truncate text-[0.5625rem] text-muted-foreground">{nota}</p>}
      </div>
    </div>
  );
}
