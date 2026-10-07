// =============================================================================
// CONDORFINDER, COLORES POR CLASE DE RESIDUO
// Archivo: src/components/zone-colors.ts
//
// Archivo aparte de ZoneZoomDialog.tsx por la regla de Fast Refresh: un .tsx
// que exporta algo que no es un componente fuerza una recarga completa de la
// página en cada edición, y eso puede aparecer como un error de SSR sin
// relación. Mismo patrón que button-variants.ts y los demás.
//
// Y una sola tabla para todo el sistema, porque la miran tres lugares: el visor
// de una zona, los chips de tipo de residuo del panel de rutas y la línea de
// tiempo. Con una copia por vista, un plástico se pinta de dos azules distintos
// según de dónde se lo abrió.
// =============================================================================

/** Los mismos colores que analysis.tsx usa para las mismas clases. */
const CLASS_COLORS: Record<string, string> = {
  "Residuo de construcción": "#ef4444",
  Metal: "#f97316",
  Plástico: "#3b82f6",
  "Residuo orgánico": "#22c55e",
  Muebles: "#a855f7",
  Neumáticos: "#64748b",
  "Tipo de basura indefinido": "#f59e0b",
  "Varios tipos": "#7c3aed",
};

/** El violeta de respaldo es el mismo que usa "Varios tipos": una clase que el
 *  modelo devuelva y esta tabla no conozca se pinta como una mezcla, que es lo
 *  más honesto que se puede decir de algo sin clasificar. */
export function classColor(cls: string): string {
  return CLASS_COLORS[cls] ?? "#7c3aed";
}
