// =============================================================================
// CONDORFINDER — PUNTOS DE SALIDA (HDU6) Y RECURSOS (HDU8)
// Archivo: src/lib/resources.ts
//
// Mismo patrón que unify.ts/auth.ts: un módulo chico por responsabilidad,
// fetch directo con credentials: "include" (la cookie de sesión viaja
// sola, mismo mecanismo que el resto del backend ya protegido).
//
// El punto es el LUGAR y el recurso es la UNIDAD que opera desde ahí. HDU6
// guardaba la maquinaria como contadores dentro del punto (`tolvas`, `trucks`,
// `retroexcavadoras_count`); HDU8 los reemplazó por recursos individuales, cada
// uno con su identidad y su propio interruptor de disponibilidad, porque un
// contador no tiene patente y no se puede marcar como "en taller". Los campos
// en snake_case son los del backend, que en este módulo nunca usó camelCase.
// =============================================================================

// CLIENT_BACKEND_URL (no BACKEND_URL): este archivo corre 100% en el
// navegador — necesita la ruta relativa que proxyea vite.config.ts, para
// que la cookie de sesión no se pierda por ser cross-origin. Ver config.ts.
import { CLIENT_BACKEND_URL as BACKEND_URL } from "./config";

/** Familia de un tipo de recurso. Decide qué campos pide el formulario (AC2 de
 *  HDU8) y qué recursos suman capacidad de transporte.
 *
 *   carga    -> capacidad de la tolva o caja. Es la que cuenta para la ruta.
 *   maquina  -> capacidad del balde. Carga, no transporta.
 *   arrastre -> se remolca; sin capacidad ni dotación propia.
 *   apoyo    -> vehículo de supervisión, sin capacidad de carga. */
export type ResourceFamily = "carga" | "maquina" | "arrastre" | "apoyo";

export interface ResourceType {
  tipo: string;
  familia: ResourceFamily;
}

export interface ResourceInput {
  tipo: string;
  numero_equipo: string;
  patente: string;
  marca: string;
  modelo: string;
  anio: number | null;
  /** Solo familia "carga". En las demás el backend rechaza el campo, no lo
   *  ignora: una capacidad de carga guardada en una retroexcavadora la haría
   *  aparecer como transporte disponible en el ruteo. */
  capacidad_m3: number | null;
  /** Solo familia "maquina". */
  capacidad_balde_m3: number | null;
  conductores_requeridos: number;
  peonetas_requeridas: number;
  operadores_requeridos: number;
  observaciones: string;
  /** Nombre del archivo, no una URL. La URL se arma con resourcePhotoUrl(). */
  foto: string | null;
  /** AC4 de HDU8. */
  disponible: boolean;
  point_id: string;
}

export interface Resource extends ResourceInput {
  id: string;
  owner: string;
  created_at: string;
  /** Derivada del tipo por el backend, nunca enviada por el cliente. */
  familia: ResourceFamily;
}

export interface ResourcePointInput {
  name: string;
  address: string;
  comuna: string;
  lat: number;
  lng: number;
  /** Trabajadores del punto. Se mantuvo cuando la maquinaria pasó a recursos
   *  porque es el único dato de HDU6 sin equivalente en la planilla de flota:
   *  la planilla trae la dotación que un vehículo REQUIERE, no los
   *  trabajadores que el punto TIENE. */
  personal_count: number;
  // HDU5/AC1 — si participa como origen al generar una ruta.
  active: boolean;
}

export interface ResourcePoint extends ResourcePointInput {
  id: string;
  owner: string;
  created_at: string;
  // Resumen de los recursos del punto, CALCULADO por el backend en cada
  // lectura. Reemplaza a los contadores en todas las vistas que los mostraban.
  // No se envía al crear ni al editar.
  resource_count: number;
  available_count: number;
  /** Capacidad de transporte disponible, en m³. Cuenta exactamente lo mismo que
   *  cuenta el ruteo: familia "carga", disponible y con capacidad declarada. */
  capacity_m3: number;
}

/** URL de la foto de un recurso. El endpoint exige sesión, igual que el resto
 *  del router; la cookie viaja sola en un `<img src>`. */
export function resourcePhotoUrl(foto: string): string {
  return `${BACKEND_URL}/resources/photo/${encodeURIComponent(foto)}`;
}

/** Campo de un error de validación de FastAPI: loc es la ruta al campo
 *  ("body", "capacidad_m3") y msg el motivo. */
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

// =============================================================================
// RECURSOS (HDU8)
// =============================================================================

/** Tipos de recurso con su familia. Los sirve el backend en vez de tenerlos
 *  duplicados acá: la familia decide qué campos pide el formulario, y con dos
 *  copias de esa tabla una validación aceptada en pantalla podría ser rechazada
 *  por el servidor sin explicación. */
export async function listResourceTypes(): Promise<ResourceType[]> {
  const res = await fetch(`${BACKEND_URL}/resources/types`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudieron cargar los tipos de recurso."));
  }
  return res.json();
}

export async function listResources(pointId?: string): Promise<Resource[]> {
  const url = pointId
    ? `${BACKEND_URL}/resources/units?pointId=${encodeURIComponent(pointId)}`
    : `${BACKEND_URL}/resources/units`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudieron cargar los recursos."));
  }
  return res.json();
}

export async function createResource(resource: ResourceInput): Promise<Resource> {
  const res = await fetch(`${BACKEND_URL}/resources/units`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(resource),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo guardar el recurso."));
  }
  return res.json();
}

/** AC3 de HDU8. */
export async function updateResource(id: string, resource: ResourceInput): Promise<Resource> {
  const res = await fetch(`${BACKEND_URL}/resources/units/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(resource),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo actualizar el recurso."));
  }
  return res.json();
}

/** AC4 de HDU8. Endpoint propio y no un PUT completo: es la acción más
 *  frecuente de la vista (un camión entra y sale de taller), y con PUT habría
 *  que reenviar el recurso entero, con riesgo de pisar un campo que alguien más
 *  editó en el intervalo. */
export async function setResourceAvailability(id: string, disponible: boolean): Promise<Resource> {
  const res = await fetch(
    `${BACKEND_URL}/resources/units/${encodeURIComponent(id)}/disponibilidad`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ disponible }),
    },
  );
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo cambiar la disponibilidad."));
  }
  return res.json();
}

export async function deleteResource(id: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/resources/units/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo eliminar el recurso."));
  }
}

/** Campos que la familia del tipo hace relevantes. Una sola definición para el
 *  formulario, la lista y las validaciones: si cada lugar decidiera por su
 *  cuenta, el formulario podría pedir un campo que el backend rechaza. */
export function camposDeFamilia(familia: ResourceFamily): {
  capacidadCarga: boolean;
  capacidadBalde: boolean;
  dotacion: boolean;
  motorizado: boolean;
} {
  return {
    capacidadCarga: familia === "carga",
    capacidadBalde: familia === "maquina",
    // Un carro se remolca: no lleva tripulación propia.
    dotacion: familia !== "arrastre",
    // Los carros de la flota real no declaran marca, modelo ni año.
    motorizado: familia !== "arrastre",
  };
}

/** Recurso vacío del tipo dado, para abrir el formulario ya coherente con su
 *  familia. Al cambiar de tipo hay que volver a pasar por acá: si quedara una
 *  capacidad de carga puesta y el tipo nuevo es una máquina, el backend
 *  responde 422 y el usuario no tiene forma de saber qué campo sobra. */
export function recursoVacio(tipo: string, pointId: string): ResourceInput {
  return {
    tipo,
    numero_equipo: "",
    patente: "",
    marca: "",
    modelo: "",
    anio: null,
    capacidad_m3: null,
    capacidad_balde_m3: null,
    conductores_requeridos: 0,
    peonetas_requeridas: 0,
    operadores_requeridos: 0,
    observaciones: "",
    foto: null,
    disponible: true,
    point_id: pointId,
  };
}
