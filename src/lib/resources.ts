// =============================================================================
// CONDORFINDER — RECURSOS DISPONIBLES (HDU6)
// Archivo: src/lib/resources.ts
//
// Mismo patrón que unify.ts/auth.ts: un módulo chico por responsabilidad,
// fetch directo con credentials: "include" (la cookie de sesión viaja
// sola, mismo mecanismo que el resto del backend ya protegido).
// =============================================================================

// CLIENT_BACKEND_URL (no BACKEND_URL): este archivo corre 100% en el
// navegador — necesita la ruta relativa que proxyea vite.config.ts, para
// que la cookie de sesión no se pierda por ser cross-origin. Ver config.ts.
import { CLIENT_BACKEND_URL as BACKEND_URL } from "./config";

export interface Truck {
  capacity_m3: number;
}

// Mismo shape que Truck — se mantiene como tipo aparte porque tolvas y
// camiones son conceptos de dominio distintos, no una coincidencia a reusar.
export interface Tolva {
  capacity_m3: number;
}

export interface ResourcePointInput {
  name: string;
  address: string;
  comuna: string;
  lat: number;
  lng: number;
  tolvas: Tolva[];
  retroexcavadoras_count: number;
  trucks: Truck[];
  personal_count: number;
  // HDU5/AC1 — si participa como origen al generar una ruta.
  active: boolean;
}

export interface ResourcePoint extends ResourcePointInput {
  id: string;
  owner: string;
  created_at: string;
}

/** Campo de un error de validación de FastAPI: loc es la ruta al campo
 *  ("body", "tolvas", 0, "capacity_m3") y msg el motivo. */
interface ValidationError {
  loc?: (string | number)[];
  msg?: string;
}

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const parsed = await res.json();
    const detail = parsed?.detail;
    if (typeof detail === "string") return detail;

    // Un 422 de FastAPI trae `detail` como LISTA de errores por campo, no como
    // texto. Antes esa rama caía directo al mensaje genérico, así que un
    // rechazo de validación (por ejemplo una capacidad en 0, que el backend
    // exige > 0) se veía en pantalla como "No se pudo guardar el punto" sin
    // decir qué campo estaba mal, y quedaba indistinguible de una caída de red.
    if (Array.isArray(detail) && detail.length > 0) {
      const campos = (detail as ValidationError[])
        .map((e) => {
          // Se salta el primer tramo del loc, que siempre es "body".
          const ruta = (e.loc ?? []).slice(1).join(".");
          return ruta ? `${ruta}: ${e.msg ?? "valor inválido"}` : e.msg;
        })
        .filter(Boolean)
        .slice(0, 3)
        .join(" · ");
      if (campos) return `${fallback} Revisa: ${campos}`;
    }
  } catch {
    // respuesta no era JSON, se usa el mensaje genérico
  }
  return fallback;
}

export async function createResourcePoint(point: ResourcePointInput): Promise<ResourcePoint> {
  const res = await fetch(`${BACKEND_URL}/resources/points`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(point),
  });

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo guardar el punto."));
  }

  return res.json();
}

export async function listResourcePoints(): Promise<ResourcePoint[]> {
  const res = await fetch(`${BACKEND_URL}/resources/points`, {
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudieron cargar los puntos."));
  }

  return res.json();
}

export async function updateResourcePoint(id: string, point: ResourcePointInput): Promise<ResourcePoint> {
  const res = await fetch(`${BACKEND_URL}/resources/points/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(point),
  });

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo actualizar el punto."));
  }

  return res.json();
}

export async function deleteResourcePoint(id: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/resources/points/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo eliminar el punto."));
  }
}
