// =============================================================================
// CONDORFINDER — PERSISTENCIA DEL MAPA ENTRE RUTAS
// Archivo: src/lib/mapState.ts
//
// Persiste la URL del mapa generado en HDU1 (index.tsx) para que HDU2
// (analysis.tsx) pueda acceder a ella sin necesidad de backend ni estado global.
//
// Se usa sessionStorage porque:
// - Sobrevive a la navegación entre rutas dentro de la misma pestaña.
// - Se limpia automáticamente al cerrar el navegador (sin datos residuales).
// - No requiere librerías externas.
//
// Cuando exista backend con persistencia real (base de datos, S3, etc.),
// este módulo puede reemplazarse por una llamada a la API sin cambiar
// los consumidores (index.tsx y analysis.tsx).
// =============================================================================

const MAP_URL_KEY = "condorfinder:unified_map_url";

/**
 * Guarda la URL del mapa unificado generado en HDU1.
 * Llamar desde index.tsx cuando el proceso termina con éxito.
 *
 * @param url - URL del mapa (blob:, data:, https: o ruta local)
 */
export const MAP_READY_EVENT = "condorfinder:map-ready";

export function saveMapUrl(url: string): void {
  try {
    sessionStorage.setItem(MAP_URL_KEY, url);
    window.dispatchEvent(new CustomEvent(MAP_READY_EVENT, { detail: { url } }));
  } catch {
    // sessionStorage puede fallar en modo privado con cuota llena.
    // Se ignora silenciosamente: analysis.tsx caerá al fallback local.
    console.warn("[CondorFinder] No se pudo guardar la URL del mapa en sessionStorage.");
  }
}

/**
 * Recupera la URL del mapa generado en HDU1.
 * Llamar desde analysis.tsx al montar la vista.
 *
 * @returns URL del mapa si existe, o null si no hay mapa guardado.
 */
export function loadMapUrl(): string | null {
  try {
    return sessionStorage.getItem(MAP_URL_KEY);
  } catch {
    return null;
  }
}

/**
 * Elimina la URL guardada del mapa.
 * Útil si el usuario decide limpiar todas las imágenes y reiniciar el flujo.
 */
export function clearMapUrl(): void {
  try {
    sessionStorage.removeItem(MAP_URL_KEY);
  } catch {
    // Ignorar silenciosamente
  }
}