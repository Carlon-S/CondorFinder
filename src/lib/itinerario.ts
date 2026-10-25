// =============================================================================
// CONDORFINDER, ITINERARIO SEMANAL (HDU14)
// Archivo: src/lib/itinerario.ts
//
// Cliente HTTP de la grilla de LUNES a SÁBADO. Mismo patrón que el resto de
// src/lib: fetch directo con `credentials: "include"`, sin estado propio.
//
// No hay un cliente de "puntos permanentes" aparte: un punto permanente ES una
// zona (`analysisStore.ts`, `kind: "permanente"`), así que el catálogo se pide
// con `listZones()` y se filtra. Un segundo cliente para la misma colección
// habría sido una segunda forma de hablar del mismo objeto.
// =============================================================================

import { CLIENT_BACKEND_URL as BACKEND_URL } from "./config";

/** Un punto ya resuelto contra la zona, como lo manda el backend. */
export interface PuntoDelDia {
  id: string;
  name: string;
  address?: string | null;
  barrio?: string | null;
  tipo?: string | null;
  frecuencia?: string | null;
  photoUrl?: string | null;
  lat?: number | null;
  lng?: number | null;
  active: boolean;
}

export interface DiaItinerario {
  dia: DiaSemana;
  puntos: PuntoDelDia[];
}

export type DiaSemana = (typeof DIAS)[number];

/** Los seis días de la planilla municipal, con el rótulo que se imprime.
 *
 *  La clave va sin tilde porque viaja en la URL y en Mongo; el rótulo sí la
 *  lleva. Separarlos evita tener que codificar la tilde en cada petición. */
export const DIAS = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado"] as const;

export const ROTULO_DIA: Record<DiaSemana, string> = {
  lunes: "Lunes",
  martes: "Martes",
  miercoles: "Miércoles",
  jueves: "Jueves",
  viernes: "Viernes",
  sabado: "Sábado",
};

async function mensajeDeError(res: Response, respaldo: string): Promise<string> {
  try {
    const parsed = await res.json();
    if (parsed?.detail) return typeof parsed.detail === "string" ? parsed.detail : respaldo;
  } catch {
    // no era JSON
  }
  return respaldo;
}

/** La grilla completa. Siempre vuelven los seis días, aunque estén vacíos. */
export async function getItinerario(): Promise<DiaItinerario[]> {
  const res = await fetch(`${BACKEND_URL}/itinerario`, { credentials: "include" });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo cargar el itinerario."));
  return res.json();
}

/** Reemplaza la lista ORDENADA de un día.
 *
 *  Se manda la lista final y no un alta o una baja: la vista arrastra y
 *  reordena, así que después de cada gesto lo que tiene es el resultado. Mandar
 *  diferencias obligaría a los dos lados a coincidir en cómo se calculan. */
export async function setDia(dia: DiaSemana, puntos: string[]): Promise<DiaItinerario> {
  const res = await fetch(`${BACKEND_URL}/itinerario/${dia}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ puntos }),
  });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo guardar el día."));
  return res.json();
}
