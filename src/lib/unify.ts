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
  overlap: number;
  mapUrl: string;
  technicalDownloadUrl?: string;
  technicalDownloadFormat?: "TIF" | "PNG" | "WEBP";
}

export interface UnifyError {
  status: "error";
  reason: string;
  overlap?: number;
  message: string;
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


// =============================================================================
// FUNCIÓN PRINCIPAL (simulada hasta que exista /api/images/unify)
// =============================================================================

export async function unifyImages(
  files: File[],
  options: UnifyOptions = {},
): Promise<UnifyResponse> {

  // --- Llamada real al backend (descomentar cuando el API esté disponible) ---
  // const formData = new FormData();
  // files.forEach((f) => formData.append("images", f));
  // const res = await fetch("/api/images/unify", { method: "POST", body: formData });
  // return (await res.json()) as UnifyResponse;

  // --- Respuesta simulada (eliminar cuando el backend esté disponible) ---
  await new Promise((r) => setTimeout(r, 800));

  if (options.forceLowOverlap) {
    return {
      status: "error",
      reason: "overlap_too_low",
      overlap: 42,
      message: "Las imágenes no cumplen el mínimo de superposición.",
    };
  }

  return {
    status: "success",
    overlap: 64,
    mapUrl: "",
    technicalDownloadUrl: "",
    technicalDownloadFormat: "PNG",
  };
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