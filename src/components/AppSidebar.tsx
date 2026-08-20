import { useState } from "react";
import { Link, useRouteContext, useRouterState } from "@tanstack/react-router";
import {
  PanelLeftClose,
  PanelLeftOpen,
  LayoutDashboard,
  UploadCloud,
  BarChart3,
  Truck,
  Route,
  CircleUserRound,
  LogOut,
} from "@/components/icons/Icons";
import logo from "@/assets/Logo/Logo Light Mode.svg";
import { logout } from "@/lib/auth";

const NAV_ITEMS = [
  { to: "/", label: "Zonas monitoreadas", icon: LayoutDashboard },
  { to: "/carga", label: "Carga de imágenes", icon: UploadCloud },
  { to: "/analysis", label: "Análisis", icon: BarChart3 },
  { to: "/recursos", label: "Recursos disponibles", icon: Truck },
  { to: "/rutas", label: "Generar ruta", icon: Route },
] as const;

export function AppSidebar() {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  // Estado vive en este componente, montado una sola vez en __root.tsx —
  // persiste solo durante la sesión de navegación (se resetea en un F5),
  // no hace falta localStorage para esto.
  const [collapsed, setCollapsed] = useState(false);

  // El usuario ya lo resolvió el beforeLoad de _authed.tsx (evita otro
  // fetch aquí) — AppSidebar solo se monta en rutas donde ese guard ya pasó,
  // así que este contexto siempre está disponible cuando esto renderiza.
  const { user } = useRouteContext({ from: "/_authed" });

  const handleLogout = async () => {
    await logout();
    // Navegación dura: fuerza un SSR nuevo que ya no encuentra la cookie,
    // mismo patrón que usa login.tsx al entrar.
    window.location.href = "/login";
  };

  return (
    <aside
      className={`sticky top-0 flex h-screen flex-shrink-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground transition-[width] duration-300 ease-in-out ${
        collapsed ? "w-20" : "w-64"
      }`}
    >
      {/* Alto fijo (h-24) independiente de si el logo se muestra o no, para
          que el botón de toggle quede siempre a la misma altura entre el
          estado expandido y el colapsado. */}
      {/* gap-0 en colapsado: el logo queda montado con ancho 0, pero un
          gap sigue reservando espacio junto a un hijo de ancho 0 — eso
          descentraba el botón de toggle respecto a los íconos de abajo. */}
      <div
        className={`flex h-24 items-center px-4 ${collapsed ? "justify-center gap-0" : "justify-between gap-2"}`}
      >
        {/* El logo queda siempre montado — se anima por max-width/opacity en
            vez de aparecer/desaparecer de golpe con el toggle. */}
        <Link
          to="/"
          className={`overflow-hidden transition-[max-width,opacity] duration-300 ease-in-out hover:scale-[1.02] ${
            collapsed ? "max-w-0 opacity-0" : "max-w-[190px] opacity-100"
          }`}
        >
          <img src={logo} alt="CondorFinder" className="h-20 w-auto" />
        </Link>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expandir menú" : "Colapsar menú"}
          className="flex h-8 w-8 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors duration-200 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      <nav className="mt-2 flex flex-col gap-1 px-3">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
          const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
          return (
            <Link
              key={to}
              to={to}
              title={collapsed ? label : undefined}
              className={`flex items-center rounded-md py-2.5 text-sm font-medium transition-colors duration-200 ${
                collapsed ? "justify-center gap-0 px-0" : "justify-start gap-3 px-3"
              } ${
                active
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              }`}
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              {/* Misma idea que el logo: siempre montado, se angosta y
                  desvanece en vez de desaparecer de golpe. */}
              <span
                className={`overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-300 ease-in-out ${
                  collapsed ? "max-w-0 opacity-0" : "max-w-[160px] opacity-100"
                }`}
              >
                {label}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* Perfil + logout — empujado al fondo del sidebar por mt-auto (nav no
          tiene flex-1, así que este es el único elemento que "sobra" y
          absorbe el espacio restante). */}
      <div className="mt-auto border-t border-sidebar-border/40 px-3 py-3">
        <div
          className={`flex items-center rounded-md py-2 ${
            collapsed ? "justify-center gap-0 px-0" : "justify-start gap-3 px-3"
          }`}
        >
          {/* Mismo tamaño/caja que los íconos de NAV_ITEMS (h-4 w-4, sin
              badge circular) para que quede alineado en la misma columna —
              la versión con círculo de fondo se veía corrida respecto a
              los demás íconos del sidebar. Ícono de usuario por defecto: no
              hay fotos de perfil todavía, es un placeholder momentáneo. */}
          <CircleUserRound className="h-4 w-4 flex-shrink-0 text-sidebar-foreground/70" />
          <span
            title={collapsed ? user.username : undefined}
            className={`overflow-hidden truncate whitespace-nowrap text-sm font-medium transition-[max-width,opacity] duration-300 ease-in-out ${
              collapsed ? "max-w-0 opacity-0" : "max-w-[160px] opacity-100"
            }`}
          >
            {user.username}
          </span>
        </div>

        <button
          type="button"
          onClick={handleLogout}
          title={collapsed ? "Cerrar sesión" : undefined}
          className={`mt-1 flex w-full cursor-pointer items-center rounded-md py-2.5 text-sm font-medium text-sidebar-foreground/70 transition-colors duration-200 hover:bg-sidebar-accent hover:text-sidebar-foreground ${
            collapsed ? "justify-center gap-0 px-0" : "justify-start gap-3 px-3"
          }`}
        >
          <LogOut className="h-4 w-4 flex-shrink-0" />
          <span
            className={`overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-300 ease-in-out ${
              collapsed ? "max-w-0 opacity-0" : "max-w-[160px] opacity-100"
            }`}
          >
            Cerrar sesión
          </span>
        </button>
      </div>
    </aside>
  );
}
