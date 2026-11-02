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

// =============================================================================
// UN COLOR POR RECORRIDO
//
// Con varios convoyes el plan tiene varios recorridos, y pintar cada TRAMO de un
// color distinto (arriba) hacía que dos recorridos se confundieran entre sí: el
// azul de la ida del primero era el mismo azul de la ida del segundo. Ahora el
// color identifica al RECORRIDO, y el tramo se distingue por grosor y
// transparencia dentro de ese mismo color.
//
// Seis tonos repartidos por el círculo cromático, **ninguno verde** por la misma
// razón que arriba (el mapa base pinta parques y autopistas en verde). El
// recorrido N usa `colorDeRecorrido(N)`, y el mismo literal se imprime en su
// tarjeta, en su selector sobre el mapa y en su leyenda, para que se empareje a
// simple vista. Literales por el renderer de canvas.
// =============================================================================

export const ROUTE_PALETTE = [
  "#2563eb", // azul
  "#A21CAF", // magenta
  "#C2410C", // naranjo quemado
  "#0E7490", // cian oscuro
  "#BE123C", // carmesí
  "#6D28D9", // violeta
] as const;

export function colorDeRecorrido(indice: number): string {
  return ROUTE_PALETTE[
    ((indice % ROUTE_PALETTE.length) + ROUTE_PALETTE.length) % ROUTE_PALETTE.length
  ];
}

/** Los cuatro tramos de un recorrido. */
export type TipoTramo = "ida" | "traslado" | "descarga" | "regreso";

/** Un tramo concreto: su clase y su posición dentro de esa clase, en el
 *  recorrido que se está dibujando (`ida`/`descarga`: número de viaje desde 0;
 *  `traslado`: salto dentro del recorrido; `regreso`: siempre 0). */
export interface TramoDeMapa {
  tipo: TipoTramo;
  indice: number;
}

/** Cómo se dibuja cada tramo cuando el recorrido tiene color propio: mismo
 *  color, distinto peso y transparencia.
 *
 *  - ida: pleno, sale vacío del patio.
 *  - traslado: algo más tenue, es el camión cargando entre zonas.
 *  - descarga: **el más grueso**, es el único tramo que se hace cargado.
 *  - regreso: el más tenue, vuelve vacío y es el que menos hay que leer. */
export const ESTILO_TRAMO: Record<TipoTramo, { opacity: number; weight: number }> = {
  ida: { opacity: 1, weight: 5 },
  traslado: { opacity: 0.6, weight: 5 },
  descarga: { opacity: 1, weight: 8 },
  regreso: { opacity: 0.35, weight: 5 },
};
