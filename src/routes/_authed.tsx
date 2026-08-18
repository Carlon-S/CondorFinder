// =============================================================================
// CONDORFINDER — GUARD DE AUTENTICACIÓN
// Archivo: src/routes/_authed.tsx
//
// Ruta de layout sin segmento de URL (prefijo "_", ver src/routes/README.md)
// — envuelve todas las rutas protegidas sin agregarles path. beforeLoad
// corre en el servidor durante el render inicial (SSR) y en el cliente en
// navegaciones posteriores; si no hay usuario, redirige a /login ANTES de
// renderizar nada, así que no hay flash de contenido protegido.
// =============================================================================

import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getCurrentUserServerFn } from "@/lib/auth";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ location }) => {
    const user = await getCurrentUserServerFn();
    if (!user) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
    return { user };
  },
  component: () => <Outlet />,
});
