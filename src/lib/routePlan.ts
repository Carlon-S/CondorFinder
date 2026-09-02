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
}

export interface RoutePlanStop {
  order: number;
  lat: number;
  lng: number;
  label: string;
}

export interface RoutePlanSuccess {
  status: "success";
  route: {
    stops: RoutePlanStop[];
    totalDistanceKm?: number;
    totalDurationHours?: number;
    /** Un trazo (calles reales, vía OSRM) por sub-ruta/punto de origen
     *  usado — casi siempre uno solo. Separado de returnPaths para poder
     *  pintar ida y vuelta con estilos distintos en el mapa. */
    outboundPaths?: [number, number][][];
    returnPaths?: [number, number][][];
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
