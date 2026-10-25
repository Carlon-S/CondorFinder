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
import { Loader2, Users } from "@/components/icons/Icons";
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
      <CampoDeDetecciones />

      {/* Un resplandor amplio y muy tenue detrás de la tarjeta. No es un patrón
          ni una textura: no tiene dibujo, solo levanta el centro del navy para
          que la tarjeta no flote sobre un plano uniforme. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[44rem] w-[44rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(255,197,61,0.055),transparent_62%)]"
      />

      {/* El barrido pasa POR ENCIMA de los polígonos y por debajo de la tarjeta,
          así que los enciende apenas al cruzarlos. Es lo que convierte dos capas
          quietas en una sola que respira. */}
      <div
        aria-hidden="true"
        className="login-scan pointer-events-none absolute inset-0 overflow-hidden"
      />

      <main className="relative z-10 w-full max-w-md">
        {/* Todo centrado: con una sola acción adentro, una tarjeta alineada a
            la izquierda deja una columna de aire muerto a la derecha de cada
            línea. El padding es generoso y uniforme porque las esquinas de
            `.detect-frame` ocupan de 10px a 36px desde el borde, así que con
            menos aire el primer elemento quedaría pisado por el trazo. */}
        <div className="animate-in fade-in zoom-in-95 duration-500 fill-mode-both rounded-xl border border-border bg-card px-10 py-12 text-center shadow-2xl shadow-black/40">
          <img src={logoOscuro} alt="CondorFinder" className="mx-auto h-20 w-auto" />

          <h1 className="mt-8 font-rubik text-3xl font-semibold tracking-normal text-foreground">
            Iniciar sesión
          </h1>

          <p className="mx-auto mt-3 max-w-[22rem] text-sm leading-relaxed text-muted-foreground">
            Detección automatizada de basurales desde imágenes aéreas, con cálculo de volumen y
            planificación de retiro.
          </p>

          {motivo && (
            <p className="mt-7 animate-in fade-in duration-200 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs leading-relaxed text-destructive-strong">
              {MENSAJES[motivo] ?? "No se pudo iniciar sesión. Intenta nuevamente."}
            </p>
          )}

          <div className="mt-8">
            {disponibles === null ? (
              // Un marcador de carga y no los botones deshabilitados: un botón
              // que aparece apagado y después se enciende se lee como si
              // hubiera fallado algo.
              <div className="flex h-12 items-center justify-center rounded-md border border-border">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : hayMicrosoft ? (
              // Claro y NO el amarillo de `--cta`, que es el variant por
              // omisión. El logotipo de Microsoft lleva un cuadrado amarillo
              // (#ffba08) que sobre el amarillo de marca se pierde y ensucia
              // los otros tres. Sus propias guías piden fondo blanco o negro.
              //
              // `bg-primary` y no un hex: en `.login-dark` ese token ya es
              // #EDF1F9 sobre texto navy, así que el color sigue saliendo del
              // tema. El amarillo se queda donde no compite: el guion del
              // eyebrow y las esquinas del marco.
              <Button
                variant="secondary"
                size="lg"
                className="h-12 w-full bg-primary text-base text-primary-foreground hover:bg-primary/90"
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
              <p className="rounded-md border border-dashed border-border px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                El inicio de sesión con Microsoft todavía no está configurado en este servidor.
              </p>
            )}
          </div>

          {disponibles?.password && (
            // Solo en desarrollo: en la VM `ALLOW_PASSWORD_LOGIN` no está
            // definida y el endpoint devuelve 404, así que este aviso no
            // aparece nunca en producción.
            <p className="mt-5 rounded-md border border-warning/40 bg-warning/10 px-4 py-2.5 text-[0.6875rem] leading-relaxed text-muted-foreground">
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
            <div className="mt-8 border-t border-border pt-6">
              {equipoVisible ? (
                <div className="animate-in fade-in slide-in-from-top-1 duration-300">
                  <p className="text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground">
                    Equipo CondorFinder
                  </p>
                  <Button
                    variant="outline"
                    className="mt-4 h-11 w-full"
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
                // `cursor-pointer` explícito: Tailwind v4 cambió el preflight y
                // un <button> ya no lo trae solo. Los de `components/ui/button`
                // lo tienen en la base de `buttonVariants`, este no pasa por
                // ahí, y sin el cursor el enlace no se anunciaba como apretable.
                <button
                  type="button"
                  onClick={() => setEquipoVisible(true)}
                  className="mx-auto flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Users className="h-3.5 w-3.5" />
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

/** Polígonos de ejemplo, en la escala de verde a rojo con que la aplicación
 *  pinta el volumen de una zona. Coordenadas en un lienzo de 1440x900 que se
 *  recorta para cubrir el viewport (`slice`), así que en pantallas angostas los
 *  de los costados salen de cuadro y quedan los de arriba y abajo.
 *
 *  Deliberadamente lejos del centro: ahí va la tarjeta. Que sea opaca hace que
 *  un solape no se vea, pero un polígono escondido es trabajo tirado. */
const DETECCIONES = [
  {
    d: "M120 140 L250 110 L300 200 L190 250 L110 210 Z",
    color: "#4ade80",
    marco: [96, 96, 314, 264],
  },
  { d: "M60 420 L170 390 L220 480 L120 540 Z", color: "#fbbf24", marco: null },
  { d: "M200 640 L340 620 L390 720 L250 760 L180 710 Z", color: "#f87171", marco: null },
  { d: "M520 70 L650 50 L690 140 L560 170 Z", color: "#a3e635", marco: null },
  { d: "M1150 120 L1300 150 L1330 260 L1200 280 Z", color: "#fb923c", marco: null },
  {
    d: "M1050 430 L1180 400 L1240 500 L1100 540 L1030 490 Z",
    color: "#4ade80",
    marco: [1016, 386, 1254, 554],
  },
  { d: "M1220 660 L1360 690 L1340 790 L1190 760 Z", color: "#fbbf24", marco: null },
  { d: "M800 780 L950 760 L980 860 L830 880 Z", color: "#fb923c", marco: [786, 746, 994, 894] },
];

/** Las cuatro esquinas en L alrededor de una caja, el mismo dibujo que
 *  `.detect-frame`, pero acá hecho en SVG porque marca un polígono y no un
 *  elemento del DOM.
 *
 *  Este motivo estuvo enmarcando la tarjeta de acceso y se sacó: una tarjeta no
 *  es una detección, así que ahí el recuadro no significaba nada. Alrededor de
 *  un polígono dice exactamente lo que dice en la vista de análisis. */
function Marco({ caja }: { caja: [number, number, number, number] }) {
  const [x1, y1, x2, y2] = caja;
  const b = 22;
  return (
    <path
      d={[
        `M${x1} ${y1 + b} L${x1} ${y1} L${x1 + b} ${y1}`,
        `M${x2 - b} ${y1} L${x2} ${y1} L${x2} ${y1 + b}`,
        `M${x2} ${y2 - b} L${x2} ${y2} L${x2 - b} ${y2}`,
        `M${x1 + b} ${y2} L${x1} ${y2} L${x1} ${y2 - b}`,
      ].join(" ")}
      fill="none"
      stroke="#FFC53D"
      strokeOpacity={0.22}
      strokeWidth={2}
    />
  );
}

/** El fondo de la página: un ortomosaico analizado, dibujado con el lenguaje
 *  propio del producto en vez de con una textura genérica.
 *
 *  Nada de esto sale de un vuelo real. Una foto aérea del territorio del
 *  cliente en la pantalla pública de acceso es justamente lo que esta vista
 *  dejó de decir en texto. */
function CampoDeDetecciones() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMid slice"
    >
      {DETECCIONES.map((zona) => (
        <g key={zona.d}>
          <path
            d={zona.d}
            fill={zona.color}
            fillOpacity={0.05}
            stroke={zona.color}
            strokeOpacity={0.16}
            strokeWidth={1.5}
          />
          {zona.marco && <Marco caja={zona.marco as [number, number, number, number]} />}
        </g>
      ))}
    </svg>
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
