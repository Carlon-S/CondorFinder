// =============================================================================
// CONDORFINDER, COLORES POR CLASE DE RESIDUO
// Archivo: src/components/zone-colors.ts
//
// Archivo aparte de ZoneZoomDialog.tsx por la regla de Fast Refresh: un .tsx
// que exporta algo que no es un componente fuerza una recarga completa de la
// página en cada edición, y eso puede aparecer como un error de SSR sin
// relación. Mismo patrón que button-variants.ts y los demás.
//
// Es la única tabla de colores por clase de residuo del frontend. La usan el
// visor de una zona, la vista de análisis, la vista de carga, los chips de tipo
// de residuo del panel de rutas y la línea de tiempo.
//
// Los nombres y colores de las 20 clases del modelo y de las 3 clases del modelo
// anterior son los mismos que define `backendModel/detecting/waste_classes.py`.
// =============================================================================

/** Color de cada clase, por su nombre en español. */
export const CLASS_COLORS: Record<string, string> = {
  // Las 20 clases del modelo de segmentación.
  Escombros: "#b91c1c",
  "Residuo de construcción": "#ef4444",
  "Fresado asfáltico": "#374151",
  "Material de excavación": "#92400e",
  Electrodomésticos: "#06b6d4",
  "Equipos electrónicos": "#6366f1",
  Muebles: "#a855f7",
  "Barriles metálicos": "#94a3b8",
  "Envases plásticos": "#0ea5e9",
  Madera: "#ca8a04",
  Pallets: "#eab308",
  Chatarra: "#78716c",
  Plástico: "#3b82f6",
  Vehículos: "#14b8a6",
  Neumáticos: "#64748b",
  Papel: "#84cc16",
  Fundición: "#d946ef",
  Asbesto: "#ec4899",
  Textil: "#fb7185",
  "Residuos mezclados": "#8b5cf6",
  // Clases del modelo anterior, que siguen apareciendo en los análisis ya
  // guardados.
  Metal: "#f97316",
  "Residuo orgánico": "#22c55e",
  "Tipo de basura indefinido": "#f59e0b",
  // Una detección que agrupa varias clases.
  "Varios tipos": "#7c3aed",
};

/** Las clases que puede producir el modelo actual, en el orden de la tabla. */
export const WASTE_CLASS_NAMES: string[] = [
  "Escombros",
  "Residuo de construcción",
  "Fresado asfáltico",
  "Material de excavación",
  "Electrodomésticos",
  "Equipos electrónicos",
  "Muebles",
  "Barriles metálicos",
  "Envases plásticos",
  "Madera",
  "Pallets",
  "Chatarra",
  "Plástico",
  "Vehículos",
  "Neumáticos",
  "Papel",
  "Fundición",
  "Asbesto",
  "Textil",
  "Residuos mezclados",
];

/** Color de una clase. Una clase que la tabla no conoce toma un tono derivado
 *  de su nombre: el mismo nombre da siempre el mismo color. */
export function classColor(cls: string): string {
  if (CLASS_COLORS[cls]) return CLASS_COLORS[cls];
  let hash = 0;
  for (let i = 0; i < cls.length; i++) hash = (hash * 31 + cls.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360},75%,55%)`;
}
