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

export interface RoutePlanRequest {
  /** ids de análisis guardados (HDU4, Mongo) cargados para la ruta. */
  analysisIds: string[];
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
  /** Subconjunto de `analysisIds` que el trabajador marcó como prioritario:
   *  entra al plan antes que el resto y es el último en salir cuando hay que
   *  recortar por capacidad o por horas.
   *
   *  No se guarda en ninguna parte. Es una decisión de este plan, de esta
   *  jornada, y la vista la sostiene en memoria junto con las zonas cargadas. */
  priorityAnalysisIds?: string[];
}

export interface RoutePlanStop {
  order: number;
  lat: number;
  lng: number;
  label: string;
  /** Qué análisis guardado (HDU4) es esta parada. Opcional mientras el backend
   *  no lo mande.
   *
   *  Con él, la vista puede mostrar el volumen y el tipo de residuo de cada
   *  parada SIN pedirlos por la red: ya tiene los análisis cargados en memoria,
   *  solo le falta saber cuál es cuál. Sin él tendría que emparejar por nombre,
   *  que se rompe en cuanto dos zonas se llaman parecido. */
  analysisId?: string;
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
  analysisId: string;
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
    /** Un trazo (calles reales, vía OSRM) por sub-ruta/punto de origen
     *  usado — casi siempre uno solo. Separado de returnPaths para poder
     *  pintar ida y vuelta con estilos distintos en el mapa. */
    outboundPaths?: [number, number][][];
    /** El tramo cargado, de la última zona al relleno. Separado de los otros
     *  dos para poder pintarlo distinto: es el único que el camión hace lleno. */
    disposalPaths?: [number, number][][];
    returnPaths?: [number, number][][];
    segments?: RoutePlanSegment[];
    /** HDU5.1/AC6. Ausente mientras el backend no lo calcule. */
    unassignedZones?: RoutePlanUnassigned[];
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
