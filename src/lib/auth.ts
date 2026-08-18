// =============================================================================
// CONDORFINDER — AUTENTICACIÓN (frontend)
// Archivo: src/lib/auth.ts
//
// Mismo patrón que unify.ts/analysisStore.ts: un módulo chico por
// responsabilidad. login/logout son fetches directos del cliente (mismo
// estilo que uploadImages en unify.ts). getCurrentUserServerFn es distinto:
// tiene que ser una server function porque necesita leer la cookie de
// sesión del REQUEST ENTRANTE durante SSR (getCookie solo tiene contexto de
// request dentro de un handler de servidor, no en un fetch de cliente
// plano) — y como el backend de auth vive en otro origen (FastAPI en
// localhost:8000), esa cookie hay que reenviarla a mano en el fetch
// server-a-server, porque ese fetch no hereda las cookies del browser solo.
// =============================================================================

import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";

import { BACKEND_URL } from "./config";

export interface CurrentUser {
  username: string;
}

export async function login(username: string, password: string): Promise<CurrentUser> {
  const res = await fetch(`${BACKEND_URL}/auth/login`, {
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
  await fetch(`${BACKEND_URL}/auth/logout`, {
    method: "POST",
    credentials: "include",
  }).catch(() => {});
}

/**
 * Server function: corre en el servidor durante SSR (con acceso al request
 * entrante) y también se puede invocar desde el cliente (hace un RPC al
 * servidor). Usada por el guard de _authed.tsx.
 */
export const getCurrentUserServerFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<CurrentUser | null> => {
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
  },
);
