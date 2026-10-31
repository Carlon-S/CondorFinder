// =============================================================================
// CONDORFINDER — DIBUJOS DE LOS MARCADORES DEL MAPA
// Archivo: src/components/map-pins.ts
//
// Los trazados SVG viven acá y no dentro de una implementación de mapa porque
// hay DOS: Leaflet (GeoMapImpl.tsx) y Google (GoogleMapImpl.tsx). Con una copia
// en cada una, cambiar un pin en la que uno está mirando dejaría a la otra con
// el dibujo viejo, y el que se usa depende de una variable de entorno, así que
// la divergencia solo aparecería en producción. Mismo criterio que
// route-colors.ts.
//
// -----------------------------------------------------------------------------
// LA GOTA ES UNA Y EL GLIFO ES LO QUE CAMBIA
// -----------------------------------------------------------------------------
// Antes había un par regular/fill por clase de marcador, y "no participa" se
// dibujaba con la silueta HUECA. Se eliminó: un contorno sin relleno sobre los
// tiles de OpenStreetMap es casi imperceptible, que es justo lo contrario de lo
// que un marcador tiene que hacer, y con 54 puntos del catastro en pantalla el
// problema deja de ser teórico. Hoy **todos los marcadores son sólidos** y lo
// que los distingue son dos cosas a la vez, nunca una sola:
//
//   1. el GLIFO blanco en el centro de la gota, y
//   2. el COLOR de la gota.
//
// Las dos juntas y no solo el color, porque un cambio de color sobre el mismo
// dibujo se pierde a 14 px y desaparece para quien no distingue ese par de
// tonos. Es la misma regla que ya rige para la estrella de prioritaria (relleno
// contra contorno) y para las columnas ordenables de Vista Principal.
//
//   dot      zona con vuelo, o sea un basural MEDIDO
//   dash     zona sin vuelo: el lugar está registrado y no tiene medición
//   cruz     punto de origen: el patio del que sale la flota
//   triangulo retiro del día (HDU15)
//
// El relleno sanitario queda fuera de esta familia a propósito: no es una gota
// sino una placa circular con su nombre impreso, porque es infraestructura fija
// y no un lugar del plan del día. Ver `.disposal-marker` en styles.css.
// =============================================================================

/** La gota, sólida y sin agujero, común a los cuatro marcadores de lugar.
 *
 *  El glifo va encima como un `<path>` aparte en blanco, en vez de calado en el
 *  mismo trazado. Es deliberado: un agujero depende de la regla de relleno y de
 *  que los subtrazados vayan en sentidos opuestos, así que agregar una clase
 *  nueva obligaba a dibujar a mano un contorno inverso. Con dos paths, agregar
 *  una clase es agregar un glifo. */
export const PIN_GOTA =
  "M128,16a88.1,88.1,0,0,0-88,88c0,31.4,14.51,64.68,42,96.25a254.19,254.19,0,0,0,41.45,38.3,8,8,0,0,0,9.18,0A254.19,254.19,0,0,0,174,200.25c27.45-31.57,42-64.85,42-96.25A88.1,88.1,0,0,0,128,16Z";

/** Punto: un basural con vuelo, o sea con volumen medido. */
export const GLIFO_MEDIDA = "M101,100a27,27,0,1,1,54,0a27,27,0,1,1-54,0Z";

/** Raya: el lugar está registrado pero nadie lo midió. Un guion es lo que este
 *  sistema ya usa para "sin dato" en las tablas (ver `SinDato` en index.tsx),
 *  así que el mapa dice lo mismo con el mismo signo. */
export const GLIFO_SIN_DATO = "M110,89h36a11,11,0,0,1,0,22h-36a11,11,0,0,1,0-22Z";

/** Cruz: el patio del que sale la flota. Dos rectángulos superpuestos en el
 *  mismo sentido, que con la regla de relleno por defecto se unen. */
export const GLIFO_ORIGEN = "M117,67h22v66h-22Z M95,89h66v22h-66Z";

/** Triángulo: un retiro del día. Es el signo de los conos y las señales de
 *  obra, que es de lo que habla esa tabla (escombros y extras). */
export const GLIFO_DIARIO = "M128,70l32,56h-64Z";

/** Relleno sanitario (Phosphor "Warehouse"), dentro de su placa circular. */
export const DISPOSAL_PIN =
  "M231.65,194.55,224,164.11V88a16,16,0,0,0-16-16H176V40a16,16,0,0,0-16-16H96A16,16,0,0,0,80,40V72H48A16,16,0,0,0,32,88v76.11L24.35,194.55A8,8,0,0,0,32,204.52V216a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V204.52A8,8,0,0,0,231.65,194.55ZM96,40h64V72H96ZM48,88H208v72H48Zm160,128H48V176H208Z";

// -----------------------------------------------------------------------------
// COLORES
// -----------------------------------------------------------------------------
// Literales y no `var(--token)`: los marcadores de Leaflet son `L.divIcon`, o
// sea DOM real, donde una variable CSS sí funciona, pero los de Google se
// arman como SVG en JSX y conviene que las dos implementaciones usen
// exactamente el mismo valor. Es además el mismo criterio de route-colors.ts.

/** Punto de origen. **Rojo**, pedido explícito: es el único marcador que
 *  representa un recurso de la municipalidad y no un lugar que hay que limpiar,
 *  así que es el que tiene que saltar primero a la vista. */
export const COLOR_ORIGEN = "#DC2626";

/** Punto de origen inactivo. Gris y SÓLIDO, no hueco: "no participa" se dice
 *  con el color, no con la transparencia. */
export const COLOR_INACTIVO = "#94A3B8";

/** Zona con vuelo que todavía no se cargó a la ruta. El navy de la marca, que
 *  quedó libre cuando los puntos de origen pasaron a rojo. Dice "el sistema
 *  tiene datos de este lugar". */
export const COLOR_ZONA_MEDIDA = "#0F2244";

/** Zona registrada sin ningún vuelo. Gris, como el guion de "sin dato". */
export const COLOR_SIN_VUELO = "#64748B";

/** Retiro del día (HDU15). */
export const COLOR_DIARIO = "#F59E0B";

// -----------------------------------------------------------------------------
// TAMAÑOS
// -----------------------------------------------------------------------------

/** Tamaños base en px, al zoom de calle. Una zona pesa más que un punto en la
 *  lectura del plan del día, así que su gota es más grande. */
export const ZONE_PIN_SIZE = 44;
export const ORIGIN_PIN_SIZE = 38;
/** En lockstep con `.disposal-marker__plate` (2rem) en styles.css. */
export const DISPOSAL_PLATE = 32;

/** Cuánto encoger los marcadores según el zoom, para que no se solapen.
 *
 *  **El problema que resuelve es real y medible**: con los 54 puntos del
 *  catastro, las zonas medidas, los puntos de origen y los retiros del día, al
 *  zoom de toda la comuna las gotas de 44 px se pisan unas a otras y la pantalla
 *  deja de decir dónde está cada cosa. A tamaño fijo solo hay dos salidas malas:
 *  un marcador chico que no se lee de cerca, o uno grande que tapa a sus
 *  vecinos de lejos.
 *
 *  La escala va de 0,55 a 1: a zoom 11 (la comuna entera cabe en pantalla) un
 *  pin de zona mide 24 px, y a zoom 17 o más (una cuadra) mide los 44 px
 *  completos. Los extremos están elegidos contra el uso: 11 es el zoom al que
 *  abre `/rutas` y 17 es el que deja el `focusPoint` al apretar una zona.
 *
 *  **Interpolación lineal y no por tramos**: Leaflet y Google permiten zoom
 *  fraccionario al hacer pinch o al animar un vuelo, así que una tabla de
 *  tamaños por nivel entero haría saltar los marcadores a mitad del
 *  desplazamiento. */
export function escalaPorZoom(zoom: number): number {
  const t = Math.min(1, Math.max(0, (zoom - 11) / 6));
  return 0.55 + 0.45 * t;
}

/** El tamaño ya escalado, redondeado a px entero.
 *
 *  Entero porque un `width` fraccionario en un SVG de 24 px deja el glifo
 *  borroso, y el glifo es la mitad de lo que distingue un marcador de otro. */
export function tamanoDePin(base: number, zoom: number): number {
  return Math.round(base * escalaPorZoom(zoom));
}
