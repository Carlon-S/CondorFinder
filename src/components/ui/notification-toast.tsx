import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, AlertTriangle, XCircle, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ToastVariant = "success" | "warning" | "error";

const VARIANT_ICON: Record<ToastVariant, React.ElementType> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

// Clases completas y estáticas (no armadas por interpolación) — Tailwind
// solo genera CSS para strings de clase que puede detectar literalmente en
// el código fuente, no para nombres construidos en tiempo de ejecución.
// Mismos tokens que ya usa el resto de la app para badges/tooltips por estado.
const VARIANT_CHIP: Record<ToastVariant, string> = {
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  error: "bg-destructive/15 text-destructive",
};

const VARIANT_BAR: Record<ToastVariant, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
};

interface NotificationToastProps {
  id: string | number;
  variant: ToastVariant;
  title: string;
  description?: string;
  duration: number;
}

/**
 * Tarjeta de notificación propia (vía sonner `toast.custom`) — reemplaza el
 * toast plano de una sola línea que había antes. La descripción arranca
 * colapsada; el trabajador la despliega con la flecha si quiere el detalle.
 *
 * Colapsada, el alto es exactamente el de la fila ícono+título+botones (sin
 * secciones extra que sumen espacio) — la barra de progreso es una línea de
 * 2px posicionada absoluta sobre el borde inferior, no participa del layout.
 *
 * Sin opción de pausar el cierre: es una notificación momentánea a propósito
 * (ver notify.tsx, que además cierra cualquier toast anterior antes de
 * mostrar uno nuevo — nunca hay más de uno a la vez).
 */
export function NotificationToast({ id, variant, title, description, duration }: NotificationToastProps) {
  const Icon = VARIANT_ICON[variant];
  const [expanded, setExpanded] = useState(false);
  const [barWidth, setBarWidth] = useState(100);

  useEffect(() => {
    // Arranca en 100% y en el siguiente frame baja a 0% — la transición CSS
    // (ver estilo inline abajo) hace la animación, sin re-renders por tick.
    const raf = requestAnimationFrame(() => setBarWidth(0));
    const closeTimer = setTimeout(() => toast.dismiss(id), duration);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(closeTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="panel relative w-full overflow-hidden">
      <div className="flex items-start gap-3 p-4">
        <span className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${VARIANT_CHIP[variant]}`}>
          <Icon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight text-foreground">{title}</p>
        </div>

        <div className="flex flex-shrink-0 items-center gap-1">
          {description && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              aria-label={expanded ? "Ocultar detalle" : "Mostrar detalle"}
              aria-expanded={expanded}
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
            </button>
          )}
          <button
            type="button"
            onClick={() => toast.dismiss(id)}
            aria-label="Cerrar"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {description && (
        // grid-template-rows 0fr→1fr en vez de max-height con un techo fijo:
        // anima hacia el alto real del contenido (no un valor adivinado), así
        // el crecimiento/achique se ve completo sin cortes ni espacio de más.
        // min-h-0 en la fila interna es necesario para que el grid pueda
        // colapsar a 0 — por defecto un ítem de grid no baja de su min-content.
        <div
          className={`grid overflow-hidden px-4 transition-[grid-template-rows,opacity] duration-300 ease-in-out ${
            expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="min-h-0 pb-4">
            <p className="pl-11 text-xs leading-relaxed text-muted-foreground">{description}</p>
            <div className="mt-3 pl-11">
              <Button variant="secondary" size="sm" onClick={() => toast.dismiss(id)}>
                Entendido
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Línea de progreso decorativa — absoluta, no suma alto al layout. */}
      <div className="absolute inset-x-0 bottom-0 h-0.5 bg-muted">
        <div
          className={`h-full ${VARIANT_BAR[variant]} transition-[width] ease-linear`}
          style={{ width: `${barWidth}%`, transitionDuration: `${duration}ms` }}
        />
      </div>
    </div>
  );
}
