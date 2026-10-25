// =============================================================================
// CONDORFINDER, PUNTOS DIARIOS DE RETIRO (HDU15)
// Archivo: src/lib/puntosDiarios.ts
//
// Los retiros del día que no son permanentes: escombros y extras. Mismo patrón
// que el resto de src/lib.
//
// Un punto diario NO es una zona, a diferencia de un punto permanente. Una
// zona es un lugar que se sigue en el tiempo; un punto diario es un hecho de
// una fecha. Guardarlos como zonas llenaría Vista Principal de cientos de
// lugares de una sola visita.
// =============================================================================

import { CLIENT_BACKEND_URL as BACKEND_URL } from "./config";

export type ClasePunto = "escombros" | "extras";

/** Lo que la planilla pone en la columna TIPO de la tabla de escombros. */
export const TIPOS_ESCOMBRO = ["ESC", "RAMAS", "MIXTO", "VOLUMINOSOS"] as const;

export interface PuntoDiario {
  id: string;
  owner: string;
  createdAt: string;
  clase: ClasePunto;
  /** `YYYY-MM-DD`. */
  fecha: string;
  address: string;
  barrio?: string | null;
  lat?: number | null;
  lng?: number | null;
  telefono?: string | null;
  /** Lo que DECLARA quien llama, no lo que se retiró. Son dos hechos
   *  distintos y el segundo todavía no se captura. */
  volumenM3?: number | null;
  /** Solo escombros. */
  tipoResiduo?: string | null;
  /** Solo extras. */
  solicitud?: string | null;
  solicitante?: string | null;
}

export type PuntoDiarioInput = Omit<PuntoDiario, "id" | "owner" | "createdAt">;

export interface Solicitud {
  id: string;
  nombre: string;
  area: string;
  /** `true` para los 17 que vinieron de la planilla municipal. */
  base: boolean;
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

/** Los puntos de una fecha. Sin argumento, los de hoy. */
export async function listarPuntosDiarios(fecha?: string): Promise<PuntoDiario[]> {
  const q = fecha ? `?fecha=${encodeURIComponent(fecha)}` : "";
  const res = await fetch(`${BACKEND_URL}/puntos-diarios${q}`, { credentials: "include" });
  if (!res.ok)
    throw new Error(await mensajeDeError(res, "No se pudieron cargar los puntos del día."));
  return res.json();
}

export async function crearPuntoDiario(data: PuntoDiarioInput): Promise<PuntoDiario> {
  const res = await fetch(`${BACKEND_URL}/puntos-diarios`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo crear el punto."));
  return res.json();
}

export async function editarPuntoDiario(id: string, data: PuntoDiarioInput): Promise<PuntoDiario> {
  const res = await fetch(`${BACKEND_URL}/puntos-diarios/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo guardar el punto."));
  return res.json();
}

export async function eliminarPuntoDiario(id: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/puntos-diarios/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo eliminar el punto."));
}

/** Los 17 programas de la hoja SOLICITUDES más los que haya agregado el
 *  usuario. Es vocabulario de la municipalidad, no una constante del sistema,
 *  por eso vive en la base y se puede ampliar. */
export async function listarSolicitudes(): Promise<Solicitud[]> {
  const res = await fetch(`${BACKEND_URL}/puntos-diarios/solicitudes`, { credentials: "include" });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudieron cargar las solicitudes."));
  return res.json();
}

export async function crearSolicitud(nombre: string, area = "CONTROL"): Promise<Solicitud> {
  const res = await fetch(`${BACKEND_URL}/puntos-diarios/solicitudes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ nombre, area }),
  });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo crear la solicitud."));
  return res.json();
}

/** La fecha de hoy como `YYYY-MM-DD`, en la zona horaria del navegador.
 *
 *  A mano y no con `toISOString()`, que convierte a UTC: en Chile eso devuelve
 *  el día siguiente desde las 21:00, así que los puntos creados de noche
 *  aparecerían con la fecha de mañana y desaparecerían de la vista. */
export function hoy(): string {
  const d = new Date();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mes}-${dia}`;
}
