// =============================================================================
// CONDORFINDER, LÍNEA DE TIEMPO DE UNA RUTA (HDU5 + HDU5.1)
// Archivo: src/components/RouteTimeline.tsx
//
// El plan leído de arriba abajo: sale del punto, pasa por cada zona, vuelve.
//
// Reemplaza a la lista numerada que había antes, que solo daba el nombre de
// cada parada. Una ruta no es un conjunto de paradas, es una SECUENCIA con
// distancias y tiempos entre ellas, y eso es justo lo que una lista no puede
// mostrar: el dato del tramo no pertenece a ninguna de las dos paradas que
// une, pertenece al espacio entre ambas. Acá ese espacio existe, es la fila del
// tramo, y es donde van los km y los minutos.
//
// ── El riel ──
// La línea vertical es UNA sola y atraviesa todas las filas, en vez de un
// trocito dibujado entre cada par de nodos. La diferencia se ve: por trozos, la
// línea nace y muere en cada fila, así que queda un corte a la altura de cada
// círculo y el recorrido se lee como pasos sueltos en vez de como un camino.
//
// El mecanismo: TODA fila, sea nodo o tramo, tiene una columna de riel del
// ancho del círculo, con una línea absoluta de alto completo. Apiladas, esas
// líneas forman una continua. Los círculos van encima con fondo opaco, así que
// la tapan justo donde corresponde. La primera fila arranca su línea en el
// centro del círculo y la última la termina ahí, para que el riel no sobresalga
// por los extremos.
//
// Las filas se arman como DATOS (marcador + contenido) antes de dibujarse, no
// como componentes que se pasan el marcador entre ellos: una fila necesita
// saber si es la primera o la última para recortar su riel, y eso solo se sabe
// cuando la lista está completa.
//
// Los datos de HDU5.1 (vehículo, dotación) se muestran SOLO cuando el backend
// los manda. Mientras no lleguen, el timeline dibuja lo que hay y no deja
// huecos con guiones esperando un dato, que es la misma regla que sigue el
// resto de la vista.
// =============================================================================

import { useEffect, useRef } from "react";

import { ImageIcon, Truck, Users, Warehouse } from "@/components/icons/Icons";
import type { TramoDeMapa } from "@/components/route-colors";
import type {
  RoutePlanLeg,
  RoutePlanSegment,
  RoutePlanStop,
  RoutePlanVehicle,
} from "@/lib/routePlan";
import { cifra, peso, volumen } from "@/lib/formato";

/** Lo que la vista sabe de cada zona y el timeline no: dónde queda, cuánto
 *  hay y de qué es. */
export interface DatosDeParada {
  /** Lo que se retira en esta parada. Con un retiro parcial NO es el volumen de
   *  la zona, que viaja aparte en `zoneVolumeM3`. */
  volumeM3: number;
  /** Lo que el camión va a cargar de verdad. El volumen dice si entra en la
   *  tolva; el peso dice si el vehículo lo aguanta, que es otra restricción
   *  (AC4) y hasta ahora no se veía en el plan. */
  weightKg?: number;
  /** El volumen TOTAL de la zona, solo cuando el retiro es parcial. Es el
   *  contexto de la cifra de arriba: "se retiran 8,00 de 12,40 m³". */
  zoneVolumeM3?: number;
  /** Lo que queda en la zona después de este retiro, solo cuando hay resto.
   *  Es el dato que convierte una parada en una visita pendiente, así que se
   *  dice explícito en vez de dejarlo a la resta del lector. */
  pendingM3?: number;
  /** TODOS los tipos presentes en la zona, con su volumen, de mayor a menor.
   *  Antes viajaba solo el dominante, y una zona con cuatro tipos se anunciaba
   *  como si tuviera uno: el trabajador que va a cargar necesita saber con qué
   *  se va a encontrar, no cuál predomina. */
  wasteTypes?: [string, number][];
  wasteColor?: (clase: string) => string | undefined;
  direccion?: string;
}

/** Centro del círculo de un nodo, medido desde el borde superior de su fila.
 *  Es la mitad de su alto (1.75rem), y es donde las filas de los extremos
 *  recortan el riel. */
const MEDIO_NODO = "0.875rem";

interface Fila {
  /** El círculo del nodo, o null si la fila es un tramo (solo riel). */
  marcador: React.ReactNode;
  contenido: React.ReactNode;
  /** Hora estimada de llegada a este nodo. Solo la llevan los nodos. */
  hora?: string;
  /** Qué tramo del mapa es esta fila, si es una fila de tramo. Es lo que
   *  empareja la fila con su trazo: apretar uno resalta el otro. */
  tramo?: TramoDeMapa;
}

function horas(h: number): string {
  if (h <= 0) return "0 min";
  const min = Math.round(h * 60);
  if (min < 60) return `${min} min`;
  const enteras = Math.floor(min / 60);
  const resto = min % 60;
  return resto === 0 ? `${enteras} h` : `${enteras} h ${resto} min`;
}

function km(d: number): string {
  return `${d.toFixed(1)} km`;
}

/** La hora de Santiago a la que se llega, sumando horas a la salida.
 *
 *  La zona horaria va EXPLÍCITA y no se deja al navegador: el plan es para una
 *  cuadrilla que sale en Maipú, así que la hora tiene que ser la de Maipú
 *  aunque el equipo que la mira esté configurado en otra zona. Y con zona
 *  explícita el cambio de horario de verano lo resuelve el navegador solo, en
 *  vez de arrastrar un desfase de una hora medio año. */
function horaDeLlegada(salida: Date, horasTranscurridas: number): string {
  const t = new Date(salida.getTime() + horasTranscurridas * 3600_000);
  return t.toLocaleTimeString("es-CL", {
    timeZone: "America/Santiago",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** El tramo que va de `desde` a `hasta`, si el backend mandó el desglose. */
function buscarTramo(
  legs: RoutePlanLeg[] | undefined,
  desde: number | null,
  hasta: number | null,
): RoutePlanLeg | undefined {
  return legs?.find((l) => l.fromOrder === desde && l.toOrder === hasta);
}

/** El círculo de un nodo. Fondo opaco a propósito: es lo que interrumpe el riel
 *  justo donde pasa un punto del recorrido. */
function Circulo({
  orden,
  icono,
  destacado = false,
}: {
  orden?: number;
  icono?: React.ReactNode;
  destacado?: boolean;
}) {
  return (
    <span
      className={`relative z-10 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${
        destacado
          ? "bg-primary text-primary-foreground"
          : "border border-border bg-card text-foreground/70"
      }`}
    >
      {orden !== undefined ? (
        <span className="mono text-[0.625rem] font-semibold tabular-nums">{orden}</span>
      ) : (
        icono
      )}
    </span>
  );
}

/** El contenido de una fila de tramo: cuánto cuesta recorrerlo. */
function Tramo({
  tramo,
  respaldo,
  etiqueta,
  color,
}: {
  tramo?: RoutePlanLeg;
  respaldo?: { distanceKm: number; durationHours: number };
  etiqueta?: string;
  /** Color del recorrido: tiñe las pastillas para emparejarlas con su trazo. */
  color?: string;
}) {
  const datos = tramo ?? respaldo;
  // Sin cifras, la fila igual ocupa alto: es lo que mantiene el riel visible
  // entre dos paradas mientras el backend no mande el desglose por tramo.
  if (!datos) return <span className="block h-5" />;
  return (
    <span className="flex items-center gap-2 py-2">
      {/* Cada cifra en su pastilla, y ahora con peso: el minutaje y los
          kilómetros son EL dato de un tramo, y en 0,625 rem tenue se leían
          como una nota al pie. Más grandes, en seminegrita y teñidas con el
          color del recorrido, que es el del trazo en el mapa. */}
      <span
        className="mono rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums text-foreground"
        style={{ backgroundColor: color ? `${color}24` : "var(--muted)" }}
      >
        {horas(datos.durationHours)}
      </span>
      <span
        className="mono rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums text-foreground"
        style={{ backgroundColor: color ? `${color}24` : "var(--muted)" }}
      >
        {km(datos.distanceKm)}
      </span>
      {etiqueta && (
        <span className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
          {etiqueta}
        </span>
      )}
    </span>
  );
}

/** Un vehículo asignado al recorrido: patente, tipo, capacidad y su dotación.
 *
 *  Es un <button> cuando tiene foto, y abre la imagen. Un trabajador reconoce
 *  "el ampliroll amarillo" antes que "KBVZ-41", así que la foto es lo que
 *  convierte una patente en un vehículo identificable en el patio. Sin foto es
 *  un <span> y no finge ser apretable: 8 de las 21 unidades de la flota real no
 *  tienen imagen cargada, y un botón que no hace nada es peor que ninguno. */
function Vehiculo({
  vehiculo,
  onVerFoto,
}: {
  vehiculo: RoutePlanVehicle;
  onVerFoto?: (v: RoutePlanVehicle) => void;
}) {
  const puedeVerFoto = Boolean(vehiculo.foto && onVerFoto);
  const cuerpo = (
    <>
      <span className="flex items-center gap-1.5">
        <Truck className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        <span className="mono text-[0.6875rem] font-medium text-foreground">
          {vehiculo.patente}
        </span>
        <span className="min-w-0 truncate text-[0.6875rem] text-muted-foreground">
          {vehiculo.tipo}
        </span>
        {vehiculo.capacityM3 != null && (
          <span className="mono flex-shrink-0 text-[0.625rem] tabular-nums text-muted-foreground">
            {cifra(vehiculo.capacityM3)} m³
          </span>
        )}
        {/* El ícono de imagen avisa que la fila se puede apretar. Sin él, que
            una fila abra una foto y la de al lado no es invisible. */}
        {puedeVerFoto && (
          <ImageIcon className="h-3 w-3 flex-shrink-0 text-muted-foreground opacity-70" />
        )}
      </span>
      {vehiculo.crew && vehiculo.crew.length > 0 && (
        <span className="mt-0.5 flex items-center gap-1.5 pl-[1.125rem] text-[0.625rem] text-muted-foreground">
          <Users className="h-3 w-3 flex-shrink-0" />
          {vehiculo.crew.join(", ")}
        </span>
      )}
    </>
  );

  if (!puedeVerFoto) return <span className="block">{cuerpo}</span>;
  return (
    <button
      type="button"
      onClick={() => onVerFoto?.(vehiculo)}
      title={`Ver la foto de ${vehiculo.patente}`}
      className="-mx-1.5 block w-[calc(100%+0.75rem)] cursor-pointer rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-muted/60"
    >
      {cuerpo}
    </button>
  );
}

export function RouteTimeline({
  segment,
  stops,
  datosDeParada,
  onStopClick,
  onVerFoto,
  salida,
  color,
  tramoActivo,
  onTramoClick,
}: {
  segment: RoutePlanSegment;
  /** Las paradas del PLAN COMPLETO. El componente se queda con las suyas.
   *
   *  **El filtrado vive acá y no en quien llama**, y eso es lo que corrige el
   *  defecto: las dos vistas que montan este componente (`/rutas` y el
   *  historial) le pasaban la lista entera, lo que era correcto por accidente
   *  mientras un plan tenía un solo recorrido. Con los convoyes paralelos cada
   *  recorrido dibujaba la unión de las paradas. Arreglarlo en los dos lugares
   *  habría dejado la misma regla escrita dos veces, lista para separarse en el
   *  tercero. */
  stops: RoutePlanStop[];
  /** Resuelve qué zona es cada parada. Es una FUNCIÓN y no un mapa por id
   *  porque un plan viejo puede no traer `stopId` en la parada, así que
   *  quien llama necesita poder caer a emparejar por nombre. Esa decisión es
   *  suya, no del timeline. */
  datosDeParada?: (stop: RoutePlanStop) => DatosDeParada | undefined;
  onStopClick?: (stop: RoutePlanStop) => void;
  /** Abre la foto de un vehículo. Sin este manejador las filas de vehículo no
   *  se dibujan como apretables, aunque traigan `foto`. */
  onVerFoto?: (v: RoutePlanVehicle) => void;
  /** Momento en que se sale del punto. Es el instante en que se generó el
   *  plan, no "ahora": si fuera "ahora" las horas correrían solas mientras el
   *  trabajador lee la pantalla, y un plan cuyas horas cambian solo por mirarlo
   *  no es un plan. */
  salida?: Date;
  /** El color del recorrido, para teñir el tramo resaltado. */
  color?: string;
  /** El tramo resaltado, elegido desde el mapa o desde esta lista. */
  tramoActivo?: TramoDeMapa | null;
  /** Se aprieta la fila de un tramo. Sin este manejador las filas no son
   *  apretables. */
  onTramoClick?: (tramo: TramoDeMapa) => void;
}) {
  const { legs } = segment;
  const lista = useRef<HTMLOListElement>(null);
  // Cuando el tramo se elige desde el mapa, su fila puede estar fuera de la
  // zona visible del panel: se la trae a la vista.
  useEffect(() => {
    if (!tramoActivo) return;
    lista.current
      ?.querySelector(`[data-tramo="${tramoActivo.tipo}-${tramoActivo.indice}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [tramoActivo]);
  // Posición del próximo traslado dentro del recorrido (los traslados vienen
  // aplanados, así que el orden de aparición es su índice).
  let traslados = 0;
  const vehiculos = segment.vehicles ?? [];
  // ── Las paradas de ESTE recorrido ──
  //
  // Tres caminos, en orden de confianza. El primero es el único que no deduce
  // nada: el backend dice cuáles son suyas. El segundo es para los planes
  // guardados antes de ese campo, y sale de los saltos, que ya traen el `order`
  // de destino de cada uno. El tercero es la lista entera, que es exactamente
  // como se veía ese plan el día que se guardó, así que un historial viejo no
  // cambia de contenido por este arreglo.
  const propias = (() => {
    if (segment.stopOrders && segment.stopOrders.length > 0) {
      const porOrden = new Map(stops.map((s) => [s.order, s]));
      // Se recorre `stopOrders` y no `stops` porque ese arreglo YA está en orden
      // de visita, y es el orden en que la cuadrilla las va a hacer.
      return segment.stopOrders
        .map((o) => porOrden.get(o))
        .filter((s): s is RoutePlanStop => s !== undefined);
    }
    const deLosSaltos = new Set((legs ?? []).map((l) => l.toOrder));
    if (deLosSaltos.size > 0) return stops.filter((s) => deLosSaltos.has(s.order));
    return stops;
  })();
  const filas: Fila[] = [];
  // Reloj acumulado del recorrido, en horas desde la salida. Va sumando cada
  // tramo a medida que se arman las filas, así que cada nodo conoce la hora a
  // la que se llega a él.
  let transcurrido = 0;

  filas.push({
    hora: salida ? horaDeLlegada(salida, 0) : undefined,
    marcador: <Circulo icono={<Truck className="h-3.5 w-3.5" />} destacado />,
    contenido: (
      <span className="block py-1">
        <span className="block text-xs font-semibold text-foreground">Salida</span>
        <span className="block truncate text-[0.6875rem] text-muted-foreground">
          {segment.originName}
        </span>
        {/* Los vehículos van en la salida y no repetidos en cada parada: son
            los mismos todo el recorrido, y repetirlos por parada convertiría el
            dato en ruido.

            Van TODOS, uno por fila, cada uno con su patente, su tipo, su
            capacidad y su propia dotación. Antes se mostraba uno solo y
            únicamente cuando el tramo lo recorría un camión; con dos o más la
            fila caía a "2 camiones", que dice cuántos son y nada de cuáles,
            justo en el plan que la cuadrilla usa para saber qué sacar del
            patio. Una fila por vehículo y no todo en una línea porque cada uno
            trae cuatro datos: en una sola línea, con dos camiones, no se sabría
            qué dotación es de cuál. */}
        {vehiculos.length > 0 ? (
          <span className="mt-1.5 block space-y-1">
            {vehiculos.map((v, i) => (
              <Vehiculo
                key={v.resourceId ?? `${v.patente}-${i}`}
                vehiculo={v}
                onVerFoto={onVerFoto}
              />
            ))}
          </span>
        ) : (
          // Respaldo para un plan generado por una versión anterior del
          // backend, que mandaba la cantidad y no las unidades.
          <span className="mt-1 block text-[0.6875rem] text-muted-foreground">
            <span className="mono tabular-nums">{segment.trucksUsed}</span> camión
            {segment.trucksUsed === 1 ? "" : "es"}
          </span>
        )}
      </span>
    ),
  });

  // Las descargas con su detalle, y cuántos viajes tiene el recorrido.
  //
  // `descargas` viene vacía en un plan generado por una versión anterior del
  // backend; en ese caso `viajes` queda en 1 y todo se comporta como antes.
  const descargas = segment.disposals ?? [];
  const viajes = segment.trips ?? 1;

  propias.forEach((stop, i) => {
    // **El depósito intermedio va ANTES de la parada que abre el viaje nuevo.**
    //
    // Es el reflejo exacto de cómo el backend lo decidió: el convoy no puede
    // con esta zona, así que pasa por el relleno y recién después viene acá.
    // Insertarlo después de la parada anterior daría la misma secuencia, pero
    // el separador quedaría del lado equivocado y el tiempo del depósito se
    // sumaría a la llegada de la parada que ya ocurrió.
    const viajeDeEsta = stop.trip ?? 1;
    const viajeAnterior = i > 0 ? (propias[i - 1].trip ?? 1) : viajeDeEsta;
    if (viajeDeEsta !== viajeAnterior) {
      const descarga = descargas.find((d) => d.afterOrder === propias[i - 1].order);
      filas.push({
        marcador: null,
        tramo: { tipo: "descarga", indice: viajeAnterior - 1 },
        contenido: (
          <Tramo
            color={color}
            respaldo={
              descarga
                ? { distanceKm: descarga.distanceKm, durationHours: descarga.durationHours }
                : undefined
            }
            etiqueta="cargado"
          />
        ),
      });
      transcurrido += descarga?.durationHours ?? 0;
      filas.push({
        hora: salida ? horaDeLlegada(salida, transcurrido) : undefined,
        marcador: <Circulo icono={<Warehouse className="h-3.5 w-3.5" />} />,
        contenido: (
          <span className="block py-1">
            <span className="block text-xs font-semibold text-foreground">
              Descarga
              <span className="ml-1.5 font-normal text-muted-foreground">
                fin del viaje {viajeAnterior}
              </span>
            </span>
            <span className="block truncate text-[0.6875rem] text-muted-foreground">
              {segment.disposalName ?? "Relleno sanitario"}
            </span>
          </span>
        ),
      });
      // El separador: la cuadrilla necesita saber cuántas veces vuelve, y un
      // nodo de descarga repetido sin este rótulo se lee como si el recorrido
      // se hubiera dibujado dos veces.
      filas.push({
        marcador: null,
        contenido: (
          <span className="mt-1 block border-t border-dashed border-border/60 pt-2 text-[0.625rem] font-semibold uppercase tracking-wide text-muted-foreground">
            Viaje {viajeDeEsta} de {viajes}
          </span>
        ),
      });
    }

    // **Sin `datosDeParada`, la parada se describe con lo que ella misma trae.**
    //
    // Ese prop enriquece la fila con el contexto de la zona (sus tipos de
    // residuo, su dirección, su volumen total), que solo tiene quien cargó los
    // análisis. El historial no los tiene, y por eso un plan reabierto no
    // mostraba el volumen de ninguna parada: la fila entera dependía de un dato
    // opcional, cuando la parada **ya trae** lo retirado, su peso y su
    // pendiente. El respaldo vive acá y no en el historial para que cualquier
    // consumidor futuro lo tenga sin acordarse de pasarlo.
    const datos: DatosDeParada | undefined =
      datosDeParada?.(stop) ??
      (stop.removedVolumeM3 != null
        ? {
            volumeM3: stop.removedVolumeM3,
            weightKg: stop.removedWeightKg ?? undefined,
            pendingM3: stop.pendingVolumeM3 ?? undefined,
          }
        : undefined);
    const tramo = buscarTramo(legs, i === 0 ? null : propias[i - 1].order, stop.order);
    transcurrido += tramo?.durationHours ?? (i === 0 ? segment.outboundDurationHours : 0);
    // Un tramo hacia la primera parada de un viaje es la IDA de ese viaje; hacia
    // cualquier otra parada del mismo viaje, un traslado entre zonas.
    const abreViaje = i === 0 || viajeDeEsta !== viajeAnterior;
    filas.push({
      marcador: null,
      tramo: abreViaje
        ? { tipo: "ida", indice: viajeDeEsta - 1 }
        : { tipo: "traslado", indice: traslados++ },
      contenido: (
        <Tramo
          color={color}
          tramo={tramo}
          // Sin desglose por tramo, el primero hereda la ida completa: es el
          // único reparto honesto, porque el total de ida es exactamente lo
          // que se recorre hasta la primera parada cuando hay una sola, y una
          // aproximación declarada cuando hay varias.
          respaldo={
            i === 0
              ? {
                  distanceKm: segment.outboundDistanceKm,
                  durationHours: segment.outboundDurationHours,
                }
              : undefined
          }
        />
      ),
    });

    const cuerpo = (
      <>
        <span className="block truncate text-xs font-semibold text-foreground">{stop.label}</span>
        {datos?.direccion && (
          <span className="block truncate text-[0.6875rem] text-muted-foreground">
            {datos.direccion}
          </span>
        )}
        {datos && (
          <>
            <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem]">
              <span className="mono font-semibold tabular-nums text-foreground">
                {datos.volumeM3.toFixed(2)}
                {/* Con retiro parcial, el total de la zona va pegado a lo que se
                    retira y en muted: la cifra que se ejecuta es la primera, la
                    segunda explica por qué queda un resto. La unidad se imprime
                    una sola vez, al final, porque son la misma magnitud. */}
                {datos.zoneVolumeM3 != null && (
                  <span className="font-normal text-muted-foreground">
                    {" de "}
                    {datos.zoneVolumeM3.toFixed(2)}
                  </span>
                )}
                {" m³"}
              </span>
              {/* El peso al lado del volumen, en muted: son dos magnitudes de la
                  misma carga y dos restricciones distintas del vehículo. */}
              {datos.weightKg != null && (
                <span className="mono tabular-nums text-muted-foreground">
                  {datos.weightKg >= 1000
                    ? `${(datos.weightKg / 1000).toFixed(2)} t`
                    : `${peso(datos.weightKg)} kg`}
                </span>
              )}
            </span>
            {/* El resto que queda en la zona. En ámbar y con su propia línea,
                no como un paréntesis más: significa que esta zona hay que
                volver a visitarla, y eso no es un detalle de la parada sino
                trabajo que queda abierto. */}
            {datos.pendingM3 != null && datos.pendingM3 > 0 && (
              <span className="mt-1 block text-[0.6875rem] text-warning-strong">
                Quedan{" "}
                <span className="mono font-semibold tabular-nums">
                  {volumen(datos.pendingM3)} m³
                </span>{" "}
                en la zona
              </span>
            )}
            {/* Todos los tipos, no solo el dominante. Cada uno con su volumen,
                porque "tiene plástico" y "tiene 3 m³ de plástico" no dicen lo
                mismo a quien va a cargar. */}
            {datos.wasteTypes && datos.wasteTypes.length > 0 && (
              <span
                className="mt-1 flex flex-wrap items-center gap-1"
                title={datos.wasteTypes.map(([c, v]) => `${c}: ${cifra(v)} m³`).join("\n")}
              >
                {datos.wasteTypes.slice(0, 2).map(([clase, vol]) => (
                  <span
                    key={clase}
                    className="flex min-w-0 items-center gap-1.5 rounded-full bg-muted/70 py-0.5 pl-1.5 pr-2"
                  >
                    <span
                      className="h-2 w-2 flex-shrink-0 rounded-full"
                      style={{
                        background: datos.wasteColor?.(clase) ?? "var(--muted-foreground)",
                      }}
                    />
                    <span className="min-w-0 truncate text-[0.625rem] text-foreground/80">
                      {clase}
                    </span>
                    <span className="mono flex-shrink-0 text-[0.5625rem] tabular-nums text-muted-foreground">
                      {vol.toFixed(1)}
                    </span>
                  </span>
                ))}
                {/* El resto se resume: el detalle completo está en el
                    tooltip y en la ficha de la zona, y cuatro píldoras por
                    parada saturaban el recorrido. */}
                {datos.wasteTypes.length > 2 && (
                  <span className="mono text-[0.625rem] tabular-nums text-muted-foreground">
                    +{datos.wasteTypes.length - 2}
                  </span>
                )}
              </span>
            )}
          </>
        )}
      </>
    );

    filas.push({
      hora: salida ? horaDeLlegada(salida, transcurrido) : undefined,
      marcador: <Circulo orden={stop.order} />,
      contenido: onStopClick ? (
        <button
          type="button"
          onClick={() => onStopClick(stop)}
          title="Centrar el mapa en esta zona"
          className="-mx-1.5 block w-[calc(100%+0.75rem)] cursor-pointer rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/60"
        >
          {cuerpo}
        </button>
      ) : (
        <span className="block py-1">{cuerpo}</span>
      ),
    });
  });

  // ── La última descarga ──
  // El recorrido no vuelve cargado al patio: descarga primero. Es la geometría
  // que la municipalidad describió por escrito, y el nodo existe para que el
  // plan la diga en vez de dejar la vuelta como si fuera directa.
  //
  // Las descargas INTERMEDIAS (cuando el convoy se llena y vuelve a salir) se
  // insertan arriba, dentro del recorrido de las paradas. Acá va solo la
  // última, que es la que precede al regreso.
  //
  // Se dibuja solo si el backend mandó el tramo: un plan generado por una
  // versión anterior no lo trae, y fabricar el nodo con el relleno supuesto
  // afirmaría un recorrido que ese plan no calculó ni contó en sus horas.
  const hayDescarga = segment.disposalDurationHours != null;

  if (hayDescarga) {
    // Con el detalle por viaje, la última descarga trae su propio tiempo; sin
    // él (plan viejo, un solo viaje) cae al total, que es lo mismo.
    const ultima = descargas.length > 0 ? descargas[descargas.length - 1] : null;
    filas.push({
      marcador: null,
      tramo: { tipo: "descarga", indice: viajes - 1 },
      contenido: (
        <Tramo
          color={color}
          respaldo={{
            distanceKm: ultima?.distanceKm ?? segment.disposalDistanceKm ?? 0,
            durationHours: ultima?.durationHours ?? segment.disposalDurationHours ?? 0,
          }}
          etiqueta="cargado"
        />
      ),
    });
    transcurrido += ultima?.durationHours ?? segment.disposalDurationHours ?? 0;
    filas.push({
      hora: salida ? horaDeLlegada(salida, transcurrido) : undefined,
      marcador: <Circulo icono={<Warehouse className="h-3.5 w-3.5" />} />,
      contenido: (
        <span className="block py-1">
          <span className="block text-xs font-semibold text-foreground">
            Descarga
            {viajes > 1 && (
              <span className="ml-1.5 font-normal text-muted-foreground">
                fin del viaje {viajes}
              </span>
            )}
          </span>
          <span className="block truncate text-[0.6875rem] text-muted-foreground">
            {segment.disposalName ?? "Relleno sanitario"}
          </span>
        </span>
      ),
    });
  }

  filas.push({
    marcador: null,
    tramo: { tipo: "regreso", indice: 0 },
    contenido: (
      <Tramo
        color={color}
        tramo={buscarTramo(
          legs,
          propias.length > 0 ? propias[propias.length - 1].order : null,
          null,
        )}
        respaldo={{
          distanceKm: segment.returnDistanceKm,
          durationHours: segment.returnDurationHours,
        }}
        etiqueta={hayDescarga ? "vacío" : "regreso"}
      />
    ),
  });

  const tramoRegreso = buscarTramo(
    legs,
    propias.length > 0 ? propias[propias.length - 1].order : null,
    null,
  );
  transcurrido += tramoRegreso?.durationHours ?? segment.returnDurationHours;

  filas.push({
    hora: salida ? horaDeLlegada(salida, transcurrido) : undefined,
    marcador: <Circulo icono={<Truck className="h-3.5 w-3.5" />} destacado />,
    contenido: (
      <span className="block py-1">
        <span className="block text-xs font-semibold text-foreground">Regreso</span>
        <span className="block truncate text-[0.6875rem] text-muted-foreground">
          {segment.originName}
        </span>
      </span>
    ),
  });

  return (
    <ol ref={lista}>
      {filas.map((fila, i) => {
        // Los dos NODOS que une el tramo activo: el origen (el nodo más cercano
        // hacia atrás) y el destino (hacia adelante). Apretar un trazo tiene que
        // decir de dónde a dónde va, no solo cuál fila es.
        const nodoDelTramo = (() => {
          if (!tramoActivo || fila.marcador === null) return false;
          const a = filas.findIndex(
            (f) =>
              f.tramo && f.tramo.tipo === tramoActivo.tipo && f.tramo.indice === tramoActivo.indice,
          );
          if (a < 0) return false;
          let antes = a - 1;
          while (antes >= 0 && filas[antes].marcador === null) antes--;
          let despues = a + 1;
          while (despues < filas.length && filas[despues].marcador === null) despues++;
          return i === antes || i === despues;
        })();
        const activa =
          !!fila.tramo &&
          tramoActivo?.tipo === fila.tramo.tipo &&
          tramoActivo.indice === fila.tramo.indice;
        const apretable = !!fila.tramo && !!onTramoClick;
        return (
          <li
            key={i}
            data-tramo={fila.tramo ? `${fila.tramo.tipo}-${fila.tramo.indice}` : undefined}
            onClick={apretable ? () => onTramoClick?.(fila.tramo as TramoDeMapa) : undefined}
            title={apretable ? "Resaltar este tramo en el mapa" : undefined}
            style={
              (activa || nodoDelTramo) && color ? { backgroundColor: `${color}1f` } : undefined
            }
            className={`grid gap-x-3 rounded-md transition-colors ${
              salida ? "grid-cols-[2.75rem_1.75rem_1fr]" : "grid-cols-[1.75rem_1fr]"
            } ${apretable ? "cursor-pointer hover:bg-muted/50" : ""} ${
              (activa || nodoDelTramo) && !color ? "bg-primary/10" : ""
            }`}
          >
            {/* La hora va en su propia columna, a la izquierda del riel, como en
              cualquier itinerario de transporte: alineadas en una columna se
              comparan entre sí, y metidas dentro del texto de cada parada
              habría que ir a buscarlas. Los tramos no llevan hora, solo los
              nodos: una hora describe un instante, no un trayecto. */}
            {salida && (
              <span className="mono pt-1 text-right text-[0.625rem] tabular-nums text-muted-foreground">
                {fila.hora}
              </span>
            )}
            <span className="relative flex justify-center">
              <span
                className="absolute w-px bg-border"
                style={{
                  top: i === 0 ? MEDIO_NODO : 0,
                  bottom: i === filas.length - 1 ? `calc(100% - ${MEDIO_NODO})` : 0,
                }}
              />
              {nodoDelTramo ? (
                <span
                  className="relative z-10 flex h-7 w-7 items-center justify-center rounded-full ring-2 ring-offset-2 ring-offset-card"
                  style={{ ["--tw-ring-color" as string]: color ?? "var(--primary)" }}
                >
                  {fila.marcador}
                </span>
              ) : (
                fila.marcador
              )}
            </span>
            <span className="min-w-0">{fila.contenido}</span>
          </li>
        );
      })}
    </ol>
  );
}
