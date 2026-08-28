import { Component, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import appCss from "../styles.css?url";
// Recorte del logo enfocado en el ave — el archivo original (Logo Dark
// Mode.svg) tiene mucho margen vacío alrededor del isotipo + wordmark, así
// que a tamaño de favicon (16-32px) se veía diminuto. Este archivo usa el
// mismo path data, solo con un viewBox más ajustado.
import favicon from "@/assets/Logo/favicon.svg";
import { Toaster } from "@/components/ui/sonner";
import { AppSidebar } from "@/components/AppSidebar";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

// Contiene cualquier error de render de AppSidebar (ej. la condición de
// carrera del context de "/_authed" durante un redirect en streaming SSR,
// ver comentario en RootComponent) sin tumbar el resto de la página — en
// el peor caso el sidebar no aparece por un instante, en vez de un 500.
class SidebarBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "CondorFinder" },
      { name: "description", content: "Lovable Generated Project" },
      { name: "author", content: "Lovable" },
      { property: "og:title", content: "Lovable App" },
      { property: "og:description", content: "Lovable Generated Project" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:site", content: "@Lovable" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      {
        rel: "icon",
        type: "image/svg+xml",
        href: favicon,
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  // AppSidebar necesita el contexto de "/_authed" (useRouteContext adentro
  // del componente) — se verifica acá con la MISMA fuente de datos
  // (s.matches) que usa ese hook internamente, en vez de comparar el
  // pathname contra "/login". Comparar por pathname puede desincronizarse
  // de los matches reales durante una redirección en curso (ej. entrar a
  // una ruta protegida sin sesión → _authed.tsx redirige a /login): por un
  // instante pathname todavía no refleja "/login" pero el match de
  // "/_authed" ya dejó de estar activo, y AppSidebar tira "Could not find
  // an active match from /_authed". Leyendo s.matches acá, este chequeo y
  // el de useRouteContext quedan sincronizados por construcción — no pueden
  // divergir porque leen el mismo snapshot de estado en el mismo render.
  //
  // Nota: no basta con que "/_authed" esté en s.matches para garantizar que
  // context.user ya esté poblado (cuando beforeLoad lanza el redirect a
  // /login, la ruta queda "matched" un instante antes de que el redirect
  // se procese) — pero leer match.context acá para filtrar ese estado
  // dispara un getter interno del router que puede lanzar su propia
  // excepción en pleno SSR por streaming en el runtime de Workers ("Cannot
  // read properties of null (reading 'context')"), así que no se puede
  // usar para decidir esto de forma segura. El SidebarBoundary de abajo
  // contiene ese caso (y cualquier otro similar) sin tumbar toda la
  // página.
  const hasAuthedMatch = useRouterState({
    select: (s) => s.matches.some((m) => m.routeId === "/_authed"),
  });

  return (
    <QueryClientProvider client={queryClient}>
      {/* Sidebar de navegación persistente — reemplaza el navbar superior de
          antes. Vive aquí (no por ruta) para no duplicarse en las 3 vistas. */}
      <div className="flex min-h-screen">
        {hasAuthedMatch && (
          <SidebarBoundary>
            <AppSidebar />
          </SidebarBoundary>
        )}
        {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
      </div>
      {/* richColors/closeButton eran props del toast nativo de sonner — ya no
          aplican, ahora cada notify.* renderiza su propia tarjeta (ver
          NotificationToast) vía toast.custom. --width fuerza un ancho único
          para todos los toasts (el div interno ahora es w-full). */}
      <Toaster position="bottom-right" style={{ "--width": "360px" } as React.CSSProperties} visibleToasts={1} />
    </QueryClientProvider>
  );
}
