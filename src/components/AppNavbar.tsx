import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Check, Palette } from "lucide-react";

// ── Definición de temas ────────────────────────────────────────────────────────

const THEMES = [
  { id: "verde", label: "Verde tierra",  accent: "#d4a843", bg: "#0b0d0a" },
  { id: "negro", label: "Negro clásico", accent: "#22d3ee", bg: "#151414" },
  { id: "azul",  label: "Azul oscuro",   accent: "#60a5fa", bg: "#090d1a" },
  { id: "claro", label: "Modo claro",    accent: "#b8873a", bg: "#f7f4ee" },
] as const;

type ThemeId = (typeof THEMES)[number]["id"];

function applyTheme(id: ThemeId) {
  document.documentElement.setAttribute("data-theme", id);
  try { localStorage.setItem("cf-theme", id); } catch { /* noop */ }
}

function getActiveTheme(): ThemeId {
  if (typeof document === "undefined") return "verde";
  return (document.documentElement.getAttribute("data-theme") as ThemeId) ?? "verde";
}

// ── Navbar ─────────────────────────────────────────────────────────────────────

export function AppNavbar() {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;

  const isIndex    = pathname === "/";
  const isAnalysis = pathname === "/analysis";

  return (
    <header
      className="sticky top-0 z-30 w-full border-b shadow-[0_8px_32px_-8px_rgba(0,0,0,0.7)]"
      style={{
        background: "var(--navbar)",
        borderBottomColor: "var(--border)",
        color: "var(--foreground)",
        paddingRight: "var(--scrollbar-compensation, 0px)",
      }}
    >
      <div className="mx-auto flex h-[68px] max-w-[1400px] items-center justify-between px-6">

        {/* Logotipo */}
        <Link
          to="/"
          className="group relative shrink-0 text-3xl font-shrikhand tracking-tight transition-all duration-300 hover:scale-[1.02] md:text-4xl"
          style={{ color: "var(--foreground)" }}
        >
          CondorFinder
          <span
            className="absolute -bottom-1 left-0 h-[2px] w-0 rounded-full transition-all duration-500 group-hover:w-full"
            style={{ background: "linear-gradient(to right, transparent, var(--primary), transparent)" }}
          />
        </Link>

        {/* Navegación + selector de tema */}
        <div className="ml-auto hidden items-center gap-1 md:flex">
          <nav className="flex items-center gap-1">
            <NavLink to="/"         active={isIndex}    label="Carga" />
            <NavLink to="/analysis" active={isAnalysis} label="Análisis" />
          </nav>

          {/* Separador */}
          <span className="mx-2 h-5 w-px opacity-30" style={{ background: "var(--foreground)" }} />

          <ThemeSwitcher />
        </div>
      </div>
    </header>
  );
}

// ── NavLink ────────────────────────────────────────────────────────────────────

function NavLink({ to, active, label }: { to: string; active: boolean; label: string }) {
  return (
    <Link
      to={to}
      className="group relative flex w-[88px] items-center justify-center px-3 py-2.5 text-sm font-medium transition-all duration-300"
      style={{ color: active ? "var(--primary)" : "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
    >
      <span className="relative z-10">{label}</span>

      {/* Indicador activo */}
      <span
        className={`absolute bottom-0 left-1/2 h-[2px] -translate-x-1/2 rounded-full transition-all duration-500 ${
          active
            ? "w-[70%] opacity-100"
            : "w-[70%] scale-x-0 opacity-0 group-hover:scale-x-50 group-hover:opacity-25"
        }`}
        style={{
          background: "linear-gradient(to right, transparent, var(--primary), transparent)",
          boxShadow: active
            ? "0 0 8px var(--primary-glow), 0 0 16px var(--primary-glow-2)"
            : undefined,
        }}
      />
    </Link>
  );
}

// ── ThemeSwitcher ──────────────────────────────────────────────────────────────

function ThemeSwitcher() {
  const [current, setCurrent] = useState<ThemeId>(() => getActiveTheme());
  const [open, setOpen]       = useState(false);
  const wrapRef               = useRef<HTMLDivElement>(null);

  // Cerrar al hacer click fuera
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  function select(id: ThemeId) {
    applyTheme(id);
    setCurrent(id);
    setOpen(false);
  }

  const active = THEMES.find((t) => t.id === current) ?? THEMES[1];

  return (
    <div ref={wrapRef} className="relative">
      {/* Botón disparador */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md px-2.5 py-2 text-xs font-medium transition-all duration-200 select-none"
        style={{
          color:      open ? "var(--primary)" : "color-mix(in srgb, var(--foreground) 60%, transparent)",
          background: open ? "color-mix(in srgb, var(--primary) 10%, transparent)" : "transparent",
        }}
        onMouseEnter={(e) => {
          if (!open) (e.currentTarget as HTMLElement).style.color = "var(--foreground)";
        }}
        onMouseLeave={(e) => {
          if (!open) (e.currentTarget as HTMLElement).style.color =
            "color-mix(in srgb, var(--foreground) 60%, transparent)";
        }}
      >
        {/* Muestra del color activo */}
        <span
          className="h-3 w-3 flex-shrink-0 rounded-full ring-1 ring-white/20"
          style={{ background: active.accent }}
        />
        <Palette className="h-3.5 w-3.5" />
        <span>{active.label}</span>
        <svg
          className={`h-3 w-3 flex-shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className="dropdown-enter absolute right-0 top-full z-50 mt-1.5 w-48 overflow-hidden rounded-lg border py-1 shadow-2xl"
          style={{
            background:   "var(--card)",
            borderColor:  "var(--border)",
            boxShadow:    "0 16px 48px -8px rgba(0,0,0,0.5), 0 4px 16px -4px rgba(0,0,0,0.3)",
          }}
        >
          {THEMES.map((t) => {
            const isSelected = t.id === current;
            return (
              <button
                key={t.id}
                onClick={() => select(t.id)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-xs transition-colors duration-100"
                style={{
                  color:      isSelected ? "var(--primary)" : "var(--foreground)",
                  background: isSelected ? "color-mix(in srgb, var(--primary) 8%, transparent)" : "transparent",
                }}
                onMouseEnter={(e) => {
                  if (!isSelected)
                    (e.currentTarget as HTMLElement).style.background =
                      "color-mix(in srgb, var(--foreground) 5%, transparent)";
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              >
                {/* Miniatura del tema */}
                <span
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded"
                  style={{ background: t.bg, outline: `1.5px solid ${t.accent}50` }}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.accent }} />
                </span>

                <span className="flex-1 text-left font-medium">{t.label}</span>

                {isSelected && (
                  <Check className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "var(--primary)" }} />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
