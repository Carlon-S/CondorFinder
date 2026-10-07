// Colores del trazo de ruta (HDU5/AC2), compartidos entre GeoMapImpl.tsx y
// GoogleMapImpl.tsx (que los dibujan) y RouteTimeline.tsx (que los repite al
// lado de cada tramo para que se puedan leer). Archivo aparte, no exportado
// junto a un componente en un .tsx, por Fast Refresh: ver la nota sobre
// button-variants.ts en CLAUDE.md.
//
// **Cuatro tramos, cuatro matices bien separados, y eso reemplaza al criterio
// anterior.** Antes la ida y el regreso eran el mismo azul en dos claridades,
// imitando a Google Maps, con la idea de que se leyeran como "la misma ruta en
// dos sentidos". Con la geometría real eso dejó de ser cierto: el recorrido no
// vuelve por donde fue (va base -> zonas -> relleno -> base) y además las
// transiciones entre zonas estaban metidas dentro de la ida, así que un plan de
// varias paradas se veía como una sola mancha azul donde no se distinguía dónde
// empezaba ni en qué orden se recorría.
//
// Los cuatro matices están repartidos por el círculo (azul 220°, magenta 330°,
// teal 180°, ámbar 30°) para que se distingan también sin percibir bien un par
// de tonos. **Ninguno es verde**, a propósito: el mapa base de Google pinta las
// autopistas y los parques en verde, y un trazo verde encima desaparece.
//
// Literales y no `var(--...)`: estos mapas dibujan con el renderer de canvas, y
// una variable CSS asignada a `ctx.strokeStyle` se descarta en silencio,
// dejando el color que hubiera quedado antes.

/** Del patio a la primera zona. El camión sale vacío. */
export const ROUTE_OUTBOUND_COLOR = "#2563eb";

/** De una zona a la siguiente. Es el tramo en que el camión va cargando, y
 *  antes viajaba dentro de la ida sin forma de distinguirlo. */
export const ROUTE_TRANSFER_COLOR = "#B45309";

/** De la última zona al relleno sanitario. El único que se hace cargado. */
export const ROUTE_DISPOSAL_COLOR = "#0E6E6E";

/** Del relleno de vuelta al patio, vacío. */
export const ROUTE_RETURN_COLOR = "#A21CAF";

// Los cuatro van a opacidad plena. Las opacidades existían cuando el regreso era
// "el mismo azul más tenue" y servían para distinguirlo de la ida; ahora cada
// tramo tiene su propio matiz, y atenuar uno solo lo haría parecer menos real
// que los otros tres, cuando el camión lo recorre igual.
export const ROUTE_RETURN_OPACITY = 1;
export const ROUTE_DISPOSAL_OPACITY = 1;

// Se evaluó puntear el regreso para distinguirlo donde comparte calle con el
// tramo de descarga, y **no hacía falta**: los dos trazos sí se distinguen,
// porque OSRM rutea cada sentido por su propia calzada y quedan uno al lado del
// otro, no encima. Lo que se confunde a zoom muy alto es la precisión del
// trazado, que es la geometría que devuelve el proveedor y no algo que un estilo
// pueda arreglar. Queda anotado para no volver a intentarlo.

// Borde oscuro debajo de todos los trazos (técnica de "casing" cartográfico),
// que los separa del fondo del mapa sin importar qué colores tenga debajo.
// Neutro y no azul, ahora que los trazos ya no son todos de la familia azul.
export const ROUTE_OUTLINE_COLOR = "#1f2937";
