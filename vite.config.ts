// =============================================================================
// CONDORFINDER — CONFIGURACIÓN DE VITE
// Este archivo configura el bundler y servidor de desarrollo del proyecto.
// Utiliza el preset "@lovable.dev/vite-tanstack-config" que ya incluye
// de forma interna todos los plugins necesarios para el stack del proyecto.
// =============================================================================

// IMPORTANTE: El preset @lovable.dev/vite-tanstack-config ya incluye los
// siguientes plugins de forma automática. NO deben agregarse manualmente
// porque causarán errores por duplicación:
//
//   - tanstackStart     → integración de TanStack Start (SSR + routing)
//   - viteReact         → soporte para JSX/TSX de React
//   - tailwindcss       → procesamiento de clases de Tailwind CSS v4
//   - tsConfigPaths     → resolución de alias de rutas (ej: @/components)
//   - nitro             → servidor de producción (solo en build, usa Cloudflare por defecto)
//   - componentTagger   → etiquetado de componentes en desarrollo (solo en dev)
//   - VITE_* env        → inyección automática de variables de entorno
//   - @ path alias      → alias "@" apuntando a "src/"
//   - React/TanStack dedupe → evita instancias duplicadas de React
//   - error logger      → reporte de errores en consola y UI
//   - sandbox detection → configuración automática de puerto/host/strictPort

import { loadEnv } from "vite";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { cloudflare } from "@cloudflare/vite-plugin";

// Backend real (VM en la nube, o localhost:8000 en desarrollo 100% local).
// loadEnv() en vez de import.meta.env porque este archivo corre en Node al
// arrancar Vite, antes de que exista el import.meta.env inyectado en la app.
const BACKEND_URL = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "").VITE_BACKEND_URL
  ?? "http://localhost:8000";

// Prefijos de ruta que sirve el backend (ver backendModel/orquestador.py y
// sus routers) — el dev server de Vite los reenvía a BACKEND_URL para que
// el navegador vea todo como same-origin (localhost:8080). Esto es lo que
// hace que la cookie httpOnly de sesión funcione: seteada por un backend en
// otro host (la IP de la VM), el navegador nunca la manda de vuelta en
// fetches cross-origin — proxyeada así, para el navegador el login queda
// scoped a localhost, igual que cuando el backend corría también ahí.
const BACKEND_ROUTE_PREFIXES = [
  "/auth",
  "/upload",
  "/generate",
  "/cancel",
  "/pipeline-status",
  "/status",
  "/tasks",
  "/analyze",
  "/result",
  "/finals",
  "/task-images",
  "/resources",
  "/routes",
  "/analyses",
];

export default defineConfig({
  // Plugin oficial de Cloudflare para desplegar TanStack Start como Worker
  // (distinto del preset "nitro" del propio wrapper — ese solo se activa
  // dentro del sandbox de Lovable, nunca en un build normal como el de
  // Cloudflare Pages). Requerido por `wrangler deploy` (ver wrangler.jsonc).
  // apply: "build" — en modo dev choca con el propio plugin de TanStack
  // Start (intenta reempaquetar módulos virtuales que solo existen en
  // build), y esta app no usa bindings nativos de Cloudflare que necesiten
  // el runtime de Workers durante `pnpm dev`.
  plugins: [cloudflare()].flat().map((plugin) => ({ ...plugin, apply: "build" as const })),
  tanstackStart: {
    // Redirige el punto de entrada del servidor SSR de TanStack Start
    // hacia "src/server.ts", que actúa como wrapper de manejo de errores
    // en el lado del servidor (Server-Side Rendering).
    // Este archivo es usado por Nitro y Vite al compilar el build de producción.
    server: { entry: "server" },
  },
  vite: {
    server: {
      proxy: Object.fromEntries(
        BACKEND_ROUTE_PREFIXES.map((prefix) => [
          prefix,
          { target: BACKEND_URL, changeOrigin: true },
        ]),
      ),
    },
  },
});