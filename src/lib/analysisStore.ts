// =============================================================================
// CONDORFINDER — ANÁLISIS GUARDADOS (HDU4)
// Archivo: src/lib/analysisStore.ts
//
// Cliente HTTP para /analyses (backendModel/analyses.py, Mongo) — antes
// vivía en localStorage, documentado desde el principio como un
// placeholder ("cuando exista backend con persistencia real, este módulo
// se reemplaza por llamadas a la API sin cambiar los consumidores").
// Migrado porque localStorage no sincronizaba entre dispositivos/
// navegadores del mismo trabajador, se perdía al limpiar el navegador, y
// no se compartía entre usuarios — un bloqueante real para la nube, mismo
// motivo que ya llevó a migrar `tasks` a Mongo.
//
// Mismo patrón que resources.ts: fetch directo con credentials:"include",
// parseErrorMessage() para traducir errores del backend a texto legible.
// Los tres consumidores (analysis.tsx, index.tsx, rutas.tsx) pasaron de
// leer estas funciones de forma síncrona a hacerlo con await — es el único
// cambio real que les tocó, la forma de los datos no cambió.
// =============================================================================

// CLIENT_BACKEND_URL (no BACKEND_URL): este archivo corre 100% en el
// navegador — necesita la ruta relativa que proxyea vite.config.ts, para
// que la cookie de sesión no se pierda por ser cross-origin. Ver config.ts.
import { CLIENT_BACKEND_URL as BACKEND_URL } from "./config";

/** Forma real del resumen que guarda analysis.tsx — tipada para poder
 *  mostrarla en Vista Principal y en el diálogo de nombre duplicado. */
export interface AnalysisSummary {
  totalVolumeM3: number;
  totalWeightKg: number;
  totalAreaM2: number;
}

export interface SavedAnalysisRecord {
  id: string;
  name: string;
  savedAt: string; // ISO 8601
  mapUrl: string;
  /** Miniatura liviana para tarjetas/listas (Vista Principal, hover de
   *  rutas.tsx) — usar en vez de `mapUrl` (varios MB) donde solo se
   *  necesita una vista previa. Ausente en análisis guardados antes de este
   *  cambio; en ese caso el consumidor debe caer de vuelta a `mapUrl`. */
  thumbnailUrl?: string | null;
  detections: unknown;
  summary: AnalysisSummary | null;
  /** task_id del backend del que salió este análisis, si vino de una
   *  generación en curso. El backend borra ese documento de `tasks` al
   *  guardar (ver analyses.py::_release_source_task) — así no aparece
   *  duplicado como "pendiente" y "guardado" a la vez en Vista Principal. */
  sourceTaskId?: string;
  /** CRS proyectado del ortomosaico (ej. "EPSG:32719") — HDU5 lo necesita
   *  para reproyectar `geo_polygon` de cada detección a WGS84 y ubicarlas
   *  en un mapa real. Ausente en análisis guardados antes de HDU5. */
  crs?: string;
  /** Centro geográfico real del ortomosaico completo (mismo CRS que `crs`)
   *  — a diferencia del centroide de las detecciones, es el mismo sin
   *  importar qué encuentre YOLO en cada corrida. rutas.tsx lo usa para
   *  ubicar la zona de forma consistente entre análisis del mismo set de
   *  fotos. Ausente en análisis guardados antes de este cambio. */
  orthoCenter?: [number, number] | null;
  /** HDU7 — huella geográfica COMPLETA del ortomosaico: [left, bottom,
   *  right, top], mismo CRS que `crs`. El backend la usa (no las
   *  detecciones puntuales) para detectar duplicados — comparar la imagen
   *  completa es robusto a que YOLO detecte la basura en una posición
   *  levemente distinta entre corridas del mismo vuelo. Ausente en
   *  análisis guardados antes de este cambio. */
  orthoBounds?: [number, number, number, number] | null;
  /** HDU7 — id del análisis anterior con el que este se superpone >50% de
   *  área (calculado por el backend con shapely al guardar, nunca por el
   *  frontend). Presente solo si el backend encontró un candidato. */
  possibleDuplicateOf?: string | null;
  /** HDU7 — estado del aviso de posible duplicado: "pending" = todavía sin
   *  resolver (AC2), "confirmed_same"/"confirmed_different" = el trabajador
   *  ya respondió (AC3/AC4). null/ausente = no se detectó superposición. */
  duplicateStatus?: "pending" | "confirmed_same" | "confirmed_different" | null;
  /** HDU7/AC3 — true si este análisis quedó vinculado como versión anterior
   *  de uno más reciente confirmado como la misma zona. Se oculta del
   *  listado principal de Vista Principal (solo visible bajo "Historial"). */
  historical?: boolean;
  /** HDU7/AC3 — id del análisis más reciente que reemplazó a este (se setea
   *  junto con `historical: true`). */
  supersededBy?: string | null;
}

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const parsed = await res.json();
    if (parsed?.detail) {
      return typeof parsed.detail === "string" ? parsed.detail : fallback;
    }
  } catch {
    // respuesta no era JSON — se usa el mensaje genérico
  }
  return fallback;
}

export type SaveAnalysisResult =
  | { ok: true; record: SavedAnalysisRecord }
  | { ok: false; error: string };

/**
 * Lista todos los análisis guardados (AC3 de HDU4). Lanza en caso de error
 * (sesión perdida, red caída) — igual que listResourcePoints() en
 * resources.ts, para que cada consumidor decida si avisa (rutas.tsx) o
 * degrada en silencio (index.tsx, que ya trata así a listResourcePoints en
 * el mismo archivo).
 */
export async function listAnalyses(): Promise<SavedAnalysisRecord[]> {
  const res = await fetch(`${BACKEND_URL}/analyses`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudieron cargar los análisis guardados."));
  }
  return res.json();
}

/**
 * Busca un análisis guardado por nombre exacto (AC6 de HDU4). Trae el
 * listado completo y filtra en el cliente — mismo criterio que
 * resources.py usa para sus puntos, la cantidad de análisis guardados no
 * justifica un endpoint de búsqueda aparte. Si el listado falla, se asume
 * "no hay duplicado" en vez de bloquear el guardado — el intento real de
 * guardar (POST/PUT) es el que va a mostrar el error de red si persiste.
 */
export async function findAnalysisByName(name: string): Promise<SavedAnalysisRecord | null> {
  try {
    const all = await listAnalyses();
    return all.find((r) => r.name === name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Guarda un análisis con el nombre indicado y lo agrega al listado
 * de análisis disponibles (AC2 de HDU4).
 *
 * Si `overwriteId` viene informado, reemplaza ese registro existente (PUT)
 * en vez de crear uno nuevo (POST) — lo usa AC6 cuando el trabajador
 * confirma sobrescribir un análisis con el mismo nombre.
 *
 * Devuelve { ok: false } si el guardado falla (AC5) — hoy eso pasa por un
 * error de red o de sesión; el try/catch cubre ambos sin que el
 * consumidor (analysis.tsx) tenga que distinguirlos.
 */
export async function saveAnalysis(
  name: string,
  data: {
    mapUrl: string;
    thumbnailUrl?: string | null;
    detections: unknown;
    summary: AnalysisSummary | null;
    sourceTaskId?: string;
    crs?: string;
    orthoCenter?: [number, number] | null;
    orthoBounds?: [number, number, number, number] | null;
  },
  overwriteId?: string,
): Promise<SaveAnalysisResult> {
  try {
    const payload = {
      name,
      mapUrl: data.mapUrl,
      thumbnailUrl: data.thumbnailUrl ?? null,
      detections: data.detections ?? [],
      summary: data.summary,
      sourceTaskId: data.sourceTaskId ?? null,
      crs: data.crs ?? null,
      orthoCenter: data.orthoCenter ?? null,
      orthoBounds: data.orthoBounds ?? null,
    };
    const res = await fetch(
      overwriteId
        ? `${BACKEND_URL}/analyses/${encodeURIComponent(overwriteId)}`
        : `${BACKEND_URL}/analyses`,
      {
        method: overwriteId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      },
    );

    if (!res.ok) {
      return { ok: false, error: await parseErrorMessage(res, "No se pudo guardar el análisis.") };
    }

    const record: SavedAnalysisRecord = await res.json();

    // El backend ya borró la tarea de origen (analyses.py::_release_source_task)
    // — deja de aparecer como "en progreso"/"pendiente de análisis" en Vista
    // Principal sin que el frontend tenga que hacer nada más acá.

    return { ok: true, record };
  } catch {
    return {
      ok: false,
      error: "No se pudo guardar el análisis. Verifica tu conexión e intenta nuevamente.",
    };
  }
}

/**
 * Elimina un análisis guardado (botón "Eliminar zona" en Vista Principal).
 * Best-effort, igual que la limpieza de archivos huérfanos que ya hace
 * confirmDelete() en index.tsx justo después de llamar a esto — no hay
 * rollback si falla, solo se intenta.
 */
export async function deleteAnalysis(id: string): Promise<void> {
  try {
    await fetch(`${BACKEND_URL}/analyses/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "include",
    });
  } catch {
    // best-effort — ver docstring
  }
}

/**
 * Busca un análisis guardado por id (AC4 de HDU4). Devuelve null ante
 * cualquier error — el caller (analysis.tsx) ya trata "no encontrado" como
 * "cae al camino normal de carga en vivo", mismo comportamiento correcto
 * para un error de red.
 */
export async function loadAnalysisById(id: string): Promise<SavedAnalysisRecord | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/analyses/${encodeURIComponent(id)}`, {
      credentials: "include",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── HDU7: confirmar/rechazar un posible duplicado ───────────────────────────
// Mismo patrón fetch+credentials:"include" que el resto del archivo — el
// backend hace todo el trabajo real (marcar histórico, vincular), acá solo
// se dispara la acción y se devuelve el análisis actualizado.

/**
 * AC3 — el trabajador confirma que es la misma zona: el análisis anterior
 * (`possibleDuplicateOf`) pasa a histórico, este queda como la versión
 * vigente. Devuelve null si la llamada falla (red/sesión) — el caller
 * decide cómo avisar, mismo criterio que el resto de este archivo.
 */
export async function confirmDuplicate(id: string): Promise<SavedAnalysisRecord | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/analyses/${encodeURIComponent(id)}/confirm-duplicate`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * AC4 — el trabajador indica que son zonas distintas: ambos registros se
 * mantienen por separado, solo se cierra el aviso de posible duplicado.
 */
export async function rejectDuplicate(id: string): Promise<SavedAnalysisRecord | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/analyses/${encodeURIComponent(id)}/reject-duplicate`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── handoff entre rutas: qué análisis abrir al llegar a /analysis ──────────
// Se queda en sessionStorage — es coordinación de navegación entre vistas
// dentro de la MISMA pestaña, no persistencia de datos; no tiene relación
// con la migración a Mongo de arriba. Mismo patrón que mapState.ts.

const isBrowser = typeof window !== "undefined";
const KEY_PENDING_OPEN_ID = "condorfinder_pending_open_analysis_id";

export function setPendingOpenId(id: string): void {
  if (!isBrowser) return;
  sessionStorage.setItem(KEY_PENDING_OPEN_ID, id);
}

export function consumePendingOpenId(): string | null {
  if (!isBrowser) return null;
  const id = sessionStorage.getItem(KEY_PENDING_OPEN_ID);
  if (id) sessionStorage.removeItem(KEY_PENDING_OPEN_ID);
  return id;
}
