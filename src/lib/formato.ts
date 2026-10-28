/**
 * Formato de cifras en español, en un solo lugar.
 *
 * El sistema está en español y la municipalidad lee cifras chilenas: **miles
 * con punto y decimales con coma**. Las tablas imprimían el número crudo de
 * JavaScript, así que un volumen de `7498.67` m³ y un peso de `2169169` kg
 * salían como una tira de dígitos sin agrupar. No es un detalle estético: sin
 * separador de miles, 2169169 y 216916 se ven casi iguales, y confundir un
 * orden de magnitud en el peso de una zona cambia qué camión se despacha.
 *
 * **Centralizado y no `toLocaleString("es-CL")` repetido en cada celda.** Ya
 * había seis llamadas sueltas, cada una con sus propias opciones, así que el
 * mismo dato se imprimía con dos decimales en un lugar y sin ninguno en otro.
 * Mismo criterio que `volumeReport.ts` con la aritmética: si cada vista
 * formatea lo suyo, la misma cifra se lee distinto según dónde se mire.
 *
 * La unidad **no** va acá: vive en el encabezado de la columna o al lado del
 * número, nunca repetida por fila.
 */

const LOCALE = "es-CL";

/** Un número con una cantidad fija de decimales. */
export function numero(n: number, decimales = 0): string {
  return n.toLocaleString(LOCALE, {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  });
}

/** Volumen en m³, dos decimales.
 *
 *  Dos y no más: es la precisión con que `volumeCalc.py` entrega el dato y con
 *  la que `zoneTotals()` lo redondea, así que agregar decimales mostraría
 *  ceros inventados. */
export function volumen(n: number): string {
  return numero(n, 2);
}

/** Peso en kg, sin decimales.
 *
 *  Un gramo no cambia ninguna decisión, y `zoneTotals()` ya lo redondea a
 *  entero antes de que llegue acá. */
export function peso(n: number): string {
  return numero(n, 0);
}

/** Área en m², dos decimales, igual que el volumen. */
export function area(n: number): string {
  return numero(n, 2);
}

/**
 * Una cifra para texto corrido: hasta dos decimales, sin ceros de relleno.
 *
 * **Cuándo usar esta y cuándo `volumen()`**, que es la única distinción que
 * hay que recordar:
 *
 * - `volumen()` fija dos decimales y va en las COLUMNAS de una tabla, donde lo
 *   que importa es que las cifras se alineen verticalmente. "10,00" sobre
 *   "6,94" se compara de un vistazo; "10" sobre "6,94" no.
 * - `cifra()` va en rótulos y frases, donde el relleno estorba: la capacidad de
 *   una tolva es "10 m³" y no "10,00 m³", pero el balde del minicargador sigue
 *   siendo "0,5 m³".
 */
export function cifra(n: number): string {
  return n.toLocaleString(LOCALE, { maximumFractionDigits: 2 });
}

/**
 * Una cifra formateada, o el guion de "sin dato" cuando no hay número.
 *
 * Existe porque media docena de tablas tienen que distinguir un cero real de
 * un dato que no existe (una zona sin vuelo no tiene volumen, no tiene volumen
 * cero), y escribir ese ternario en cada celda es donde una de ellas termina
 * imprimiendo "0" por un lugar vacío.
 */
export function cifraOGuion(
  n: number | null | undefined,
  formato: (valor: number) => string = numero,
): string {
  return n == null ? "-" : formato(n);
}
