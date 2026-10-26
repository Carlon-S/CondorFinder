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

/** La semana ISO de una fecha, como `2026-W44`.
 *
 *  Formato ISO 8601 porque es el que entiende el backend y porque se ordena
 *  alfabéticamente igual que cronológicamente. El jueves es el día que decide
 *  a qué año pertenece una semana a caballo entre dos, que es la regla de la
 *  norma y el motivo del desplazamiento de abajo. */
export function semanaDe(fecha: Date): string {
  const d = new Date(Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const inicioAnio = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const num = Math.ceil(((d.getTime() - inicioAnio.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(num).padStart(2, "0")}`;
}

/** El lunes de la semana que contiene esa fecha. */
export function lunesDe(fecha: Date): Date {
  const d = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
  const desplazamiento = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - desplazamiento);
  return d;
}

/** La grilla de una semana. Siempre vuelven los seis días, aunque estén vacíos. */
export async function getItinerario(semana?: string): Promise<DiaItinerario[]> {
  const q = semana ? `?semana=${encodeURIComponent(semana)}` : "";
  const res = await fetch(`${BACKEND_URL}/itinerario${q}`, { credentials: "include" });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo cargar el itinerario."));
  return res.json();
}

/** Reemplaza la lista ORDENADA de un día.
 *
 *  Se manda la lista final y no un alta o una baja: la vista arrastra y
 *  reordena, así que después de cada gesto lo que tiene es el resultado. Mandar
 *  diferencias obligaría a los dos lados a coincidir en cómo se calculan. */
export async function setDia(
  dia: DiaSemana,
  puntos: string[],
  semana?: string,
): Promise<DiaItinerario> {
  const q = semana ? `?semana=${encodeURIComponent(semana)}` : "";
  const res = await fetch(`${BACKEND_URL}/itinerario/${dia}${q}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ puntos }),
  });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo guardar el día."));
  return res.json();
}

/** Copia el reparto de una semana a otra, reemplazando el destino.
 *
 *  El itinerario municipal se repite semana tras semana, así que sin esto
 *  planificar la siguiente significa rearmar cuarenta asignaciones a mano. */
export async function copiarSemana(desde: string, hacia: string): Promise<DiaItinerario[]> {
  const res = await fetch(
    `${BACKEND_URL}/itinerario/copiar?desde=${encodeURIComponent(desde)}&hacia=${encodeURIComponent(hacia)}`,
    { method: "POST", credentials: "include" },
  );
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo copiar la semana."));
  return res.json();
}
