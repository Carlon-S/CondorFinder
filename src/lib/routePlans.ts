// =============================================================================
// CONDORFINDER, RUTAS GUARDADAS (C5 y C6 de HDU5.2)
// Archivo: src/lib/routePlans.ts
//
// Cliente de `/route-plans`, el historial de planes generados.
//
// **Dos formas del mismo registro, y la diferencia es de peso, no de gusto.**
// `RutaGuardada` es una fila del listado: fecha, estado y un puñado de cifras.
// `RutaGuardadaCompleta` agrega el plan entero, **con su geometría**, que para
// un recorrido urbano de 60 km son miles de vértices.
//
// El listado proyecta eso fuera en el backend, así que abrir el historial
// descarga una tabla y no varios MB. La geometría llega solo al abrir un plan
// concreto, que es cuando hay un mapa que dibujar.
// =============================================================================

import { CLIENT_BACKEND_URL as BACKEND_URL } from "@/lib/config";
import type { RoutePlanRequest, RoutePlanSuccess } from "@/lib/routePlan";

/** El plan dibujable, tal como lo devuelve `POST /routes/generate`.
 *
 *  **Acceso indexado y no un tipo nuevo**: esa forma vive en línea dentro de
 *  `RoutePlanSuccess`, y extraerla a una interfaz propia significaría tocar el
 *  contrato compartido para no ganar nada. Así, si el plan cambia de forma,
 *  esto lo sigue solo y no hay dos definiciones que puedan separarse. */
export type PlanDibujable = RoutePlanSuccess["route"];

/** En qué punto del ciclo de vida está una ruta guardada.
 *
 *  El ciclo completo es la pieza 2.1; hoy toda ruta nace `generada`. El tipo
 *  declara los cuatro desde ya porque el backend los define desde ya, y un
 *  tipo que solo conoce uno obligaría a tocarlo en cuanto exista el segundo. */
export type EstadoRuta = "generada" | "en curso" | "terminada" | "cancelada";

/** Las cifras que la tabla del historial muestra sin abrir el plan. */
export interface ResumenRuta {
  /** El primer punto de origen. `null` en un plan sin recorridos. */
  origenNombre: string | null;
  recorridos: number;
  paradas: number;
  /** El volumen PLANIFICADO, congelado al generar. */
  volumenM3: number | null;
  /** El volumen que el plan movió DE VERDAD, de lo que se anotó al cerrar.
   *
   *  **Es una segunda cifra, no un reemplazo de `volumenM3`.** Lo planificado
   *  es lo que se decidió ese día y no cambia; lo retirado es lo que ocurrió.
   *  Sin esto, una ruta cerrada con menos volumen del previsto seguía
   *  anunciando el número viejo y no había dónde leer el real.
   *
   *  `null` mientras la ruta no se haya cerrado, y también cuando se cerró
   *  **sin registrar cifras**, que no es lo mismo que cero: nadie tomó nota. */
  volumenRetiradoM3?: number | null;
  /** Cuántas paradas quedaron registradas al cerrar. 0 = se cerró sin anotar. */
  paradasRegistradas?: number;
  distanciaKm: number | null;
  duracionHoras: number | null;
  /** Viajes al relleno, sumados entre todos los recorridos. */
  viajes: number;
  sinAsignar: number;
  /** Si los tiempos se calcularon con el tráfico del momento. */
  trafficAware: boolean;
  horasDisponibles: number | null;
}

/** Una fila del historial. **Sin el plan**, que es el documento pesado. */
export interface RutaGuardada {
  id: string;
  /** ISO 8601, en UTC. */
  fecha: string;
  estado: EstadoRuta;
  resumen: ResumenRuta;
  /** Cuándo se regeneró, si se editó alguna vez (C5). */
  editadoEn: string | null;
  /** Cuándo salió de verdad y cuándo se cerró.
   *
   *  Distintos de la hora que el plan calculó: el plan dice a qué hora DEBERÍA
   *  salir y esto a qué hora salió. Tenerlos separados es lo que después
   *  permite comparar lo planificado contra lo hecho. */
  despachadaEn: string | null;
  cerradaEn: string | null;
}

/** Las transiciones legales, espejadas del backend (`route_plans.TRANSICIONES`).
 *
 *  **Se duplica a propósito, y las dos tienen que moverse juntas**, igual que
 *  `motivoFueraDeRuta()` espeja la regla de disponibilidad. Acá sirve para no
 *  ofrecer un botón que el servidor va a rechazar; la regla de verdad vive
 *  allá, y el 409 que devuelve es el que manda. */
export const TRANSICIONES: Record<EstadoRuta, EstadoRuta[]> = {
  generada: ["en curso", "cancelada"],
  "en curso": ["terminada", "cancelada"],
  terminada: [],
  cancelada: [],
};

/** Una ruta con todo: el plan dibujable y la petición que lo originó.
 *
 *  `peticion` es lo que vuelve posible C5: editar una ruta es volver al diálogo
 *  de generación con estos valores y regenerar. */
export interface RutaGuardadaCompleta extends RutaGuardada {
  plan: PlanDibujable | null;
  peticion: RoutePlanRequest | null;
}

/** Un día con rutas y cuántas tiene. */
export interface DiaConRutas {
  /** `YYYY-MM-DD`. */
  fecha: string;
  total: number;
}

async function mensajeDeError(res: Response, respaldo: string): Promise<string> {
  try {
    const parsed = await res.json();
    if (parsed?.detail) return typeof parsed.detail === "string" ? parsed.detail : respaldo;
  } catch {
    // no era JSON
  }
  return respaldo;
}

/** El historial, de la más reciente a la más antigua.
 *
 *  Los filtros son opcionales y se combinan: sin ninguno trae las últimas
 *  `limite`. Las fechas van como `YYYY-MM-DD` y el backend las convierte al
 *  rango del día completo, así que `desde` y `hasta` iguales traen un solo día.
 */
export async function listarRutas(opciones?: {
  desde?: string;
  hasta?: string;
  estado?: EstadoRuta;
  limite?: number;
}): Promise<RutaGuardada[]> {
  const q = new URLSearchParams();
  if (opciones?.desde) q.set("desde", opciones.desde);
  if (opciones?.hasta) q.set("hasta", opciones.hasta);
  if (opciones?.estado) q.set("estado", opciones.estado);
  if (opciones?.limite) q.set("limite", String(opciones.limite));
  const sufijo = q.toString() ? `?${q}` : "";
  const res = await fetch(`${BACKEND_URL}/route-plans${sufijo}`, { credentials: "include" });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo cargar el historial."));
  return res.json();
}

/** Qué días tienen rutas y cuántas.
 *
 *  Una sola agregación en el backend. Es lo que permite marcar los días con
 *  datos en vez de obligar a probar fecha por fecha; con una consulta por día,
 *  navegar un mes costaría 31 viajes a Mongo. */
export async function fechasConRutas(): Promise<DiaConRutas[]> {
  const res = await fetch(`${BACKEND_URL}/route-plans/fechas`, { credentials: "include" });
  if (!res.ok)
    throw new Error(await mensajeDeError(res, "No se pudieron cargar los días con rutas."));
  return res.json();
}

/** Una ruta completa, con su geometría. Es la única lectura que la trae. */
export async function obtenerRuta(id: string): Promise<RutaGuardadaCompleta> {
  const res = await fetch(`${BACKEND_URL}/route-plans/${encodeURIComponent(id)}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo abrir la ruta."));
  return res.json();
}

/** Borra una ruta guardada.
 *
 *  El backend se niega con 409 si la ruta ya salió a la calle: una en curso se
 *  cancela y una terminada es historia. El mensaje del 409 explica cuál es el
 *  caso, así que se propaga tal cual en vez de reescribirlo acá. */
export async function eliminarRuta(id: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/route-plans/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo eliminar la ruta."));
}

/** Mueve una ruta por su ciclo de vida (pieza 2.1).
 *
 *  El backend valida la TRANSICIÓN y no solo el destino, así que un 409 acá
 *  significa que ese salto no existe desde donde está la ruta, y su mensaje
 *  nombra los que sí. Se propaga tal cual en vez de reescribirlo.
 */
export async function cambiarEstadoRuta(id: string, estado: EstadoRuta): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/route-plans/${encodeURIComponent(id)}/estado`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ estado }),
  });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo cambiar el estado."));
}

/** Qué vehículos están en una ruta EN CURSO (pieza 2.2).
 *
 *  Ids y patentes mezclados, que es como el servidor los junta: la vista
 *  compara contra las dos porque el id es el real y la patente es lo único que
 *  traen los planes guardados antes de que `resourceId` viajara.
 *
 *  **No falla la pantalla si falla la consulta**: devuelve un conjunto vacío.
 *  El ruteo excluye las ocupadas por su cuenta de todos modos, así que lo peor
 *  que pasa sin este dato es que la flota no explique por qué no se usó un
 *  camión; quedarse sin poder generar por eso sería mucho peor. */
export async function unidadesOcupadas(): Promise<Set<string>> {
  try {
    const res = await fetch(`${BACKEND_URL}/route-plans/ocupadas`, {
      credentials: "include",
    });
    if (!res.ok) return new Set();
    const data = (await res.json()) as { unidades?: string[] };
    return new Set(data.unidades ?? []);
  } catch {
    return new Set();
  }
}

/** Lo que la cuadrilla confirma de una parada al cerrar la ruta (pieza 2.4). */
export interface RetiroDeParada {
  stopId: string;
  kind: "analysis" | "punto_diario";
  /** Cuánto salió. `null` cuando no se midió, que **no es lo mismo que cero**:
   *  cero significa que el camión se fue sin cargar. */
  retiradoM3: number | null;
  /** Si la parada se atendió completa. Puede ser `true` con menos volumen del
   *  planificado (había menos de lo estimado) y `false` con el volumen completo
   *  (se cargó todo lo que cabía y quedó más). */
  completado: boolean;
}

/** Un retiro ya registrado. */
export interface Retiro {
  id: string;
  fecha: string;
  planId: string | null;
  kind: string | null;
  stopId: string | null;
  nombre: string | null;
  zoneId: string | null;
  volumenPlanificadoM3: number | null;
  volumenRetiradoM3: number | null;
  completado: boolean;
}

/** Cuánto se ha retirado de cada zona (pieza 2.5). */
export interface RetiroPorZona {
  zoneId: string;
  totalM3: number;
  /** El retiro más reciente. Es lo que permite descontar solo los POSTERIORES
   *  a la última medición: uno anterior al vuelo ya está en lo que el dron
   *  vio. */
  ultimo: string | null;
  veces: number;
}

/** Termina una ruta y registra lo que se retiró en cada parada.
 *
 *  **Es el único camino que la interfaz ofrece para llegar a `terminada`.** La
 *  lista puede ir vacía: cerrar sin anotar cifras es un resultado válido, y
 *  obligar a llenarlas dejaría la ruta "en curso" para siempre cuando nadie
 *  tomó nota. */
export async function cerrarRuta(id: string, retiros: RetiroDeParada[]): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/route-plans/${encodeURIComponent(id)}/cerrar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ retiros }),
  });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo cerrar la ruta."));
}

/** Los retiros de una zona, de los más recientes a los más antiguos. */
export async function listarRetiros(zoneId?: string): Promise<Retiro[]> {
  const q = zoneId ? `?zoneId=${encodeURIComponent(zoneId)}` : "";
  const res = await fetch(`${BACKEND_URL}/route-plans/retiros${q}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudieron cargar los retiros."));
  return res.json();
}

/** Cuánto se ha retirado de cada zona, en UNA consulta (pieza 2.5).
 *
 *  **No falla la pantalla si falla**: devuelve una lista vacía. Lo peor que
 *  pasa sin este dato es que el volumen mostrado sea el medido sin descontar;
 *  dejar la vista sin cargar por eso sería mucho peor. */
export async function retirosPorZona(): Promise<RetiroPorZona[]> {
  try {
    const res = await fetch(`${BACKEND_URL}/route-plans/retiros/por-zona`, {
      credentials: "include",
    });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}
