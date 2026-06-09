// =============================================================================
// CONDORFINDER — NAVBAR COMPARTIDO
// Archivo: src/components/AppNavbar.tsx
//
// Barra de navegación principal con logotipo, botones Carga/Análisis
// e indicador de ruta activa. Fondo azul petróleo oscuro (#0f1a24)
// con línea blanca inferior para separar del contenido.
// =============================================================================

import { Link, useRouterState } from "@tanstack/react-router";

export function AppNavbar() {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;

  const isIndex = pathname === "/";
  const isAnalysis = pathname === "/analysis";

  return (
    <header
      className="sticky top-0 z-30 border-b-2 border-white/[0.8] bg-[#0f1a24] text-white shadow-[0_16px_48px_-20px_rgba(0,0,0,0.9)] w-full"
      style={{ paddingRight: "var(--scrollbar-compensation, 0px)" }}
    >
      <div className="mx-auto flex h-20 max-w-[1400px] items-center justify-between px-6">

        {/* Logotipo */}
        <Link
          to="/"
          className="group relative text-3xl font-shrikhand tracking-tight text-white md:text-4xl transition-all duration-300 hover:scale-[1.02]"
        >
          <span className="relative z-10 transition-all duration-500 group-hover:text-transparent group-hover:bg-gradient-to-r group-hover:from-[#22d3ee] group-hover:via-white group-hover:to-[#22d3ee] group-hover:bg-clip-text">
            CondorFinder
          </span>
          <span className="absolute -bottom-1 left-0 h-[2px] w-0 rounded-full bg-gradient-to-r from-[#22d3ee]/60 via-[#22d3ee] to-[#22d3ee]/60 transition-all duration-500 group-hover:w-full" />
        </Link>

        {/* Navegación */}
        <nav className="ml-auto hidden items-center gap-1 md:flex">
          <NavLink to="/" active={isIndex} label="Carga" />
          <NavLink to="/analysis" active={isAnalysis} label="Análisis" />
        </nav>
      </div>
    </header>
  );
}

// =============================================================================
// NavLink — Botón de navegación con indicador de ruta activa
// =============================================================================

interface NavLinkProps {
  to: string;
  active: boolean;
  label: string;
}

function NavLink({ to, active, label }: NavLinkProps) {
  return (
    <Link
      to={to}
      className={`
        group relative flex items-center justify-center
        w-[88px] px-3 py-2.5
        text-sm font-medium
        transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]
        ${active ? "text-[#22d3ee]" : "text-white/60 hover:text-white"}
      `}
    >
      <span className="relative z-10 transition-colors duration-300">
        {label}
      </span>

      {/* Indicador de ruta activa */}
      <span
        className={`
          absolute bottom-0 left-1/2 h-[2px] -translate-x-1/2 rounded-full
          bg-gradient-to-r from-transparent via-[#22d3ee] to-transparent
          transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]
          ${active
            ? "w-[70%] scale-x-100 opacity-100 shadow-[0_0_8px_rgba(34,211,238,0.5),0_0_16px_rgba(34,211,238,0.25)]"
            : "w-[70%] scale-x-0 opacity-0 group-hover:scale-x-60 group-hover:opacity-30"
          }
        `}
      />
    </Link>
  );
}