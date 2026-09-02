// Colores del trazo de ruta (HDU5/AC2) — constante compartida entre
// GeoMapImpl.tsx (que la dibuja) y rutas.tsx (que arma la leyenda), para que
// nunca queden desincronizados. Archivo aparte (no exportado junto a un
// componente en un .tsx) por Fast Refresh — ver la nota de disciplina en
// CLAUDE.md sobre button-variants.ts/etc.
//
// Violeta/rosa en vez del celeste/naranjo original: se camuflaban contra
// las calles naranjas y el agua celeste de los tiles de OpenStreetMap.
// Violeta y rosa casi no aparecen en la paleta de OSM, así que se leen
// claro en cualquier zoom/zona del mapa.
export const ROUTE_OUTBOUND_COLOR = "#7c3aed"; // ida
export const ROUTE_RETURN_COLOR = "#db2777"; // vuelta
// Borde oscuro debajo de ambos trazos (técnica de "casing" cartográfico) —
// separa la línea del fondo del mapa sin importar qué colores tenga debajo.
export const ROUTE_OUTLINE_COLOR = "#1e293b";
