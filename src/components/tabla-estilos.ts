// =============================================================================
// CONDORFINDER, CONVENCIONES VISUALES DE LAS TABLAS
// Archivo: src/components/tabla-estilos.ts
//
// El tamaño, el relleno y los botones de fila que comparten las tablas del
// sistema: Vista Principal, la lista de puntos y la flota de un punto. Salieron
// de Vista Principal, donde se definieron tomando como referencia la tabla del
// historial de rutas, para que las otras dos no los copien: con una copia por
// vista, el siguiente ajuste de alto o de color se aplica en dos de las tres.
//
// Es un `.ts` y no parte de un componente por la regla de Fast Refresh del
// proyecto (un .tsx que exporta algo que no es un componente fuerza una recarga
// completa en cada edición).
//
// Todo en `rem` y en clases de Tailwind: la interfaz escala con el `clamp` de
// `html` (ver styles.css), y un valor en px se saldría de esa escala.
// =============================================================================

/** La fila del encabezado de una tabla. */
export const ENCABEZADO_FILA = "border-b border-border/60 bg-muted/40 hover:bg-muted/40";

/** Una celda de encabezado que NO se ordena. Las ordenables llevan `CAB_ORDEN`. */
export const CAB_TEXTO = "px-3 text-[0.6875rem]";

/** El encabezado de una columna ordenable (`SortableHead`), en el tamaño y el
 *  relleno de las demás. El relleno va sobre el `button` interno porque el
 *  componente pone `p-0` en la celda. */
export const CAB_ORDEN = "text-[0.6875rem] [&>button]:px-3";

/** Una fila del cuerpo: separada de la siguiente por una línea fina. */
export const FILA = "border-b border-border/40";

/** Una celda del cuerpo. */
export const CELDA = "px-3 py-3";

/** Los botones de FILA: 1,75 rem de alto y texto de 0,6875 rem en seminegrita.
 *
 *  **Cada fila tiene UNA acción principal** (la siguiente: ver, retomar,
 *  generar), con el relleno amarillo del botón por omisión y puesta PRIMERA. Las
 *  demás son secundarias, y el borrado va último y con el tinte del peligro. Es
 *  la convención del historial de rutas, que fue la referencia. */
export const BTN_FILA = "h-7 px-2.5 text-[0.6875rem] font-semibold";

/** Una acción secundaria con texto: borde y tinte de la marca. */
export const BTN_FILA_SECUNDARIO = `${BTN_FILA} border-primary/40 bg-primary/5 text-primary hover:bg-primary/15 hover:text-primary`;

/** Un botón de ícono sin carga semántica (editar). */
export const BTN_FILA_ICONO_NEUTRO = "h-7 w-7 text-muted-foreground hover:text-foreground";

/** El botón de ícono del borrado. */
export const BTN_FILA_ICONO =
  "h-7 w-7 border-destructive-strong/30 text-destructive-strong hover:bg-destructive/15 hover:text-destructive-strong";
