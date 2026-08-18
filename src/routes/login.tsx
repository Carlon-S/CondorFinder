// =============================================================================
// CONDORFINDER — LOGIN
// Archivo: src/routes/login.tsx
//
// Ruta de nivel superior (NO vive bajo _authed) — es la única página
// accesible sin sesión. El resto de la app pasa por el guard de
// _authed.tsx, que redirige aquí con ?redirect=<ruta original> cuando no hay
// usuario.
//
// Estructura tomada de una referencia visual (tarjeta centrada, logo
// arriba, toggle mostrar/ocultar contraseña) pero con los componentes
// Input/Button y la paleta ya establecidos en el resto de CondorFinder, no
// el estilo de la referencia en sí. Sin "¿Olvidaste tu contraseña?" ni
// "Crear cuenta": no hay reset de contraseña ni registro público en este
// sistema (herramienta interna, cuentas las crea un admin) — agregar esos
// links sin funcionalidad real detrás sería peor que omitirlos.
//
// Formulario con estado controlado simple (useState), mismo patrón que ya
// usa el resto de la app para formularios chicos (ej. el modal de guardar
// análisis en analysis.tsx) — react-hook-form está como dependencia del
// scaffold pero no se usa en ningún lado real todavía, así que no vale la
// pena introducirlo aquí para dos campos.
// =============================================================================

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff, Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { login } from "@/lib/auth";
import logo from "@/assets/Logo/Logo Light Mode.svg";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  component: LoginPage,
});

function LoginPage() {
  const { redirect } = Route.useSearch();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // -webkit-text-security no existe durante SSR (no hay CSS.supports en
  // Node) — arranca en false en server y primer render de cliente (mismos,
  // sin mismatch de hidratación) y recién después del mount se activa si el
  // navegador lo soporta. Sin soporte (Firefox), se queda en type=password
  // nativo sin animación — nunca en texto plano sin máscara.
  const [supportsMaskedReveal, setSupportsMaskedReveal] = useState(false);
  useEffect(() => {
    setSupportsMaskedReveal(
      typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("-webkit-text-security", "disc"),
    );
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(username, password);
      // Navegación dura: redirect viene de sessionStorage/URL como string
      // plano, no como una ruta tipada del árbol de rutas — más simple y
      // confiable que forzar el tipo, y de paso re-dispara el SSR con la
      // sesión ya activa.
      window.location.href = redirect || "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar sesión.");
      setLoading(false);
    }
  };

  // Mismo bg de foco en los dos campos — se define una vez para no repetir
  // la clase. "Más oscuro al escribir": el input parte transparente sobre
  // la tarjeta blanca y se tiñe apenas se enfoca, no solo con el anillo.
  const fieldClassName = "h-11 bg-transparent transition-colors focus:bg-muted/50 focus-visible:bg-muted/50";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-10 shadow-xl">
        <img
          src={logo}
          alt="CondorFinder"
          className="mx-auto h-24 w-auto animate-in fade-in zoom-in-95 duration-500 fill-mode-both"
        />
        <h1 className="mt-6 animate-in fade-in slide-in-from-top-2 duration-500 delay-100 fill-mode-both text-center font-rubik text-3xl font-semibold text-foreground">
          Iniciar sesión
        </h1>

        <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
          <div className="animate-in fade-in slide-in-from-top-2 duration-500 delay-200 fill-mode-both space-y-1.5">
            <label htmlFor="username" className="text-xs font-medium text-muted-foreground">
              Usuario
            </label>
            <Input
              id="username"
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={loading}
              className={fieldClassName}
            />
          </div>

          <div className="animate-in fade-in slide-in-from-top-2 duration-500 delay-300 fill-mode-both space-y-1.5">
            <label htmlFor="password" className="text-xs font-medium text-muted-foreground">
              Contraseña
            </label>
            <div className="relative">
              {/* Con soporte de -webkit-text-security: type="text" fijo, la
                  máscara la aplica el navegador sobre el texto real (clase
                  .password-mask en styles.css) — ancho proporcional exacto
                  y la selección nativa resalta los puntos, nunca el texto.
                  Sin soporte (Firefox): type=password/text nativo, sin
                  animación pero 100% seguro — nunca texto plano sin
                  máscara. */}
              <Input
                id="password"
                type={supportsMaskedReveal ? "text" : showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                className={`${fieldClassName} pr-10 transition-[color] duration-200 ${
                  supportsMaskedReveal && !showPassword ? "password-mask" : ""
                }`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                disabled={loading}
                aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                className="absolute right-0 top-0 flex h-11 w-10 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed"
              >
                {/* Los dos íconos quedan montados siempre, superpuestos, y se
                    transicionan opacidad+escala — a diferencia de un remount
                    por key, esto anima tanto la entrada como la salida
                    (un ícono que se monta de nuevo no puede animar su
                    propia desaparición). */}
                <Eye
                  className={`absolute h-4 w-4 transition-[opacity,transform] duration-200 ${
                    showPassword ? "scale-75 opacity-0" : "scale-100 opacity-100"
                  }`}
                />
                <EyeOff
                  className={`absolute h-4 w-4 transition-[opacity,transform] duration-200 ${
                    showPassword ? "scale-100 opacity-100" : "scale-75 opacity-0"
                  }`}
                />
              </button>
            </div>
          </div>

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive animate-in fade-in duration-200">
              {error}
            </p>
          )}

          <Button
            type="submit"
            size="lg"
            className="h-11 w-full animate-in fade-in slide-in-from-top-2 duration-500 delay-500 fill-mode-both"
            disabled={loading || !username || !password}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Ingresando...
              </>
            ) : (
              <>
                <LogIn className="mr-2 h-4 w-4" /> Ingresar
              </>
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
