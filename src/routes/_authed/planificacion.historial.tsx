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

import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { CerrarRutaDialog } from "@/components/CerrarRutaDialog";
import { ConfirmarBorrado } from "@/components/ConfirmarBorrado";
import { RouteTimeline } from "@/components/RouteTimeline";
import {
  ArrowLeft,
  Clock,
  Loader2,
  MapPin,
  Pencil,
  Route as RouteIcon,
  Trash2,
  TriangleAlert,
  Truck,
} from "@/components/icons/Icons";
import { cifra, entero } from "@/lib/formato";
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
  const [aBorrar, setABorrar] = useState<RutaGuardada | null>(null);
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

  /** Las rutas agrupadas por día, en el orden en que llegaron (fecha
   *  descendente). Se arma con un `Map` y no ordenando claves, porque el
   *  backend ya devolvió el orden correcto y reordenar acá sería una segunda
   *  respuesta a la misma pregunta. */
  const porDia = useMemo(() => {
    const grupos = new Map<string, RutaGuardada[]>();
    for (const r of rutas) {
      const dia = diaDe(r.fecha);
      const previas = grupos.get(dia);
      if (previas) previas.push(r);
      else grupos.set(dia, [r]);
    }
    return Array.from(grupos.entries());
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

  const borrar = async () => {
    if (!aBorrar) return;
    try {
      await eliminarRuta(aBorrar.id);
      notify.success("Ruta eliminada", `Del ${fechaLarga(diaDe(aBorrar.fecha))}.`);
      await cargar();
    } catch (e) {
      // El backend se niega con 409 si la ruta ya salió a la calle, y ese
      // mensaje explica cuál es el caso. Se muestra tal cual en vez de
      // reescribirlo: la regla vive allá.
      notify.error("No se pudo eliminar", (e as Error).message);
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
            curso: lo que ves acá no despacha ningún camión. Para armar una ruta nueva, anda a
            Rutas.
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

        {cargando ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : porDia.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 px-4 py-10 text-center text-xs leading-relaxed text-muted-foreground">
            {diaElegido
              ? "No se generó ninguna ruta ese día."
              : "Todavía no se ha generado ninguna ruta. Las que generes en Rutas van a aparecer acá."}
          </p>
        ) : (
          porDia.map(([dia, delDia]) => (
            <section key={dia} className="space-y-1.5">
              {/* La fecha como ENCABEZADO del bloque, no como columna repetida
                  en cada fila. */}
              <h2 className="flex items-baseline gap-2 text-xs font-semibold capitalize text-foreground">
                {fechaLarga(dia)}
                <span className="text-[0.625rem] font-normal text-muted-foreground">
                  {delDia.length} ruta{delDia.length === 1 ? "" : "s"}
                </span>
              </h2>
              <ul className="space-y-1.5">
                {delDia.map((r) => (
                  <FilaRuta
                    key={r.id}
                    ruta={r}
                    abriendo={abriendo === r.id}
                    onAbrir={() => void abrir(r)}
                    onEditar={() => void editar(r)}
                    onBorrar={() => setABorrar(r)}
                    onEstado={(e) => void cambiarEstado(r, e)}
                    cambiando={cambiando === r.id}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
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
        titulo="Eliminar esta ruta del historial"
        descripcion={
          aBorrar ? (
            <>
              Se eliminará el plan generado el <strong>{fechaLarga(diaDe(aBorrar.fecha))}</strong> a
              las {horaDe(aBorrar.fecha)}. Esto no se puede deshacer.
              {/* **Hay que decir que se lleva el retiro**, porque cambia una
                  cifra fuera de esta pantalla: el volumen que Vista Principal
                  muestra de esa zona vuelve a subir. Borrarlo en silencio
                  dejaría a alguien buscando por qué cambió un número que él no
                  tocó. Y es la coherencia correcta: si la ruta no ocurrió, su
                  registro de lo retirado tampoco. */}
              {aBorrar.estado === "terminada" && aBorrar.resumen.volumenRetiradoM3 != null && (
                <>
                  {" "}
                  Se borrará también el retiro de{" "}
                  <strong>{cifra(aBorrar.resumen.volumenRetiradoM3)} m³</strong> que quedó
                  registrado al cerrarla, así que ese volumen vuelve a contarse en sus zonas.
                </>
              )}
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

/** Una ruta del historial. La fila entera abre el detalle; la papelera va
 *  aparte para que apretar "eliminar" no pueda confundirse con "abrir". */
function FilaRuta({
  ruta,
  abriendo,
  onAbrir,
  onEditar,
  onBorrar,
  onEstado,
  cambiando,
}: {
  ruta: RutaGuardada;
  abriendo: boolean;
  onAbrir: () => void;
  onEditar: () => void;
  onBorrar: () => void;
  onEstado: (estado: EstadoRuta) => void;
  cambiando: boolean;
}) {
  const r = ruta.resumen;
  return (
    <li className="flex items-stretch overflow-hidden rounded-lg border border-border/60 bg-background/60 transition-colors hover:border-primary/40 hover:bg-primary/5">
      <button
        type="button"
        onClick={onAbrir}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-3 py-2.5 text-left"
      >
        <span className="mono flex-shrink-0 text-xs tabular-nums text-muted-foreground">
          {horaDe(ruta.fecha)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground">
            {r.origenNombre ?? "Sin punto de origen"}
            {r.recorridos > 1 && (
              <span className="font-normal text-muted-foreground"> y {r.recorridos - 1} más</span>
            )}
          </span>
          <span className="block text-[0.625rem] text-muted-foreground">
            {[
              `${entero(r.paradas)} parada${r.paradas === 1 ? "" : "s"}`,
              // **Lo retirado manda cuando existe.** Una ruta cerrada seguía
              // anunciando el volumen PLANIFICADO, así que corregir una cifra
              // al cerrar no se veía en ninguna parte. Cuando difieren se
              // imprimen las dos, porque la diferencia entre lo que se iba a
              // sacar y lo que salió es justamente el dato que este registro
              // existe para conservar.
              r.volumenRetiradoM3 != null
                ? r.volumenM3 != null && Math.abs(r.volumenRetiradoM3 - r.volumenM3) > 0.005
                  ? `${cifra(r.volumenRetiradoM3)} m³ retirados de ${cifra(r.volumenM3)}`
                  : `${cifra(r.volumenRetiradoM3)} m³ retirados`
                : r.volumenM3 != null
                  ? `${cifra(r.volumenM3)} m³`
                  : null,
              r.distanciaKm != null ? `${cifra(r.distanciaKm)} km` : null,
              r.duracionHoras != null ? `${cifra(r.duracionHoras)} h` : null,
              // Los viajes solo cuando hay más de uno: con uno, la columna
              // nunca diría nada. Mismo criterio que la medida "Viajes" del
              // detalle de un recorrido.
              r.viajes > 1 ? `${entero(r.viajes)} viajes` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>

        {/* Las zonas que quedaron fuera, si hubo. Es lo que delata que el plan
            no cubrió todo lo que se cargó, y leerlo acá evita tener que abrir
            cada ruta para descubrirlo. */}
        {r.sinAsignar > 0 && (
          <span className="flex-shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[0.625rem] font-medium text-warning-strong">
            {r.sinAsignar} sin asignar
          </span>
        )}
        {/* **Dice CUÁNDO se editó, no solo que se editó.** Una ruta regenerada
            reemplaza su registro conservando la fecha original (el historial
            ordena por día de planificación), así que sin esta hora no queda
            rastro de que lo que se está mirando no es lo que se generó esa
            mañana. */}
        {ruta.editadoEn && (
          <span
            className="flex-shrink-0 text-[0.625rem] text-muted-foreground"
            title={`Regenerada el ${fechaLarga(diaDe(ruta.editadoEn))} a las ${horaDe(ruta.editadoEn)}`}
          >
            editada {horaDe(ruta.editadoEn)}
          </span>
        )}
        <span
          className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[0.625rem] font-medium capitalize ${
            ESTILO_ESTADO[ruta.estado] ?? ESTILO_ESTADO.generada
          }`}
        >
          {ruta.estado}
        </span>
        {abriendo && <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-primary" />}
      </button>

      {/* Solo se puede borrar lo que todavía no salió. El backend lo vuelve a
          verificar: la regla vive allá y acá solo se evita ofrecer un botón que
          va a ser rechazado. */}
      {/* Los saltos posibles DESDE donde está, uno por botón. Se leen de la
          tabla espejada del backend, así que una ruta terminada no ofrece
          ninguno y no hay que acordarse de esconderlos a mano.

          **Dicen el verbo y no el estado**: "Despachar" dice lo que va a
          pasar, "en curso" obliga a deducirlo. */}
      {cambiando ? (
        <span className="flex w-10 flex-shrink-0 items-center justify-center border-l border-border/50">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        </span>
      ) : (
        (TRANSICIONES[ruta.estado] ?? []).map((destino) => (
          <button
            key={destino}
            type="button"
            onClick={() => onEstado(destino)}
            title={VERBO_ESTADO[destino]}
            className={`flex flex-shrink-0 cursor-pointer items-center border-l border-border/50 px-2.5 text-[0.625rem] font-medium transition-colors ${
              destino === "cancelada"
                ? "text-muted-foreground hover:bg-destructive/15 hover:text-destructive-strong"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            {VERBO_ESTADO[destino]}
          </button>
        ))
      )}

      {/* **Editar y eliminar solo mientras la ruta no haya salido.** Una en
          curso se cancela y una terminada es historia: reescribir lo que ya
          ocurrió es la misma regla que impide mutar un análisis guardado. El
          backend lo vuelve a verificar; acá solo se evita ofrecer un botón que
          va a ser rechazado. */}
      {ruta.estado === "generada" && (
        <button
          type="button"
          onClick={onEditar}
          aria-label="Editar esta ruta"
          title="Editar: la abre en Rutas para volver a generarla"
          className="flex w-10 flex-shrink-0 cursor-pointer items-center justify-center border-l border-border/50 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
      {/* **Se borra cualquiera menos una EN CURSO.** La regla era más estricta
          y solo dejaba borrar las editables, con el argumento de que la
          historia no se borra por conveniencia; no se sostiene, porque el
          historial se llena de planes de prueba y de rutas canceladas que nunca
          salieron, y eso no es historia sino ruido sobre lo que sí se hizo. La
          garantía de que quede rastro la da la bitácora. La que no se borra es
          la que está en la calle ahora mismo: esa se cancela. */}
      {ruta.estado !== "en curso" && (
        <button
          type="button"
          onClick={onBorrar}
          aria-label="Eliminar esta ruta del historial"
          title="Eliminar del historial"
          className="flex w-10 flex-shrink-0 cursor-pointer items-center justify-center border-l border-border/50 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive-strong"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
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
            etiqueta={ruta.resumen.volumenRetiradoM3 != null ? "Retirado" : "Volumen"}
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
                  ? "se cerró sin registrar"
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
