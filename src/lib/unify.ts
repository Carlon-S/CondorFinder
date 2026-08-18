// =============================================================================
// CONDORFINDER — SERVICIO DE UNIFICACIÓN DE IMÁGENES
// Archivo: src/lib/unify.ts
//
// Este módulo actúa como la capa de comunicación entre el frontend y el
// backend para el proceso de unificación de imágenes aéreas (HDU1).
//
// Estado actual: PARCIALMENTE INTEGRADO
// unifyImages sigue simulada hasta que el backend implemente /api/images/unify.
// uploadImages, deleteImage y deleteAllImages ya se conectan al backend real
// en localhost:8000.
// =============================================================================

import { BACKEND_URL } from "./config";


// =============================================================================
// INTERFACES DE RESPUESTA
// =============================================================================

export interface UnifySuccess {
  status: "success";
  mapUrl: string;
  detectionCount: number;
  detectionJsonUrl?: string;
  technicalDownloadUrl?: string;
  technicalDownloadFormat?: "TIF" | "PNG" | "WEBP";
}

export interface OverlapPair {
  imagen_1: string;
  imagen_2: string;
  solape: number;
  distancia_m: number;
}

export interface UnifyError {
  status: "error";
  reason: string;
  message: string;
  overlapDetail?: OverlapPair[];
  overlapTotal?: number;
}

export interface UnifyProgress {
  status: "checking_overlap" | "joining" | "detecting";
  backendStatus: string;
}

export type UnifyResponse = UnifySuccess | UnifyError;


// =============================================================================
// OPCIONES
// =============================================================================

export interface UnifyOptions {
  forceLowOverlap?: boolean;
}


// =============================================================================
// CONSTANTE DE URL DEL BACKEND
// =============================================================================

const POLLING_INTERVAL_MS = 5000;


// =============================================================================
// FUNCIÓN PRINCIPAL (simulada hasta que exista /api/images/unify)
// =============================================================================

export async function unifyImages(
  files: File[],
  options: UnifyOptions = {},
  onProgress?: (stage: "checking_overlap" | "joining" | "detecting") => void,
  onTaskCreated?: (taskId: string) => void,
): Promise<UnifyResponse> {

  // Inicia el pipeline en el backend y obtiene task_id
  const startRes = await fetch(`${BACKEND_URL}/generate`, { method: "POST" });
  const startData = await startRes.json();

  if (startData.status === "error") {
    return {
      status: "error",
      reason: "backend_error",
      message: startData.message,
    };
  }

 const taskId = startData.task_id;
  if (onTaskCreated) onTaskCreated(taskId);

  return pollTask(taskId, onProgress);
}


export interface RawTaskStatus {
  status: string;
  message: string;
  result_url?: string;
  result_json_url?: string;
  detection_count?: number;
}

/**
 * Consulta el estado de una tarea una sola vez (sin loop de polling).
 * Usado por carga.tsx para retomar una generación en curso al volver a esa
 * vista. Devuelve null si el backend no responde (caído, red, etc.).
 */
export async function getTaskStatus(taskId: string): Promise<RawTaskStatus | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/status/${taskId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export interface PendingTask {
  taskId: string;
  status: string;
  message: string;
  createdAt: string | null;
  resultUrl?: string;
  resultJsonUrl?: string;
  detectionCount?: number;
}

/**
 * Lista las tareas "en progreso" o "done pero todavía no guardadas" —
 * reemplaza taskRegistry.ts (localStorage). Antes, Vista Principal llevaba
 * su propia lista de task_id por navegador; una falla de red al consultar
 * el estado (ej. un reinicio de uvicorn en el momento equivocado) hacía que
 * esa tarea se desregistrara para siempre aunque siguiera sana en Mongo.
 * Ahora es una sola consulta al backend, que es la única fuente de verdad.
 * Lanza en caso de error — el caller decide si degrada en silencio o avisa.
 */
export async function listPendingTasks(): Promise<PendingTask[]> {
  const res = await fetch(`${BACKEND_URL}/tasks/pending`);
  if (!res.ok) {
    throw new Error("No se pudieron cargar las tareas pendientes.");
  }
  const raw: {
    task_id: string;
    status: string;
    message: string;
    created_at: string | null;
    result_url?: string;
    result_json_url?: string;
    detection_count?: number;
  }[] = await res.json();

  return raw.map((t) => ({
    taskId: t.task_id,
    status: t.status,
    message: t.message,
    createdAt: t.created_at,
    resultUrl: t.result_url,
    resultJsonUrl: t.result_json_url,
    detectionCount: t.detection_count,
  }));
}

export async function pollTask(
  taskId: string,
  onProgress?: (stage: "checking_overlap" | "joining" | "detecting") => void,
  signal?: AbortSignal,
): Promise<UnifyResponse> {
  while (true) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");

    const statusRes = await fetch(`${BACKEND_URL}/status/${taskId}`, { signal });
    const statusData = await statusRes.json();

    if (statusData.status === "done") {
      return {
        status: "success",
        mapUrl: statusData.result_url,
        detectionCount: statusData.detection_count ?? 0,
        detectionJsonUrl: statusData.result_json_url,
        technicalDownloadUrl: statusData.result_url,
        technicalDownloadFormat: "PNG",
      };
    }

    if (statusData.status === "error") {
      return {
        status: "error",
        reason: "pipeline_error",
        message: statusData.message,
        overlapDetail: statusData.overlap_detail,
        overlapTotal: statusData.overlap_total,
      };
    }

    if (statusData.status === "cancelled") {
      return {
        status: "error",
        reason: "cancelled",
        message: statusData.message || "Generación cancelada por el usuario.",
      };
    }

    if (
      (statusData.status === "checking_overlap" ||
        statusData.status === "joining" ||
        statusData.status === "detecting") &&
      onProgress
    ) {
      onProgress(statusData.status);
    }

    // Espera DESPUÉS del chequeo: la primera iteración es siempre inmediata
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, POLLING_INTERVAL_MS);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }
}


// =============================================================================
// FUNCIONES DE PERSISTENCIA EN BACKEND
// =============================================================================

/**
 * Sube las imágenes JPG al backend para persistirlas en disco.
 * Usa XMLHttpRequest en lugar de fetch para poder reportar progreso real.
 *
 * @param files      - Archivos JPG válidos a subir
 * @param onProgress - Callback opcional con porcentaje 0-100
 */
export async function uploadImages(
  files: File[],
  onProgress?: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((f) => formData.append("images", f));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BACKEND_URL}/upload`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded * 100) / e.total));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      // El backend devuelve 409 + {"detail": "..."} cuando UPLOAD_DIR está
      // ocupado por otra tarea en curso (ver is_pipeline_busy en
      // orquestador.py) — se propaga ese mensaje en vez de uno genérico para
      // que el usuario entienda por qué falló.
      let message = `Upload failed: ${xhr.status}`;
      try {
        const parsed = JSON.parse(xhr.responseText);
        if (parsed?.detail) message = parsed.detail;
      } catch {
        // responseText no era JSON — se usa el mensaje genérico
      }
      reject(new Error(message));
    };

    xhr.onerror = () => reject(new Error("Upload error"));
    xhr.send(formData);
  });
}

/**
 * Consulta si el servidor está ocupado con otra tarea (checking_overlap /
 * joining / detecting / running) — independiente de lo que sepa localmente
 * ESTA pestaña. Se usa al montar /carga para que el botón "Generar mapa
 * unificado" arranque en el estado correcto incluso después de un F5, en
 * vez de depender de un intento fallido previo que ya se perdió al
 * recargar la página.
 */
export async function getPipelineStatus(): Promise<{ busy: boolean } | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/pipeline-status`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Consulta al backend qué imágenes están actualmente en images/.
 * Retorna un array de nombres de archivo.
 */
export async function listUploadedImages(): Promise<string[] | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/upload`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.archivos ?? [];
  } catch {
    return null;  // null = backend inalcanzable, [] = backend vacío
  }
}

/**
 * Solicita cancelar una tarea en curso. El backend solo puede aplicar la
 * cancelación entre fases (no interrumpe una llamada a ODM o YOLO ya en
 * curso) — ver comentario en orquestador.py::run_pipeline.
 */
export async function cancelTask(taskId: string): Promise<void> {
  await fetch(`${BACKEND_URL}/cancel/${taskId}`, { method: "POST" }).catch(() => {});
}

/**
 * Elimina una imagen del backend por nombre de archivo.
 * Se llama cuando el usuario elimina una imagen individual del frontend.
 */
export async function deleteImage(filename: string): Promise<void> {
  await fetch(`${BACKEND_URL}/upload/${encodeURIComponent(filename)}`, {
    method: "DELETE",
  });
}

/**
 * Elimina todas las imágenes del backend.
 * Se llama cuando el usuario limpia todas las imágenes del frontend.
 */
export async function deleteAllImages(): Promise<void> {
  await fetch(`${BACKEND_URL}/upload`, { method: "DELETE" });
}

/**
 * Versión síncrona de deleteAllImages para usar en beforeunload.
 * keepalive: true garantiza que el browser complete la petición aunque la página esté cerrando.
 */
export function deleteAllImagesSync(): void {
  fetch(`${BACKEND_URL}/upload`, { method: "DELETE", keepalive: true });
}

/**
 * URL para ver una imagen ya subida al backend — usado para reconstruir las
 * miniaturas de "Imágenes adjuntas" al retomar una generación en curso desde
 * la Vista Principal, donde ya no existen los File originales en memoria.
 */
export function getUploadedImageUrl(filename: string): string {
  return `${BACKEND_URL}/upload/${encodeURIComponent(filename)}`;
}

/**
 * Borra un archivo de resultado (imagen o JSON) en el backend.
 * Se usa al eliminar una zona guardada, para no dejar archivos huérfanos.
 */
export async function deleteResultFile(filename: string): Promise<void> {
  await fetch(`${BACKEND_URL}/result/${encodeURIComponent(filename)}`, {
    method: "DELETE",
  }).catch(() => {});
}

/**
 * Borra el ortomosaico .tif de joining/finals/ — sin esto, esa carpeta
 * nunca se limpiaba para ninguna zona, ni siquiera las guardadas y luego
 * eliminadas correctamente desde la UI (deleteResultFile solo apunta a
 * detecting/output/, no a joining/finals/).
 */
export async function deleteFinalsFile(filename: string): Promise<void> {
  await fetch(`${BACKEND_URL}/finals/${encodeURIComponent(filename)}`, {
    method: "DELETE",
  }).catch(() => {});
}

// =============================================================================
// SNAPSHOT DE IMÁGENES POR TAREA
//
// UPLOAD_DIR en el backend es una carpeta COMPARTIDA que se sobreescribe con
// cada carga nueva. Estas funciones consultan la "foto" que el backend toma
// de las imágenes de cada tarea al momento de crearla (ver /generate en
// orquestador.py), para poder mostrar el set ORIGINAL correcto al retomar
// una tarea antigua desde la Vista Principal — no el set actual de UPLOAD_DIR.
// =============================================================================

/**
 * Consulta al backend qué imágenes se usaron para iniciar una tarea puntual.
 */
export async function listTaskImages(taskId: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/task-images/${encodeURIComponent(taskId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.archivos ?? [];
  } catch {
    return null;
  }
}

/**
 * URL para ver una imagen del snapshot de una tarea puntual.
 */
export function getTaskImageUrl(taskId: string, filename: string): string {
  return `${BACKEND_URL}/task-images/${encodeURIComponent(taskId)}/${encodeURIComponent(filename)}`;
}

/**
 * Borra el snapshot de imágenes de una tarea — usado al eliminar una zona
 * (en cualquier estado) para no dejar copias huérfanas en el servidor.
 */
export async function deleteTaskImages(taskId: string): Promise<void> {
  await fetch(`${BACKEND_URL}/task-images/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  }).catch(() => {});
}

/**
 * Borra el documento de la tarea en Mongo — sin esto, eliminar una zona
 * (guardada o no) desde Vista Principal dejaba su tarea huérfana en la
 * colección `tasks` para siempre, ahora que ese estado persiste entre
 * reinicios de uvicorn (antes se perdía solo con reiniciar).
 */
export async function deleteTask(taskId: string): Promise<void> {
  await fetch(`${BACKEND_URL}/status/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  }).catch(() => {});
}