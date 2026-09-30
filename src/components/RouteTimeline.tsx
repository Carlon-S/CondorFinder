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

import { Truck, Users } from "@/components/icons/Icons";
import type { RoutePlanLeg, RoutePlanSegment, RoutePlanStop } from "@/lib/routePlan";

/** Lo que la vista sabe de cada zona y el timeline no: dónde queda, cuánto
 *  hay y de qué es. */
export interface DatosDeParada {
  volumeM3: number;
  wasteLabel?: string;
  wasteColor?: string;
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
}: {
  tramo?: RoutePlanLeg;
  respaldo?: { distanceKm: number; durationHours: number };
  etiqueta?: string;
}) {
  const datos = tramo ?? respaldo;
  // Sin cifras, la fila igual ocupa alto: es lo que mantiene el riel visible
  // entre dos paradas mientras el backend no mande el desglose por tramo.
  if (!datos) return <span className="block h-5" />;
  return (
    <span className="flex items-center gap-2 py-2">
      {/* Cada cifra en su pastilla. Sueltas sobre el fondo se leían como una
          continuación del texto de la parada de arriba, cuando describen el
          espacio ENTRE dos paradas, que es otra cosa. */}
      <span className="mono rounded bg-muted/70 px-1.5 py-0.5 text-[0.625rem] tabular-nums text-foreground/80">
        {horas(datos.durationHours)}
      </span>
      <span className="mono rounded bg-muted/70 px-1.5 py-0.5 text-[0.625rem] tabular-nums text-foreground/80">
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

export function RouteTimeline({
  segment,
  stops,
  datosDeParada,
  onStopClick,
  salida,
}: {
  segment: RoutePlanSegment;
  stops: RoutePlanStop[];
  /** Resuelve qué zona es cada parada. Es una FUNCIÓN y no un mapa por id
   *  porque hoy el backend todavía no manda `analysisId` en la parada, así que
   *  quien llama necesita poder caer a emparejar por nombre. Esa decisión es
   *  suya, no del timeline. */
  datosDeParada?: (stop: RoutePlanStop) => DatosDeParada | undefined;
  onStopClick?: (stop: RoutePlanStop) => void;
  /** Momento en que se sale del punto. Es el instante en que se generó el
   *  plan, no "ahora": si fuera "ahora" las horas correrían solas mientras el
   *  trabajador lee la pantalla, y un plan cuyas horas cambian solo por mirarlo
   *  no es un plan. */
  salida?: Date;
}) {
  const { legs } = segment;
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
        {/* El vehículo y la dotación van en la salida y no repetidos en cada
            parada: es el mismo camión todo el recorrido. Repetirlos por parada
            convertiría el dato en ruido. */}
        {segment.vehicle || (segment.crew && segment.crew.length > 0) ? (
          <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
            {segment.vehicle && (
              <span className="flex items-center gap-1.5 text-[0.6875rem]">
                <Truck className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                <span className="mono font-medium text-foreground">{segment.vehicle.patente}</span>
                <span className="text-muted-foreground">{segment.vehicle.tipo}</span>
              </span>
            )}
            {segment.crew && segment.crew.length > 0 && (
              <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                <Users className="h-3 w-3 flex-shrink-0" />
                {segment.crew.join(", ")}
              </span>
            )}
          </span>
        ) : (
          <span className="mt-1 block text-[0.6875rem] text-muted-foreground">
            <span className="mono tabular-nums">{segment.trucksUsed}</span> camión
            {segment.trucksUsed === 1 ? "" : "es"}
          </span>
        )}
      </span>
    ),
  });

  stops.forEach((stop, i) => {
    const datos = datosDeParada?.(stop);
    const tramo = buscarTramo(legs, i === 0 ? null : stops[i - 1].order, stop.order);
    transcurrido += tramo?.durationHours ?? (i === 0 ? segment.outboundDurationHours : 0);
    filas.push({
      marcador: null,
      contenido: (
        <Tramo
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
          <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem]">
            <span className="mono font-semibold tabular-nums text-foreground">
              {datos.volumeM3.toFixed(2)} m³
            </span>
            {datos.wasteLabel && (
              <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-muted/70 py-0.5 pl-1.5 pr-2">
                <span
                  className="h-2 w-2 flex-shrink-0 rounded-full"
                  style={{ background: datos.wasteColor ?? "var(--muted-foreground)" }}
                />
                <span className="min-w-0 truncate text-[0.625rem] text-foreground/80">
                  {datos.wasteLabel}
                </span>
              </span>
            )}
          </span>
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

  filas.push({
    marcador: null,
    contenido: (
      <Tramo
        tramo={buscarTramo(legs, stops.length > 0 ? stops[stops.length - 1].order : null, null)}
        respaldo={{
          distanceKm: segment.returnDistanceKm,
          durationHours: segment.returnDurationHours,
        }}
        etiqueta="regreso"
      />
    ),
  });

  const tramoRegreso = buscarTramo(
    legs,
    stops.length > 0 ? stops[stops.length - 1].order : null,
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
    <ol>
      {filas.map((fila, i) => (
        <li
          key={i}
          className={`grid gap-x-3 ${
            salida ? "grid-cols-[2.75rem_1.75rem_1fr]" : "grid-cols-[1.75rem_1fr]"
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
            {fila.marcador}
          </span>
          <span className="min-w-0">{fila.contenido}</span>
        </li>
      ))}
    </ol>
  );
}
