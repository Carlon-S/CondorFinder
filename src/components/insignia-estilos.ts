// =============================================================================
// CONDORFINDER, ESTILOS DE LA INSIGNIA DE ESTADO
// Archivo: src/components/insignia-estilos.ts
//
// Separado de `InsigniaEstado.tsx` por la regla de Fast Refresh del proyecto: un
// archivo .tsx que exporta algo que no es un componente fuerza una recarga
// completa en cada edición. Mismo patrón que `button-variants.ts`.
//
// Cinco tonos y no un color por estado: el historial de rutas, la tabla de
// zonas y el desglose por lugar dicen cosas distintas ("terminada", "con
// análisis", "completo"), pero son la MISMA clase de dato (en qué punto está
// algo) y tienen que leerse igual. Con un color escrito a mano por pantalla, el
// verde de una era otro verde en la siguiente.
// =============================================================================

export type TonoInsignia = "neutro" | "info" | "aviso" | "exito" | "peligro";

/** Borde, fondo y texto de cada tono. El texto usa las variantes `-strong`: las
 *  planas no tienen contraste sobre el cuerpo claro (ver CLAUDE.md, Theming). */
export const ESTILO_INSIGNIA: Record<TonoInsignia, string> = {
  neutro: "bg-muted text-muted-foreground",
  info: "bg-primary/10 text-primary",
  aviso: "bg-warning/15 text-warning-strong",
  exito: "bg-success/15 text-success-strong",
  peligro: "bg-destructive/10 text-destructive-strong",
};

/** La forma de la insignia, igual en todas las tablas. */
export const FORMA_INSIGNIA =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-[0.6875rem] font-medium leading-none";
