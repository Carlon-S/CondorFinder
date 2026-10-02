// Colores del trazo de ruta (HDU5/AC2) — constante compartida entre
// GeoMapImpl.tsx (que la dibuja) y rutas.tsx (que arma la leyenda), para que
// nunca queden desincronizados. Archivo aparte (no exportado junto a un
// componente en un .tsx) por Fast Refresh — ver la nota de disciplina en
// CLAUDE.md sobre button-variants.ts/etc.
//
// Estilo "Google Maps": azul sólido para la ida, el mismo azul pero más
// claro/semitransparente para la vuelta (ROUTE_RETURN_OPACITY) — en vez de
// dos colores completamente distintos, para que se lea como "la misma
// ruta, dos sentidos" igual que en Google/Waze.
export const ROUTE_OUTBOUND_COLOR = "#2563eb"; // ida
export const ROUTE_RETURN_COLOR = "#60a5fa"; // vuelta (mismo tono, más claro)
export const ROUTE_RETURN_OPACITY = 0.62;
// Tramo de la última zona al relleno sanitario: el ÚNICO que el camión hace
// cargado, y el único que no es "la misma ruta en otro sentido", así que sale
// de la familia azul. Es el teal de --disposal, en literal y no como variable
// CSS por la misma razón que el resto de este archivo: el renderer de canvas
// descarta una var() asignada a ctx.strokeStyle, en silencio.
export const ROUTE_DISPOSAL_COLOR = "#0E6E6E";
export const ROUTE_DISPOSAL_OPACITY = 0.9;
// Borde oscuro debajo de ambos trazos (técnica de "casing" cartográfico) —
// separa la línea del fondo del mapa sin importar qué colores tenga debajo.
export const ROUTE_OUTLINE_COLOR = "#1e3a8a";
