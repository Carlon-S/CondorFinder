import { useState } from "react";
import { Link, useRouteContext, useRouterState } from "@tanstack/react-router";
import {
  PanelLeftClose,
  PanelLeftOpen,
  LayoutDashboard,
  UploadCloud,
  Truck,
  Route,
  CircleUserRound,
  LogOut,
} from "@/components/icons/Icons";
// Dark Mode (wordmark blanco/gris) porque el sidebar ahora es navy — ver
// styles.css, --sidebar. login.tsx usa Light Mode (navy) porque su tarjeta
// sigue siendo blanca.
import logo from "@/assets/Logo/logo-dark-mode.svg";
import { logout } from "@/lib/auth";

// /analysis NO está acá a propósito. La vista de análisis siempre habla de una
// zona concreta, y a esa zona se llega eligiéndola: desde Vista Principal o
// desde la carga recién terminada. Entrar por el menú abría lo último que
// quedó en sessionStorage, o nada, sin decir de qué terreno se trataba, así
// que era una entrada que no se podía usar sin haber pasado antes por otra.
// El menú tiene dos niveles. Planificación NO es una pantalla: es el grupo del
// que cuelgan las dos que sí lo son.
//
// Recursos y Rutas estuvieron fusionadas en una sola vista y se revirtió: son
// dos tareas con ritmos distintos. Administrar puntos y flota es CONFIGURACIÓN
// (se hace una vez, es precisa, vive en formularios y tablas); generar una ruta
// es OPERACIÓN (se hace a diario, es exploratoria, vive en el mapa). En una
// pantalla, la configuración se quedaba permanentemente con un tercio del
// espacio de la operación. El grupo conserva la relación entre ambas sin
// obligarlas a compartir pantalla.
const NAV_ITEMS = [
  { to: "/", label: "Zonas Monitoreadas", icon: LayoutDashboard },
  { to: "/carga", label: "Carga De Imágenes", icon: UploadCloud },
  {
    label: "Planificación",
    icon: Route,
    hijos: [
      { to: "/planificacion/recursos", label: "Recursos", icon: Truck },
      { to: "/planificacion/rutas", label: "Rutas", icon: Route },
    ],
  },
] as const;

export function AppSidebar() {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  // Estado vive en este componente, montado una sola vez en __root.tsx —
  // persiste solo durante la sesión de navegación (se resetea en un F5),
  // no hace falta localStorage para esto.
  const [collapsed, setCollapsed] = useState(false);

  // El usuario ya lo resolvió el beforeLoad de _authed.tsx (evita otro
  // fetch aquí) — AppSidebar normalmente solo se monta en rutas donde ese
  // guard ya pasó, así que este contexto está disponible. Pero en el
  // streaming SSR del runtime de Workers hay una ventana transitoria (ver
  // __root.tsx) donde esto puede montarse un instante antes de que el
  // contexto quede poblado — el guard de abajo corta ahí sin renderizar
  // nada roto, en vez de que la app entera caiga con un 500.
  const { user } = useRouteContext({ from: "/_authed" });
  if (!user) return null;

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
      {/* Alto fijo (h-16) independiente de si el logo se muestra o no, para
          que el botón de toggle quede siempre a la misma altura entre el
          estado expandido y el colapsado. Logo centrado de verdad (no
          justify-between con el toggle al lado): el toggle queda con
          position absolute para no descentrar el logo respecto al ancho
          real del sidebar. */}
      <div className="relative flex h-16 items-center justify-center px-4">
        {/* El logo queda siempre montado — se anima por max-width/opacity en
            vez de aparecer/desaparecer de golpe con el toggle. Tamaño chico
            (h-8): el SVG ya viene recortado sin margen invisible, así que a
            diferencia del h-20 anterior esto es 100% dibujo visible, no
            dibujo+relleno vacío. */}
        <Link
          to="/"
          className={`overflow-hidden transition-[max-width,opacity] duration-300 ease-in-out hover:scale-[1.02] ${
            collapsed ? "max-w-0 opacity-0" : "max-w-[10rem] opacity-100"
          }`}
        >
          <img src={logo} alt="CondorFinder" className="h-11 w-auto" />
        </Link>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expandir menú" : "Colapsar menú"}
          className="absolute right-3 flex h-8 w-8 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors duration-200 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>
      </div>

      <nav className="mt-2 flex flex-col gap-1 px-3">
        {NAV_ITEMS.map((item) => {
          // Un grupo: rótulo no clickeable más sus hijos indentados. Colapsado
          // el menú, el rótulo desaparece y los hijos quedan como íconos
          // sueltos, que es lo único que cabe en 5rem de ancho.
          if ("hijos" in item) {
            return (
              <div key={item.label} className="mt-2 flex flex-col gap-1">
                <span
                  className={`px-3 text-[0.625rem] font-semibold uppercase tracking-wide text-sidebar-foreground/40 transition-[max-height,opacity] duration-300 ${
                    collapsed ? "max-h-0 overflow-hidden opacity-0" : "max-h-4 opacity-100"
                  }`}
                >
                  {item.label}
                </span>
                {item.hijos.map((hijo) => (
                  <ItemNav
                    key={hijo.to}
                    to={hijo.to}
                    label={hijo.label}
                    Icon={hijo.icon}
                    activo={pathname.startsWith(hijo.to)}
                    collapsed={collapsed}
                  />
                ))}
              </div>
            );
          }
          return (
            <ItemNav
              key={item.to}
              to={item.to}
              label={item.label}
              Icon={item.icon}
              activo={item.to === "/" ? pathname === "/" : pathname.startsWith(item.to)}
              collapsed={collapsed}
            />
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
              collapsed ? "max-w-0 opacity-0" : "max-w-[10rem] opacity-100"
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
              collapsed ? "max-w-0 opacity-0" : "max-w-[10rem] opacity-100"
            }`}
          >
            Cerrar sesión
          </span>
        </button>
      </div>
    </aside>
  );
}

/** Una entrada del menú. Compartida entre las de primer nivel y las que cuelgan
 *  de un grupo, para que no deriven en dos aspectos distintos. */
function ItemNav({
  to,
  label,
  Icon,
  activo,
  collapsed,
}: {
  to: string;
  label: string;
  Icon: (props: { className?: string }) => React.ReactElement;
  activo: boolean;
  collapsed: boolean;
}) {
  return (
    <Link
      to={to}
      title={collapsed ? label : undefined}
      className={`flex items-center rounded-md py-2.5 text-sm font-medium transition-colors duration-200 ${
        collapsed ? "justify-center gap-0 px-0" : "justify-start gap-3 px-3"
      } ${
        activo
          ? "bg-sidebar-primary text-sidebar-primary-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
      }`}
    >
      <Icon className="h-4 w-4 flex-shrink-0" />
      {/* Misma idea que el logo: siempre montado, se angosta y desvanece en vez
          de desaparecer de golpe. */}
      <span
        className={`overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-300 ease-in-out ${
          collapsed ? "max-w-0 opacity-0" : "max-w-[10rem] opacity-100"
        }`}
      >
        {label}
      </span>
    </Link>
  );
}
