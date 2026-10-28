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
 * Va en rótulos y frases, donde el relleno estorba: la capacidad de una tolva
 * es "10 m³" y no "10,00 m³", pero el balde del minicargador sigue siendo
 * "0,5 m³".
 */
export function cifra(n: number): string {
  return n.toLocaleString(LOCALE, { maximumFractionDigits: 2 });
}

/**
 * Una magnitud redondeada al entero, con separador de miles.
 *
 * **Es la que va en las columnas de los LISTADOS.** Ahí lo que se hace es
 * barrer filas comparando órdenes de magnitud, y los decimales son ruido: en
 * una columna de `7.498,67` / `53.176,59` / `2.169.169` lo único que se lee de
 * un vistazo es cuántos dígitos tiene cada una, y los centímetros cúbicos no
 * cambian ninguna decisión. El detalle con decimales está en la vista de
 * análisis, que es donde se mira una zona de cerca.
 *
 * Las tres resumidas, para no tener que volver acá:
 *
 * | Dónde                         | Función              | 7498.67 sale como |
 * |-------------------------------|----------------------|-------------------|
 * | Columna de un listado, KPI    | `entero()`           | `7.499`           |
 * | Métricas de la vista análisis | `volumen()`/`area()` | `7.498,67`        |
 * | Un rótulo en una frase        | `cifra()`            | `7.498,67`        |
 */
export function entero(n: number): string {
  return numero(n, 0);
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
