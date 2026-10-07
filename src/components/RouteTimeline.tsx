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

import { ImageIcon, Truck, Users, Warehouse } from "@/components/icons/Icons";
import type {
  RoutePlanLeg,
  RoutePlanSegment,
  RoutePlanStop,
  RoutePlanVehicle,
} from "@/lib/routePlan";

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
            {vehiculo.capacityM3} m³
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
}: {
  segment: RoutePlanSegment;
  stops: RoutePlanStop[];
  /** Resuelve qué zona es cada parada. Es una FUNCIÓN y no un mapa por id
   *  porque hoy el backend todavía no manda `analysisId` en la parada, así que
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
}) {
  const { legs } = segment;
  const vehiculos = segment.vehicles ?? [];
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
                    : `${Math.round(datos.weightKg)} kg`}
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
                  {datos.pendingM3.toFixed(2)} m³
                </span>{" "}
                en la zona
              </span>
            )}
            {/* Todos los tipos, no solo el dominante. Cada uno con su volumen,
                porque "tiene plástico" y "tiene 3 m³ de plástico" no dicen lo
                mismo a quien va a cargar. */}
            {datos.wasteTypes && datos.wasteTypes.length > 0 && (
              <span className="mt-1 flex flex-wrap items-center gap-1">
                {datos.wasteTypes.map(([clase, vol]) => (
                  <span
                    key={clase}
                    className="flex min-w-0 items-center gap-1.5 rounded-full bg-muted/70 py-0.5 pl-1.5 pr-2"
                    title={`${clase}: ${vol.toFixed(2)} m³`}
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

  // ── Descarga en el relleno sanitario ──
  // El recorrido no vuelve cargado al patio: descarga primero. Es la geometría
  // que la municipalidad describió por escrito, y el nodo existe para que el
  // plan la diga en vez de dejar la vuelta como si fuera directa.
  //
  // Se dibuja solo si el backend mandó el tramo: un plan generado por una
  // versión anterior no lo trae, y fabricar el nodo con el relleno supuesto
  // afirmaría un recorrido que ese plan no calculó ni contó en sus horas.
  const hayDescarga = segment.disposalDurationHours != null;

  if (hayDescarga) {
    filas.push({
      marcador: null,
      contenido: (
        <Tramo
          respaldo={{
            distanceKm: segment.disposalDistanceKm ?? 0,
            durationHours: segment.disposalDurationHours ?? 0,
          }}
          etiqueta="cargado"
        />
      ),
    });
    transcurrido += segment.disposalDurationHours ?? 0;
    filas.push({
      hora: salida ? horaDeLlegada(salida, transcurrido) : undefined,
      marcador: <Circulo icono={<Warehouse className="h-3.5 w-3.5" />} />,
      contenido: (
        <span className="block py-1">
          <span className="block text-xs font-semibold text-foreground">Descarga</span>
          <span className="block truncate text-[0.6875rem] text-muted-foreground">
            {segment.disposalName ?? "Relleno sanitario"}
          </span>
        </span>
      ),
    });
  }

  filas.push({
    marcador: null,
    contenido: (
      <Tramo
        tramo={buscarTramo(legs, stops.length > 0 ? stops[stops.length - 1].order : null, null)}
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
