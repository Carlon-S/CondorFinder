// =============================================================================
// CONDORFINDER, INSIGNIA DE ESTADO
// Archivo: src/components/InsigniaEstado.tsx
//
// La etiqueta que dice en qué estado está algo. Fondo tintado sin borde, texto
// en el tono oscuro, ícono a la izquierda y radio de etiqueta (6 px). Es la que
// usan Vista Principal, el historial de rutas, el itinerario y las tablas de
// recursos, y la comparten las etiquetas de la vista de análisis: con una copia
// por pantalla, el siguiente ajuste se aplica en la mitad.
// =============================================================================

import type { ReactNode } from "react";

import { CheckCircle2, TriangleAlert, XCircle } from "@/components/icons/Icons";
import { ESTILO_INSIGNIA, FORMA_INSIGNIA, type TonoInsignia } from "@/components/insignia-estilos";

/** Ícono por omisión de cada tono; `neutro` e `info` no llevan, porque no dicen
 *  una sola cosa y el ícono correcto lo pone quien conoce el estado. */
const ICONO_DEL_TONO: Partial<Record<TonoInsignia, ReactNode>> = {
  aviso: <TriangleAlert className="h-3 w-3" />,
  exito: <CheckCircle2 className="h-3 w-3" />,
  peligro: <XCircle className="h-3 w-3" />,
};

export function InsigniaEstado({
  tono,
  children,
  title,
  icono,
}: {
  tono: TonoInsignia;
  children: ReactNode;
  /** Qué significa, para el estado que no se explica solo. */
  title?: string;
  /** Ícono propio; `false` lo quita. Sin esto se usa el del tono. */
  icono?: ReactNode | false;
}) {
  const ic = icono === undefined ? ICONO_DEL_TONO[tono] : icono || null;
  return (
    <span className={`${FORMA_INSIGNIA} ${ESTILO_INSIGNIA[tono]}`} title={title}>
      {ic}
      {children}
    </span>
  );
}
