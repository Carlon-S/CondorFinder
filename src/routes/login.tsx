// =============================================================================
// CONDORFINDER, INICIO DE SESIÓN
// Archivo: src/routes/login.tsx
//
// Ruta de nivel superior (NO vive bajo _authed): es la única página accesible
// sin sesión. El resto pasa por el guard de `_authed.tsx`, que redirige acá con
// `?redirect=<ruta original>` cuando no hay usuario.
//
// **Ya no hay formulario de usuario y contraseña.** La identidad la emite un
// proveedor externo y acá solo se elige cuál. Nadie escribe una contraseña en
// este sistema, así que no hay ninguna que se pueda robar en esta pantalla.
//
// ── La estructura ──
// Dos columnas, tomadas de las referencias visuales: el acceso a la izquierda
// sobre superficie clara, la marca a la derecha sobre un campo saturado. Lo que
// NO se toma es el violeta de esas referencias, que es su marca; acá el campo
// es el navy del tema.
//
// Las referencias llenan la columna del formulario con tres o cuatro campos y
// nosotros tenemos dos botones, así que ese lado quedaría vacío. La salida es
// usar esa asimetría para decir algo verdadero: **Microsoft es el botón
// principal porque es el cliente**, y el acceso del equipo queda detrás de un
// enlace discreto. La municipalidad ve un solo camino, que es exactamente la
// política de acceso, y el equipo sabe dónde apretar.
//
// Bajo 64rem la columna de marca desaparece y queda el acceso centrado, que es
// más o menos la pantalla anterior.
// =============================================================================

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2 } from "@/components/icons/Icons";
import { Button } from "@/components/ui/button";
import { CLIENT_BACKEND_URL } from "@/lib/config";
import logoClaro from "@/assets/Logo/logo-light-mode.svg";
import logoOscuro from "@/assets/Logo/logo-dark-mode.svg";

export const Route = createFileRoute("/login")({
  // El tipo de retorno va explícito con los dos campos OPCIONALES. Inferido,
  // TanStack los toma como requeridos y el guard de `_authed.tsx`, que navega
  // acá pasando solo `redirect`, deja de compilar.
  validateSearch: (search: Record<string, unknown>): { redirect?: string; error?: string } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
    // Lo pone el backend al rechazar: el regreso desde el proveedor es una
    // navegación del navegador, no un fetch, así que no hay cuerpo de respuesta
    // que leer y el motivo tiene que viajar en la URL.
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: LoginPage,
});

/** Qué decirle a la persona según lo que rechazó el backend.
 *
 *  El mapa vive acá y no en el servidor porque son textos de interfaz, y el
 *  backend manda identificadores estables que no cambian cuando se reescribe
 *  una frase. El respaldo cubre un identificador que todavía no esté acá: es
 *  preferible un mensaje genérico a una pantalla que no dice nada. */
const MENSAJES: Record<string, string> = {
  "organizacion-no-autorizada":
    "Esa cuenta no pertenece a la Municipalidad de Maipú, así que no tiene acceso al sistema.",
  "cuenta-no-autorizada": "Esa cuenta no está autorizada para entrar.",
  "sin-correo": "La cuenta con la que entraste no tiene un correo asociado.",
  "proveedor-rechazo":
    "El proveedor canceló el inicio de sesión. Si es la primera vez, puede que tu organización necesite aprobar la aplicación.",
  "proveedor-no-configurado": "Ese método de inicio de sesión todavía no está configurado.",
  "proveedor-no-disponible":
    "No se pudo contactar al proveedor. Intenta nuevamente en unos minutos.",
  "sesion-expirada": "El inicio de sesión tardó demasiado. Intenta de nuevo.",
  "estado-invalido": "El inicio de sesión no se pudo verificar. Intenta de nuevo.",
  "token-invalido": "No se pudo validar la respuesta del proveedor.",
};

interface Disponibles {
  proveedores: string[];
  password: boolean;
}

function LoginPage() {
  const { redirect, error } = Route.useSearch();

  const navigate = useNavigate({ from: "/login" });

  const [disponibles, setDisponibles] = useState<Disponibles | null>(null);
  const [yendo, setYendo] = useState<string | null>(null);
  const [equipoVisible, setEquipoVisible] = useState(false);
  // El motivo se copia a estado y se saca de la barra de direcciones.
  //
  // Vive en la URL porque el regreso desde el proveedor es una navegación del
  // navegador y no hay otro lugar donde ponerlo, pero dejarlo ahí lo vuelve
  // permanente: recargar la página reimprime un rechazo que ya ocurrió, y el
  // mensaje parece pegado a la pantalla en vez de referirse a un intento.
  const [motivo, setMotivo] = useState<string | undefined>(error);

  // Qué proveedores ofrecer lo decide el backend, según qué credenciales tenga
  // configuradas. Sin esto, un `.env` a medio llenar mostraría un botón que
  // lleva directo a una pantalla de error.
  useEffect(() => {
    fetch(`${CLIENT_BACKEND_URL}/auth/proveedores`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setDisponibles(d ?? { proveedores: [], password: false }))
      .catch(() => setDisponibles({ proveedores: [], password: false }));
  }, []);

  useEffect(() => {
    if (!error) return;
    setMotivo(error);
    navigate({ search: (prev) => ({ ...prev, error: undefined }), replace: true });
  }, [error, navigate]);

  // Navegación de página completa y no un fetch: el flujo necesita que el
  // navegador siga los redirects hasta el proveedor y de vuelta, y que las
  // cookies que el backend emite en el camino se apliquen de verdad.
  const entrarCon = (proveedor: string) => {
    setMotivo(undefined);
    setYendo(proveedor);
    const destino = redirect ? `?redirect=${encodeURIComponent(redirect)}` : "";
    window.location.href = `${CLIENT_BACKEND_URL}/auth/oidc/${proveedor}/start${destino}`;
  };

  const hayMicrosoft = disponibles?.proveedores.includes("microsoft") ?? false;
  const hayGoogle = disponibles?.proveedores.includes("google") ?? false;

  return (
    <div className="grid min-h-screen lg:grid-cols-[2fr_3fr]">
      {/* ── Acceso ── */}
      <main className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <img
            src={logoClaro}
            alt="CondorFinder"
            className="h-16 w-auto animate-in fade-in zoom-in-95 duration-500 fill-mode-both"
          />

          <h1 className="mt-8 animate-in fade-in slide-in-from-top-2 duration-500 delay-100 fill-mode-both font-rubik text-3xl font-semibold tracking-normal text-foreground">
            Iniciar sesión
          </h1>
          <p className="mt-2 animate-in fade-in slide-in-from-top-2 duration-500 delay-150 fill-mode-both text-sm text-muted-foreground">
            Entra con tu cuenta institucional para acceder al sistema.
          </p>

          {motivo && (
            <p className="mt-6 animate-in fade-in duration-200 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed text-destructive-strong">
              {MENSAJES[motivo] ?? "No se pudo iniciar sesión. Intenta nuevamente."}
            </p>
          )}

          <div className="mt-8 animate-in fade-in slide-in-from-top-2 duration-500 delay-200 fill-mode-both">
            {disponibles === null ? (
              // Un marcador de carga y no los botones deshabilitados: un botón
              // que aparece apagado y después se enciende se lee como si
              // hubiera fallado algo.
              <div className="flex h-11 items-center justify-center rounded-md border border-border/60">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : hayMicrosoft ? (
              <Button
                size="lg"
                className="h-11 w-full"
                onClick={() => entrarCon("microsoft")}
                disabled={yendo !== null}
              >
                {yendo === "microsoft" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <IconoMicrosoft />
                )}
                Iniciar sesión con Microsoft
              </Button>
            ) : (
              <p className="rounded-md border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                El inicio de sesión con Microsoft todavía no está configurado en este servidor.
              </p>
            )}
          </div>

          {disponibles?.password && (
            // Solo en desarrollo: en la VM `ALLOW_PASSWORD_LOGIN` no está
            // definida y el endpoint devuelve 404, así que este aviso no
            // aparece nunca en producción.
            <p className="mt-6 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
              El inicio de sesión con contraseña sigue habilitado en este servidor. Es para
              desarrollo local y no debería estar activo en producción.
            </p>
          )}

          <p className="mt-10 text-[0.6875rem] leading-relaxed text-muted-foreground">
            El acceso está restringido a cuentas de la Municipalidad de Maipú.
          </p>

          {/* LA PUERTA DEL EQUIPO, DETRÁS DE UN CLIC.
              El funcionario municipal tiene que ver UN camino. Con los dos
              botones a la vista, el de Google es el que no le sirve y es
              además el que reconoce, así que es el que iba a apretar.

              Detrás de un enlace y no en otra URL: una dirección aparte se
              olvida y termina anotada en alguna parte, y acá no hay nada que
              esconder. El clic de más es lo que separa al que lo busca del que
              lo encuentra de casualidad. */}
          {hayGoogle && (
            <div className="mt-6">
              {equipoVisible ? (
                <div className="animate-in fade-in slide-in-from-top-1 duration-300">
                  <div className="flex items-center gap-3">
                    <span className="h-px flex-1 bg-border" />
                    <span className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                      Equipo CondorFinder
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <Button
                    variant="outline"
                    className="mt-4 h-10 w-full"
                    onClick={() => entrarCon("google")}
                    disabled={yendo !== null}
                  >
                    {yendo === "google" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <IconoGoogle />
                    )}
                    Continuar con Google
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setEquipoVisible(true)}
                  className="text-[0.6875rem] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                >
                  Acceso del equipo de desarrollo
                </button>
              )}
            </div>
          )}
        </div>
      </main>

      {/* ── Marca ──
          `login-dark` redefine los tokens del tema SOLO para este subárbol, así
          que lo que viva acá adentro toma el tratamiento oscuro sin que haya
          que escribir un color a mano. Antes envolvía la página entera; con el
          acceso sobre superficie clara, solo lo necesita este panel.

          El hueco del centro está pensado para un ortomosaico con sus recuadros
          de detección, que es lo más persuasivo que tiene el proyecto y lo que
          la referencia de floret pone en este mismo lugar. Mientras no haya uno
          en `src/assets`, sostiene el logo: un marco vacío se vería como una
          imagen que no cargó. */}
      <aside className="login-dark relative hidden items-center justify-center overflow-hidden bg-sidebar px-12 lg:flex">
        <div className="relative z-10 max-w-md text-center">
          <div className="detect-frame mx-auto flex aspect-[4/3] w-full items-center justify-center rounded-xl border border-white/10 bg-white/[0.03]">
            <span className="detect-corners" aria-hidden="true" />
            <img src={logoOscuro} alt="" className="h-24 w-auto opacity-90" />
          </div>
          <p className="mt-8 font-rubik text-2xl font-semibold leading-snug text-white">
            Detección de microbasurales desde imágenes aéreas
          </p>
          <p className="mt-3 text-sm leading-relaxed text-white/60">Municipalidad de Maipú</p>
        </div>
      </aside>
    </div>
  );
}

/** Los cuatro cuadrados de Microsoft. Inline y no desde un paquete de íconos:
 *  es una marca registrada con colores fijos que no deben seguir al tema. */
function IconoMicrosoft() {
  return (
    <svg className="mr-2 h-4 w-4" viewBox="0 0 23 23" aria-hidden="true">
      <path fill="#f35325" d="M1 1h10v10H1z" />
      <path fill="#81bc06" d="M12 1h10v10H12z" />
      <path fill="#05a6f0" d="M1 12h10v10H1z" />
      <path fill="#ffba08" d="M12 12h10v10H12z" />
    </svg>
  );
}

/** La G de Google, por el mismo motivo que arriba. */
function IconoGoogle() {
  return (
    <svg className="mr-2 h-4 w-4" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}
