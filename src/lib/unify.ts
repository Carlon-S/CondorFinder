// =============================================================================
// CONDORFINDER — SERVICIO DE UNIFICACIÓN DE IMÁGENES
// Archivo: src/lib/unify.ts
//
// Este módulo actúa como la capa de comunicación entre el frontend y el
// backend para el proceso de unificación de imágenes aéreas (HDU1).
//
// Estado actual: SIMULADO
// El backend aún no está implementado. La función principal retorna
// respuestas predefinidas para permitir el desarrollo y prueba del frontend
// de forma independiente. Cuando el backend esté disponible, solo se debe
// descomentar el bloque de llamada real y eliminar el bloque simulado.
// =============================================================================


// =============================================================================
// INTERFACES DE RESPUESTA
// Definen el contrato entre el frontend y el backend.
// El backend deberá retornar un objeto que cumpla con UnifySuccess o UnifyError.
// =============================================================================

/**
 * Respuesta exitosa del proceso de unificación.
 * Se retorna cuando las imágenes fueron procesadas correctamente.
 *
 * @property status   - Siempre "success" para identificar el tipo de respuesta
 * @property overlap  - Porcentaje de solapamiento calculado entre las imágenes (0-100)
 * @property mapUrl                  - URL del preview web del mapa unificado (idealmente WEBP)
 * @property technicalDownloadUrl    - URL opcional de la salida tecnica completa (TIF o PNG)
 * @property technicalDownloadFormat - Formato opcional de la salida tecnica
 */
export interface UnifySuccess {
  status: "success";
  overlap: number;
  mapUrl: string;
  technicalDownloadUrl?: string;
  technicalDownloadFormat?: "TIF" | "PNG" | "WEBP";
}

/**
 * Respuesta de error del proceso de unificación.
 * Se retorna cuando el proceso no puede completarse por alguna condición inválida.
 *
 * @property status   - Siempre "error" para identificar el tipo de respuesta
 * @property reason   - Código de error legible por el sistema. Valores posibles:
 *                        "overlap_too_low" → solapamiento insuficiente entre imágenes
 *                        (pueden agregarse más códigos según el backend)
 * @property overlap  - Porcentaje de solapamiento calculado (opcional, presente en overlap_too_low)
 * @property message  - Mensaje de error técnico para logging o depuración
 */
export interface UnifyError {
  status: "error";
  reason: string;
  overlap?: number;
  message: string;
}

/**
 * Tipo unión que representa cualquier respuesta posible del servicio.
 * El frontend discrimina entre éxito y error mediante la propiedad "status".
 */
export type UnifyResponse = UnifySuccess | UnifyError;


// =============================================================================
// OPCIONES DE LA FUNCIÓN
// =============================================================================

/**
 * Opciones de configuración para la llamada al servicio de unificación.
 *
 * @property forceLowOverlap - Solo para desarrollo/testing. Si es true, fuerza
 *                             una respuesta de error por solapamiento insuficiente (42%),
 *                             permitiendo probar el flujo de error sin necesidad del backend.
 *                             Debe eliminarse o deshabilitarse en producción.
 */
export interface UnifyOptions {
  forceLowOverlap?: boolean;
}


// =============================================================================
// FUNCIÓN PRINCIPAL
// =============================================================================

/**
 * Envía las imágenes al backend para su unificación y retorna el resultado.
 *
 * Flujo esperado en producción:
 * 1. Recibe el array de archivos JPG válidos seleccionados por el usuario
 * 2. Los empaqueta en un FormData y los envía al endpoint /api/images/unify
 * 3. El backend procesa las imágenes (solapamiento, unificación, generación del mapa)
 * 4. Retorna UnifySuccess con el mapa generado, o UnifyError si algo falla
 *
 * Flujo actual (simulado):
 * - Espera 800ms para simular latencia de red
 * - Si forceLowOverlap es true, retorna error de solapamiento (42%)
 * - En caso contrario, retorna éxito con solapamiento simulado de 64%
 *   y mapUrl vacío (el frontend usa el preview simulado en ese caso)
 *
 * @param files   - Array de objetos File con las imágenes JPG a procesar
 * @param options - Opciones adicionales (ver UnifyOptions)
 * @returns       - Promesa que resuelve en UnifySuccess o UnifyError
 */
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
  // Simula la latencia de una llamada real al servidor
  await new Promise((r) => setTimeout(r, 800));

  // Simula un error de solapamiento insuficiente para pruebas del flujo de error
  if (options.forceLowOverlap) {
    return {
      status: "error",
      reason: "overlap_too_low",
      overlap: 42,
      message: "Las imágenes no cumplen el mínimo de superposición.",
    };
  }

  // Simula una respuesta exitosa con solapamiento del 64% (supera el mínimo de 60%).
  // mapUrl vacio -> el frontend usara unified-map-preview.webp.
  // technicalDownloadUrl vacio -> el frontend usara unified-map-simulation.png.
  return {
    status: "success",
    overlap: 64,
    mapUrl: "",
    technicalDownloadUrl: "",
    technicalDownloadFormat: "PNG",
  };
}
