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

import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Redirige el punto de entrada del servidor SSR de TanStack Start
    // hacia "src/server.ts", que actúa como wrapper de manejo de errores
    // en el lado del servidor (Server-Side Rendering).
    // Este archivo es usado por Nitro y Vite al compilar el build de producción.
    server: { entry: "server" },
  },
});