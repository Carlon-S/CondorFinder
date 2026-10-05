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
// Cada par regular/fill reemplaza el viejo truco de opacidad para distinguir
// "activo" de "no activo": la silueta hueca YA se lee como "sin marcar" y la
// rellena como "marcado". Son dibujos genuinamente distintos, no el mismo
// dibujo con relleno distinto, que a 14 px se pierde.
// =============================================================================

/** Zonas de basural (HDU5): gota con el círculo de "precisión". */
export const ZONE_PIN_REGULAR =
  "M128,64a40,40,0,1,0,40,40A40,40,0,0,0,128,64Zm0,64a24,24,0,1,1,24-24A24,24,0,0,1,128,128Zm0-112a88.1,88.1,0,0,0-88,88c0,31.4,14.51,64.68,42,96.25a254.19,254.19,0,0,0,41.45,38.3,8,8,0,0,0,9.18,0A254.19,254.19,0,0,0,174,200.25c27.45-31.57,42-64.85,42-96.25A88.1,88.1,0,0,0,128,16Zm0,206c-16.53-13-72-60.75-72-118a72,72,0,0,1,144,0C200,161.23,144.53,209,128,222Z";
export const ZONE_PIN_FILL =
  "M128,16a88.1,88.1,0,0,0-88,88c0,75.3,80,132.17,83.41,134.55a8,8,0,0,0,9.18,0C136,236.17,216,179.3,216,104A88.1,88.1,0,0,0,128,16Zm0,56a32,32,0,1,1-32,32A32,32,0,0,1,128,72Z";

/** Puntos de partida y destino (HDU6): gota con una cruz. Un pin distinto al
 *  de zona, en vez de reusar la misma familia, porque es otra cosa: un lugar
 *  desde el que sale la flota, no un basural que se retira. */
export const ORIGIN_PIN_REGULAR =
  "M128,16a88.1,88.1,0,0,0-88,88c0,31.4,14.51,64.68,42,96.25a254.19,254.19,0,0,0,41.45,38.3,8,8,0,0,0,9.18,0A254.19,254.19,0,0,0,174,200.25c27.45-31.57,42-64.85,42-96.25A88.1,88.1,0,0,0,128,16Zm0,206c-16.53-13-72-60.75-72-118a72,72,0,0,1,144,0C200,161.23,144.53,209,128,222Zm40-118a8,8,0,0,1-8,8H136v24a8,8,0,0,1-16,0V112H96a8,8,0,0,1,0-16h24V72a8,8,0,0,1,16,0V96h24A8,8,0,0,1,168,104Z";
export const ORIGIN_PIN_FILL =
  "M128,16a88.1,88.1,0,0,0-88,88c0,31.4,14.51,64.68,42,96.25a254.19,254.19,0,0,0,41.45,38.3,8,8,0,0,0,9.18,0A254.19,254.19,0,0,0,174,200.25c27.45-31.57,42-64.85,42-96.25A88.1,88.1,0,0,0,128,16Zm32,96H136v24a8,8,0,0,1-16,0V112H96a8,8,0,0,1,0-16h24V72a8,8,0,0,1,16,0V96h24a8,8,0,0,1,0,16Z";

/** Relleno sanitario (Phosphor "Warehouse"). Tercera cosa distinta: no es un
 *  basural que se retira ni un patio del que sale la flota, es a dónde termina
 *  yendo el material. Por eso va en placa circular y no en gota. */
export const DISPOSAL_PIN =
  "M231.65,194.55,224,164.11V88a16,16,0,0,0-16-16H176V40a16,16,0,0,0-16-16H96A16,16,0,0,0,80,40V72H48A16,16,0,0,0,32,88v76.11L24.35,194.55A8,8,0,0,0,32,204.52V216a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V204.52A8,8,0,0,0,231.65,194.55ZM96,40h64V72H96ZM48,88H208v72H48Zm160,128H48V176H208Z";

/** Tamaños en px. Los tres difieren a propósito: una zona pesa más que un
 *  punto en la lectura del plan del día. */
export const ZONE_PIN_SIZE = 44;
export const ORIGIN_PIN_SIZE = 36;
/** En lockstep con `.disposal-marker__plate` (2rem) en styles.css. */
export const DISPOSAL_PLATE = 32;
