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
// ── Una tarjeta centrada, no dos columnas ──
// Esto fue dos columnas (acceso a la izquierda sobre superficie clara, marca a
// la derecha sobre navy) y se revirtió. El motivo no es de gusto: las
// referencias de ese patrón llenan la columna del formulario con cuatro o cinco
// campos, y acá hay UN botón y un enlace. La mitad derecha existía para tapar
// que la izquierda quedaba vacía.
//
// Una tarjeta del tamaño de su contenido no tiene ese problema: con poco
// adentro se lee como deliberada, mientras que media pantalla con lo mismo se
// lee como incompleta. Y funciona igual en cualquier ancho, sin una maqueta
// aparte para pantallas angostas.
//
// ── Oscura, con el navy de la marca y no negro ──
// Toda la página va dentro de `.login-dark`, que redefine los tokens del tema
// SOLO para este subárbol (src/styles.css). Por eso los componentes de
// `components/ui/` toman el tratamiento oscuro sin que haya que escribir un
// color a mano: leen `var(--card)`, `var(--border)`, etc.
//
// ── El marco de detección ──
// Las cuatro esquinas en L de `.detect-frame` enmarcan la tarjeta. Es el motivo
// de marca y además significa algo: es el recuadro con que se marca un objeto
// detectado, que es exactamente lo que hace el producto. En CLAUDE.md está
// escrito que la aplicación no lleva patrón de fondo, y la razón es que en las
// vistas de trabajo cualquier textura compite con el mapa o la tabla de cifras
// que hay que mirar. Acá no hay datos que mirar, así que la razón no aplica:
// es una excepción razonada, no un olvido.
//
// ── Lo que esta pantalla NO dice ──
// No nombra al cliente ni explica cómo está organizado el acceso. Decía "El
// acceso está restringido a cuentas de la Municipalidad de Maipú", y eso le
// contaba a cualquiera que abriera la página quién es el cliente y por dónde se
// entra. En su lugar va una línea sobre qué hace el sistema.
// =============================================================================

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2 } from "@/components/icons/Icons";
import { Button } from "@/components/ui/button";
import { CLIENT_BACKEND_URL } from "@/lib/config";
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
    "Esa cuenta no pertenece a una organización autorizada para usar el sistema.",
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

/** Las cuatro etapas del proceso, que dicen qué es esto mejor que un párrafo. */
const ETAPAS = ["Ortomosaico", "Detección", "Volumen", "Rutas"];

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
    <div className="login-dark relative flex min-h-screen items-center justify-center overflow-hidden px-6 py-12">
      {/* Un resplandor amplio y muy tenue detrás de la tarjeta. No es un patrón
          ni una textura: no tiene dibujo, solo levanta el centro del navy para
          que la tarjeta no flote sobre un plano uniforme. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[44rem] w-[44rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(255,197,61,0.055),transparent_62%)]"
      />

      <main className="relative z-10 w-full max-w-sm">
        {/* p-10 y no p-8: las esquinas de `.detect-frame` ocupan de 10px a 36px
            desde el borde, así que con menos aire el primer elemento quedaría
            pisado por el trazo. */}
        <div className="detect-frame animate-in fade-in zoom-in-95 duration-500 fill-mode-both rounded-xl border border-border bg-card p-10 shadow-2xl shadow-black/40">
          <span className="detect-corners" aria-hidden="true" />

          <img src={logoOscuro} alt="CondorFinder" className="h-12 w-auto" />

          <p className="eyebrow mt-7">Detección de microbasurales</p>

          <h1 className="font-rubik text-2xl font-semibold tracking-normal text-foreground">
            Iniciar sesión
          </h1>

          <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
            Detección automatizada de basurales desde imágenes aéreas, con cálculo de volumen y
            planificación de retiro.
          </p>

          {motivo && (
            <p className="mt-6 animate-in fade-in duration-200 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed text-destructive-strong">
              {MENSAJES[motivo] ?? "No se pudo iniciar sesión. Intenta nuevamente."}
            </p>
          )}

          <div className="mt-7">
            {disponibles === null ? (
              // Un marcador de carga y no los botones deshabilitados: un botón
              // que aparece apagado y después se enciende se lee como si
              // hubiera fallado algo.
              <div className="flex h-11 items-center justify-center rounded-md border border-border">
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
                Continuar con Microsoft
              </Button>
            ) : (
              <p className="rounded-md border border-dashed border-border px-3 py-3 text-xs leading-relaxed text-muted-foreground">
                El inicio de sesión con Microsoft todavía no está configurado en este servidor.
              </p>
            )}
          </div>

          {disponibles?.password && (
            // Solo en desarrollo: en la VM `ALLOW_PASSWORD_LOGIN` no está
            // definida y el endpoint devuelve 404, así que este aviso no
            // aparece nunca en producción.
            <p className="mt-5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
              El inicio de sesión con contraseña sigue habilitado en este servidor. Es para
              desarrollo local y no debería estar activo en producción.
            </p>
          )}

          {/* LA PUERTA DEL EQUIPO, DETRÁS DE UN CLIC.
              El funcionario municipal tiene que ver UN camino. Con los dos
              botones a la vista, el de Google es el que no le sirve y es
              además el que reconoce, así que es el que iba a apretar.

              Detrás de un enlace y no en otra URL: una dirección aparte se
              olvida y termina anotada en alguna parte, y acá no hay nada que
              esconder. El clic de más es lo que separa al que lo busca del que
              lo encuentra de casualidad. */}
          {hayGoogle && (
            <div className="mt-7">
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

        {/* El pie va FUERA de la tarjeta: ancla la composición y dice qué hace
            el sistema sin ocupar espacio adentro, donde solo hay una acción. */}
        <ul className="mt-7 flex animate-in fade-in duration-500 delay-200 fill-mode-both items-center justify-center gap-3 text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground/70">
          {ETAPAS.map((etapa, i) => (
            <li key={etapa} className="flex items-center gap-3">
              {i > 0 && <span aria-hidden="true" className="h-1 w-1 rounded-full bg-current" />}
              {etapa}
            </li>
          ))}
        </ul>
      </main>
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
