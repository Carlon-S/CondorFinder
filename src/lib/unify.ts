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


// =============================================================================
// INTERFACES DE RESPUESTA
// =============================================================================

export interface UnifySuccess {
  status: "success";
  mapUrl: string;
  detectionCount: number;
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

const BACKEND_URL = "http://localhost:8000";
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
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed: ${xhr.status}`));
    };

    xhr.onerror = () => reject(new Error("Upload error"));
    xhr.send(formData);
  });
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