// Única fuente de BACKEND_URL para todo src/lib — antes cada archivo
// redefinía su propio "http://localhost:8000", así que apuntar el
// frontend a un backend desplegado (VM en la nube) significaba editar 6
// archivos. VITE_BACKEND_URL se define en un .env en la raíz del repo (no
// es secreto, es solo la IP pública del backend); sin ese archivo, sigue
// apuntando a localhost:8000 para desarrollo 100% local.
//
// BACKEND_URL (absoluta) — solo para fetches SERVIDOR-A-SERVIDOR (ver
// auth.ts::getCurrentUser, en su rama de servidor) — esos fetches salen
// directo hacia afuera, no pasan por el proxy del dev server de Vite.
export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8000";

// CLIENT_BACKEND_URL — para TODO fetch que corre en el NAVEGADOR.
//
// En desarrollo local, vacía a propósito (relativa): el dev server de Vite
// (vite.config.ts) hace de proxy reverso de estas rutas hacia BACKEND_URL,
// así el navegador ve todo como same-origin (localhost:8080) en vez de
// cross-origin hacia la IP/dominio del backend. Esto es lo que hace que la
// cookie httpOnly de sesión funcione en local (ver el bug real que esto
// resolvió — login parecía funcionar pero la sesión nunca quedaba activa).
//
// En producción (el frontend desplegado en Cloudflare Workers) no existe
// ese proxy — es exclusivo del dev server de Vite — así que ahí SÍ
// necesita ser la URL absoluta real del backend (VITE_CLIENT_BACKEND_URL,
// seteada como build variable en Cloudflare). Eso hace estos fetches
// genuinamente cross-origin; el backend necesita permitir ese origen en
// CORS y la cookie de sesión necesita secure=True + samesite="none" para
// que el navegador la reenvíe (ver auth.py — condicional por env var, no
// rompe el desarrollo local que sigue same-origin vía el proxy).
export const CLIENT_BACKEND_URL = import.meta.env.VITE_CLIENT_BACKEND_URL ?? "";
