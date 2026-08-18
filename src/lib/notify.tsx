// =============================================================================
// CONDORFINDER — NOTIFICACIONES (toast)
// Archivo: src/lib/notify.tsx
//
// Capa fina sobre sonner: en vez de un mensaje plano de una línea
// (toast.success("...")), cada llamada separa un título (siempre visible) de
// una descripción opcional (arranca colapsada, el trabajador la despliega si
// quiere el detalle) — ver NotificationToast para el componente real.
//
// Mismo patrón que el resto de src/lib/*.ts: un módulo chico por
// responsabilidad, sin estado centralizado. Extensión .tsx porque renderiza
// JSX directamente (no hay forma de evitarlo con toast.custom).
// =============================================================================

import { toast } from "sonner";
import { NotificationToast, type ToastVariant } from "@/components/ui/notification-toast";

const DURATION_MS: Record<ToastVariant, number> = {
  success: 5000,
  warning: 5000,
  // Los errores quedan más tiempo — hay más para leer y suele requerir acción.
  error: 8000,
};

function show(variant: ToastVariant, title: string, description?: string) {
  const duration = DURATION_MS[variant];
  // Es una notificación momentánea, no un feed: nunca deben verse dos a la
  // vez. Cerramos cualquier toast activo antes de mostrar el nuevo.
  toast.dismiss();
  toast.custom(
    (id) => (
      <NotificationToast id={id} variant={variant} title={title} description={description} duration={duration} />
    ),
    { duration: Infinity }, // el auto-cierre real lo maneja NotificationToast
  );
}

export const notify = {
  success: (title: string, description?: string) => show("success", title, description),
  warning: (title: string, description?: string) => show("warning", title, description),
  error: (title: string, description?: string) => show("error", title, description),
};
