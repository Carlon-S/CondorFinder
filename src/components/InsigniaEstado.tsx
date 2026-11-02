// =============================================================================
// CONDORFINDER, INSIGNIA DE ESTADO
// Archivo: src/components/InsigniaEstado.tsx
//
// La píldora que dice en qué estado está una fila. Es la que el historial de
// rutas ya usaba, sacada a un componente para que Vista Principal la comparta:
// la columna de estado de las dos tablas tiene que ser la misma pieza, no dos
// copias que se separan a la primera corrección.
// =============================================================================

import type { ReactNode } from "react";

import { ESTILO_INSIGNIA, FORMA_INSIGNIA, type TonoInsignia } from "@/components/insignia-estilos";

export function InsigniaEstado({
  tono,
  children,
  title,
}: {
  tono: TonoInsignia;
  children: ReactNode;
  /** Qué significa, para el estado que no se explica solo. */
  title?: string;
}) {
  return (
    <span className={`${FORMA_INSIGNIA} ${ESTILO_INSIGNIA[tono]}`} title={title}>
      {children}
    </span>
  );
}
