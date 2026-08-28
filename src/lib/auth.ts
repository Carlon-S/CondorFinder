// =============================================================================
// CONDORFINDER — AUTENTICACIÓN (frontend)
// Archivo: src/lib/auth.ts
//
// Mismo patrón que unify.ts/analysisStore.ts: un módulo chico por
// responsabilidad. login/logout son fetches directos del cliente (mismo
// estilo que uploadImages en unify.ts) — usan CLIENT_BACKEND_URL (relativa,
// proxyeada por vite.config.ts) para que la cookie de sesión quede scoped a
// localhost:8080, no a la IP real del backend (si no, el navegador nunca la
// reenvía en fetches cross-origin — ver el bug real que esto resolvió).
// getCurrentUser es distinto: en el servidor necesita leer la cookie del
// REQUEST ENTRANTE durante SSR (getCookie solo tiene contexto de request
// ahí) y hace el fetch directo a BACKEND_URL absoluta (nunca pasa por el
// proxy de Vite, que solo intercepta pedidos del navegador); en el cliente
// es un fetch normal con CLIENT_BACKEND_URL relativa, dejando que el
// navegador adjunte la cookie httpOnly solo.
//
// Nota: esto NO usa createServerFn (a pesar de ser el patrón documentado
// de TanStack Start para justo este caso). En el runtime de Workers, una
// server function invocada desde beforeLoad se despacha por la ruta
// interna "client" del framework en vez de "server" — un bug de
// compatibilidad confirmado leyendo el código fuente de
// @tanstack/start-client-core (createServerFn.js), no arreglado ni con
// las últimas versiones del framework al momento de escribir esto. En vez
// de eso, createIsomorphicFn separa las dos implementaciones en tiempo de
// build (sin RPC ni middleware de por medio) — el plugin de import
// protection de TanStack Start exige este patrón específico para permitir
// el import server-only de abajo.
// =============================================================================

import { createIsomorphicFn } from "@tanstack/react-start";

import { BACKEND_URL, CLIENT_BACKEND_URL } from "./config";

export interface CurrentUser {
  username: string;
}

// login/logout corren en el navegador — usan CLIENT_BACKEND_URL (relativa,
// proxyeada por vite.config.ts) para que la cookie de sesión quede scoped a
// localhost, no a la IP de la VM (ver docstring de config.ts). Distinto de
// getCurrentUser más abajo, que sí necesita BACKEND_URL absoluta del lado
// servidor.
export async function login(username: string, password: string): Promise<CurrentUser> {
  const res = await fetch(`${CLIENT_BACKEND_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    let message = "Usuario o contraseña incorrectos";
    try {
      const parsed = await res.json();
      if (parsed?.detail) message = parsed.detail;
    } catch {
      // respuesta no era JSON — se usa el mensaje genérico
    }
    throw new Error(message);
  }

  return res.json();
}

export async function logout(): Promise<void> {
  await fetch(`${CLIENT_BACKEND_URL}/auth/logout`, {
    method: "POST",
    credentials: "include",
  }).catch(() => {});
}

/**
 * Usada por el guard de _authed.tsx, tanto en el servidor (SSR inicial)
 * como en el cliente (navegaciones posteriores) — ver nota de arriba sobre
 * por qué esto es un createIsomorphicFn en vez de una createServerFn.
 */
export const getCurrentUser = createIsomorphicFn()
  .server(async (): Promise<CurrentUser | null> => {
    const { getCookie } = await import("@tanstack/react-start/server");
    const token = getCookie("access_token");
    if (!token) return null;

    try {
      const res = await fetch(`${BACKEND_URL}/auth/me`, {
        headers: { cookie: `access_token=${token}` },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  })
  .client(async (): Promise<CurrentUser | null> => {
    try {
      const res = await fetch(`${CLIENT_BACKEND_URL}/auth/me`, { credentials: "include" });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  });
