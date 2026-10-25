// =============================================================================
// CONDORFINDER — CACHE DE VERIFICACIÓN DE SESIÓN
// Archivo: src/lib/authState.ts
//
// TanStack Router no tiene ningún mecanismo de cache para beforeLoad
// (staleTime/gcTime solo aplican a loader, que este proyecto no usa) — así
// que _authed.tsx reverifica la sesión contra /auth/me en CADA navegación
// del lado del cliente, aunque se haya verificado hace un segundo. Como el
// componente de la ruta hija no se monta hasta que ese beforeLoad resuelve,
// esto también retrasa el fetch de datos propio de cada vista.
//
// Este módulo cachea el resultado de esa verificación por un rato corto —
// suficiente para eliminar la re-verificación en navegaciones seguidas, sin
// esconder una sesión realmente vencida por mucho tiempo (JWT_EXPIRE_MINUTES
// es 480 = 8h, así que 5 minutos de cache es insignificante en comparación).
//
// Guard typeof window !== "undefined" en todas las funciones porque
// TanStack Start ejecuta SSR en Node.js donde sessionStorage no existe.
// =============================================================================

import type { CurrentUser } from "./auth";

const KEY_AUTH_CACHE = "condorfinder_auth_cache";
const TTL_MS = 5 * 60 * 1000;

/** Guarda la sesión ENTERA y no solo el identificador.
 *
 *  Guardaba solo `username`, así que la barra lateral mostraba el nombre de la
 *  persona en la primera carga (la que sí consulta /auth/me) y el correo
 *  completo en cada navegación posterior, cuando la respuesta salía de acá. Un
 *  cache que devuelve menos campos que la fuente que reemplaza no es un cache,
 *  es una segunda versión del dato. */
interface CachedAuth extends CurrentUser {
  verifiedAt: number;
}

const isBrowser = typeof window !== "undefined";

export function saveCachedAuth(user: CurrentUser): void {
  if (!isBrowser) return;
  const entry: CachedAuth = { ...user, verifiedAt: Date.now() };
  sessionStorage.setItem(KEY_AUTH_CACHE, JSON.stringify(entry));
}

export function loadCachedAuth(): CurrentUser | null {
  if (!isBrowser) return null;
  try {
    const raw = sessionStorage.getItem(KEY_AUTH_CACHE);
    if (!raw) return null;
    const entry: CachedAuth = JSON.parse(raw);
    // Una entrada guardada por la versión anterior no trae `username` en el
    // lugar esperado ni `name`; se descarta en vez de devolver media sesión.
    if (!entry?.username || Date.now() - entry.verifiedAt > TTL_MS) return null;
    return { username: entry.username, name: entry.name ?? null };
  } catch {
    return null;
  }
}

export function clearCachedAuth(): void {
  if (!isBrowser) return;
  sessionStorage.removeItem(KEY_AUTH_CACHE);
}
