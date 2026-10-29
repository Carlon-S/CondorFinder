// =============================================================================
// CONDORFINDER — GENERACIÓN DE RUTA ÓPTIMA (HDU5)
// Archivo: src/lib/routePlan.ts
//
// Contrato de API para POST /routes/generate — el algoritmo real (backend)
// todavía no existe, este módulo define la forma que espera/devuelve para
// que el frontend quede listo y se implemente contra este mismo contrato.
// Mismo patrón que resources.ts: fetch directo con credentials:"include".
//
// Solo se mandan IDs de análisis (no los datos de cada basural) — mismo
// criterio que activePointIds: el backend resuelve volumen/polígono real
// contra Mongo (analyses.py), nunca confía en lo que mande el navegador.
//
// Hasta que el endpoint exista, cualquier llamada cae en el catch de red y
// devuelve "infeasible" — AC6 (mensaje de ruta no factible) es demostrable
// hoy tal cual; el camino de éxito de AC2 no se puede probar de punta a
// punta hasta que el backend responda de verdad.
// =============================================================================

// CLIENT_BACKEND_URL (no BACKEND_URL): este archivo corre 100% en el
// navegador — necesita la ruta relativa que proxyea vite.config.ts, para
// que la cookie de sesión no se pierda por ser cross-origin. Ver config.ts.
import { CLIENT_BACKEND_URL as BACKEND_URL } from "./config";

/** De dónde sale una parada cargada al plan.
 *
 *  `analysis` es un análisis guardado (HDU4): trae volumen medido, peso y las
 *  clases de residuo del detector. `punto_diario` es un retiro de la jornada
 *  (HDU15): trae el volumen que declaró quien lo pidió, y **no trae peso**,
 *  porque nadie lo midió. */
export type RouteStopKind = "analysis" | "punto_diario";

/** Una parada cargada, con su origen y cuánto retirar de ella.
 *
 *  **Referencia tipada y no dos listas paralelas**: con listas hay que mantener
 *  la sincronía en los dos lados en cada lectura. Un punto diario no es una
 *  zona ni un análisis, así que el id solo no alcanza para saber dónde
 *  buscarlo. */
export interface RouteStopRef {
  kind: RouteStopKind;
  id: string;
  /** Cuánto volumen retirar de esta parada, en m³. Obligatorio: sin él una
   *  sola zona grande se come el plan entero. */
  retirarM3?: number | null;
}

export interface RoutePlanRequest {
  /** Las paradas cargadas, cada una con su origen y su volumen a retirar. */
  stops: RouteStopRef[];
  /** ids de puntos HDU6 marcados como activos. */
  activePointIds: string[];
  availableHours: number;
  /** null = sin prioridad ("Sin prioridad" en el selector). */
  priorityWasteType: string | null;
  /** Quienes estan disponibles HOY, declarados al generar.
   *
   *  No hay padron de trabajadores en la base, y es deliberado: la municipalidad
   *  describio su operacion como "se designa personal segun requerimiento" y "se
   *  flexibiliza por inasistencias", asi que el personal es del PLAN. Guardar una
   *  nomina ademas significaria almacenar datos personales que nadie entrego.
   *
   *  **Lista vacia o ausente = sin restriccion**, igual que `autonomia_km` y
   *  `capacidad_ton`. La lista se recuerda en el navegador (crewState.ts) solo
   *  para no retipearla; lo que decide el plan es lo que viaja aca. */
  personal?: { nombre: string; rol: "conductor" | "peoneta" | "operador" }[];
  /** Subconjunto de los ids de `stops` que el trabajador marcó como prioritario:
   *  entra al plan antes que el resto y es el último en salir cuando hay que
   *  recortar por capacidad o por horas.
   *
   *  No se guarda en ninguna parte. Es una decisión de este plan, de esta
   *  jornada, y la vista la sostiene en memoria junto con las zonas cargadas. */
  priorityStopIds?: string[];
}

export interface RoutePlanStop {
  order: number;
  lat: number;
  lng: number;
  label: string;
  /** Qué parada cargada es esta, y de dónde salió.
   *
   *  Con ella, la vista puede mostrar el volumen y el tipo de residuo de cada
   *  parada SIN pedirlos por la red: ya tiene lo cargado en memoria, solo le
   *  falta saber cuál es cuál. Sin ella tendría que emparejar por nombre, que
   *  se rompe en cuanto dos zonas se llaman parecido.
   *
   *  Se llamaba `analysisId`: con paradas tipadas puede ser el id de un punto
   *  diario, que no es un análisis, así que el nombre mentía. */
  stopId?: string;
  kind?: RouteStopKind;
  /** A qué VIAJE del recorrido pertenece esta parada, 1-based.
   *
   *  El convoy vuelve al relleno cuando no puede con la siguiente zona, así que
   *  un recorrido puede tener varios viajes. La línea de tiempo lo usa para
   *  poner el separador "Viaje 2 de 3" y repetir el nodo de descarga.
   *
   *  Ausente, o 1 en todas, significa un solo viaje. */
  trip?: number;
  /** Cuánto se retira DE VERDAD en esta parada, que no siempre es el volumen de
   *  la zona.
   *
   *  Una zona que no cabe en la capacidad despachada ya no se descarta entera:
   *  el camión carga lo que le entra y la zona queda con un resto. Y la vista no
   *  puede deducirlo, porque toma las cifras de lo que empareja por
   *  `stopId`: sin estos campos imprimiría el volumen completo de una zona
   *  que se retira a medias.
   *
   *  `pendingVolumeM3` en cero, o ausente en un plan generado por una versión
   *  anterior del backend, significa retiro completo. */
  removedVolumeM3?: number;
  removedWeightKg?: number;
  pendingVolumeM3?: number;
}

/** Un tramo entre dos paradas consecutivas. HDU5.1/AC7 habla de "cada tramo del
 *  plan", y un tramo es esto: lo que se recorre entre un punto y el siguiente.
 *
 *  Opcional, como el resto de HDU5.1. Mientras no llegue, la vista muestra los
 *  totales de ida y vuelta que sí trae el segmento, que es lo que hay hoy. */
export interface RoutePlanLeg {
  /** Orden de la parada de la que sale. null = sale del punto de origen. */
  fromOrder: number | null;
  /** Orden de la parada a la que llega. null = vuelve al punto de origen. */
  toOrder: number | null;
  distanceKm: number;
  durationHours: number;
}

/** Resumen de una sub-ruta/punto de origen usado -- mismo índice que
 *  route.outboundPaths[i]/returnPaths[i], para la ventana flotante sobre
 *  cada tramo (estilo Google Maps). La velocidad no viaja aparte -- se
 *  calcula en el frontend como distancia/tiempo cuando hace falta mostrarla. */
/** Identidad de un vehículo asignado a un tramo. HDU5.1/AC7. */
export interface RoutePlanVehicle {
  patente: string;
  tipo: string;
  /** Id del recurso en /resources/units, para poder abrirlo desde la ruta. */
  resourceId?: string;
  /** El identificador que la municipalidad usa en sus propias planillas. Es
   *  también lo que viaja en `patente` cuando la unidad no la trae cargada. */
  numeroEquipo?: string;
  capacityM3?: number;
  /** Limite de peso. Si el plan descarta una zona por peso, es contra esta
   *  cifra que se decidio. */
  capacityTon?: number;
  /** Rango antes de necesitar recarga. Ausente en toda la flota real: la
   *  municipalidad respondio que ese limite no existe. */
  autonomiaKm?: number;
  /** Nombre del archivo, no la URL: la sirve GET /resources/photo/{filename}.
   *  Ausente en 8 de las 21 unidades de la flota real. */
  foto?: string;
  /** La dotación de ESTE vehículo, como roles ("1 conductor", "2 peonetas").
   *  Estaba a nivel del tramo, lo que servía mientras el tramo tenía un solo
   *  camión; con varios, un "1 conductor, 2 peonetas" sin decir de cuál es
   *  información que no se puede usar. */
  crew?: string[];
}

export interface RoutePlanSegment {
  originName: string;
  trucksUsed: number;
  outboundDistanceKm: number;
  outboundDurationHours: number;
  returnDistanceKm: number;
  returnDurationHours: number;

  /** Tramo de la última zona al relleno sanitario, el único que el camión hace
   *  cargado. Opcionales porque un plan generado por una versión anterior del
   *  backend no los trae, y la línea de tiempo no dibuja el nodo si faltan. */
  /** Cuántos viajes tiene este recorrido. El criterio pide informarlo: sin la
   *  cifra, un nodo de descarga repetido se lee como si el recorrido se hubiera
   *  dibujado dos veces. Ausente o 1 = un solo viaje. */
  trips?: number;
  /** Cada pasada por el relleno, con después de qué parada ocurre.
   *
   *  **Sin esto las horas de llegada mienten.** La línea de tiempo acumula el
   *  tiempo transcurrido parada por parada; con varios viajes, el reloj se
   *  saltaba cada depósito intermedio y todas las llegadas posteriores salían
   *  más temprano de lo real. El total (`disposalDurationHours`) no sirve para
   *  eso: dice cuánto suman todas las descargas, no cuándo ocurre cada una.
   *
   *  Vacía en un plan generado por una versión anterior del backend, y ahí la
   *  vista cae a un solo nodo con el total, que es como estaba. */
  disposals?: { afterOrder: number; distanceKm: number; durationHours: number }[];
  disposalName?: string;
  disposalDistanceKm?: number;
  disposalDurationHours?: number;

  // ── Campos de HDU5.1 ──
  //
  // OPCIONALES a propósito, y es una decisión, no un descuido. Lo que NO se
  // hace es dibujar un dato vacío o con guiones a la espera del valor: una
  // interfaz que promete algo que no tiene es peor que una más corta. Cada
  // componente decide si lo renderiza preguntando por el dato, no por una
  // bandera de configuración.

  /** **Todos** los vehículos que recorren este tramo, cada uno con su patente,
   *  su tipo, su capacidad, su foto y su propia dotación. AC7.
   *
   *  Antes era un `vehicle` singular que el backend mandaba solo cuando el
   *  tramo lo recorría UN camión, así que con dos o más la vista caía a
   *  "2 camiones" y no decía cuáles. */
  vehicles?: RoutePlanVehicle[];
  /** Autonomía del vehículo en km, contra la que se descarta un tramo
   *  demasiado largo. AC3. */
  autonomyKm?: number;
  /** El recorrido partido en tramos, en orden. Es lo que dibuja la línea de
   *  tiempo del plan. */
  legs?: RoutePlanLeg[];
  /** Qué paradas recorre este segmento, por su `order`. Hoy `route.stops` es
   *  una lista plana sin dueño, así que la vista no puede saber qué paradas
   *  pertenecen a qué recorrido: con un solo punto de origen da igual, con
   *  varios no. Descartar un recorrido, por ejemplo, debería llevarse sus
   *  paradas, y sin este campo solo puede quitar el trazo. */
  stopOrders?: number[];
}

/** Una zona que no se pudo asignar a ningún vehículo, con el motivo. HDU5.1/AC6:
 *  el plan sigue siendo válido para el resto, la zona queda marcada. */
export interface RoutePlanUnassigned {
  stopId: string;
  kind?: RouteStopKind;
  name: string;
  /** Por qué no se pudo: sin vehículo compatible, sin personal completo, fuera
   *  de autonomía, sin capacidad. En texto, porque es lo que se le muestra al
   *  trabajador tal cual. */
  reason: string;
}

export interface RoutePlanSuccess {
  status: "success";
  route: {
    stops: RoutePlanStop[];
    totalDistanceKm?: number;
    totalDurationHours?: number;
    /** Con cuánto volumen se armó el plan de verdad.
     *
     *  No es el volumen de las zonas cargadas: desde AC6 el plan puede dejar
     *  zonas fuera, así que "cargué 6,94 m³" y "el plan mueve 3,61 m³" son dos
     *  cifras distintas, y la segunda es la que describe el trabajo del día. */
    totalVolumeM3?: number;
    /** Del patio a la PRIMERA zona, un trazo por sub-ruta. Separado del resto
     *  para poder pintar cada tramo distinto en el mapa. */
    outboundPaths?: [number, number][][];
    /** Las transiciones entre zonas consecutivas, ya aplanadas de todas las
     *  sub-rutas: el mapa las pinta todas igual, así que no necesita saber cuál
     *  pertenece a cuál recorrido.
     *
     *  Vacío con una sola parada, y también cuando el plan lo generó una
     *  versión anterior del backend: ahí la ida entera viene en `outboundPaths`
     *  como un solo trazo, que es como se dibujaba antes. */
    transferPaths?: [number, number][][];
    /** El tramo cargado, de la última zona al relleno. Separado de los otros
     *  dos para poder pintarlo distinto: es el único que el camión hace lleno. */
    disposalPaths?: [number, number][][];
    returnPaths?: [number, number][][];
    segments?: RoutePlanSegment[];
    /** HDU5.1/AC6. Ausente mientras el backend no lo calcule. */
    unassignedZones?: RoutePlanUnassigned[];
    /** HDU5.1/AC5: si los tiempos de cada tramo se calcularon con el tráfico
     *  del momento. Lo decide el backend según el proveedor configurado, y
     *  viaja en la respuesta porque es una propiedad de ESTE plan: lo que
     *  importa es cómo se calculó, no cómo se calcularía ahora.
     *
     *  Ausente o false significa flujo libre, que es lo que calcula OSRM. */
    trafficAware?: boolean;
  };
}

export interface RoutePlanInfeasible {
  status: "infeasible";
  message: string;
}

export type RoutePlanResult = RoutePlanSuccess | RoutePlanInfeasible;

const INFEASIBLE_FALLBACK: RoutePlanInfeasible = {
  status: "infeasible",
  message: "No fue posible generar una ruta con los recursos y restricciones indicadas.",
};

export async function generateRoute(payload: RoutePlanRequest): Promise<RoutePlanResult> {
  try {
    const res = await fetch(`${BACKEND_URL}/routes/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    if (!res.ok) return INFEASIBLE_FALLBACK;
    return await res.json();
  } catch {
    return INFEASIBLE_FALLBACK;
  }
}
