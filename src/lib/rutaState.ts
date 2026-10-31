// =============================================================================
// CONDORFINDER — LO QUE HAY CARGADO EN LA VISTA DE RUTAS
// Archivo: src/lib/rutaState.ts
//
// Las paradas cargadas, los volúmenes declarados y las marcas de prioritaria,
// para que un F5 no los pierda.
//
// -----------------------------------------------------------------------------
// POR QUÉ `sessionStorage` Y NO MONGO
// -----------------------------------------------------------------------------
// Un plan NO se persiste en el servidor, y eso es deliberado: persistirlo es
// exactamente C5 y C6 de HDU5.2 (editar una ruta guardada y el historial), que
// son Fase 2 y traen su propia colección, su máquina de estados y la decisión
// de si editar recalcula o reescribe el registro.
//
// Pero perder diez paradas recién cargadas por un F5 accidental es fricción sin
// ninguna ventaja, y el proyecto ya tiene el patrón para eso: un envoltorio
// chico por asunto en `src/lib/`, como `imageState.ts` o `mapState.ts`. Esto es
// lo que una PESTAÑA estaba a punto de hacer, no un registro de lo que se hizo.
//
// `sessionStorage` y no `localStorage` a propósito, al revés que `crewState.ts`:
// una cuadrilla se repite entre semanas, pero lo que se está por rutear hoy es
// de esta sesión. Dos pestañas abiertas sobre dos planes distintos no deben
// pisarse, que es justo lo que `localStorage` haría.
//
// **Los volúmenes declarados se guardan.** Se evaluó no hacerlo, con el
// argumento de que una cifra declarada es una decisión del día; pero esa
// objeción vale para guardarla como ATRIBUTO DE LA ZONA en Mongo, no para
// recordarla en la pestaña donde se tecleó. Sin ellos, un F5 devolvía las
// paradas con los campos vacíos y el botón de generar bloqueado, que es peor
// que perderlo todo porque parece que el sistema olvidó a medias.
// =============================================================================

const isBrowser = typeof window !== "undefined";

const KEY = "condorfinder:ruta-cargada";

/** Lo que una pestaña tiene cargado en `/rutas`. */
export interface RutaCargada {
  /** Ids de análisis guardados cargados a la ruta. */
  analisis: string[];
  /** Ids de puntos diarios cargados a la ruta. */
  diarios: string[];
  /** Volumen declarado por parada, por id, tal como se tecleó. */
  volumenes: Record<string, string>;
  /** Ids marcados como prioritarios. */
  prioritarias: string[];
}

const VACIO: RutaCargada = { analisis: [], diarios: [], volumenes: {}, prioritarias: [] };

export function guardarRutaCargada(estado: RutaCargada): void {
  if (!isBrowser) return;
  try {
    // Nada que recordar: se borra en vez de guardar un objeto vacío, así el
    // caso "no hay nada cargado" y el caso "nunca se usó esta vista" son el
    // mismo, que es lo que son.
    const vacio =
      estado.analisis.length === 0 &&
      estado.diarios.length === 0 &&
      estado.prioritarias.length === 0 &&
      Object.keys(estado.volumenes).length === 0;
    if (vacio) {
      sessionStorage.removeItem(KEY);
      return;
    }
    sessionStorage.setItem(KEY, JSON.stringify(estado));
  } catch {
    // Modo privado, cuota llena, o el navegador con el almacenamiento
    // bloqueado. Perder el recordatorio es molesto; tumbar la vista por no
    // poder guardarlo sería peor, y la vista funciona igual sin esto.
  }
}

/** Lo guardado, o todo vacío si no hay nada utilizable.
 *
 *  **Tolera basura sin reventar.** Lo que vuelve es JSON escrito por una
 *  versión anterior de la vista, o por otra pestaña, así que cada campo se
 *  valida por separado: con un `JSON.parse` a secas, un formato viejo dejaría
 *  `/rutas` sin montar hasta que alguien limpiara el almacenamiento a mano.
 */
export function cargarRutaCargada(): RutaCargada {
  if (!isBrowser) return VACIO;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return VACIO;
    const data = JSON.parse(raw) as Partial<RutaCargada>;
    const textos = (xs: unknown): string[] =>
      Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string") : [];
    const volumenes: Record<string, string> = {};
    if (data.volumenes && typeof data.volumenes === "object") {
      for (const [k, v] of Object.entries(data.volumenes)) {
        if (typeof v === "string") volumenes[k] = v;
      }
    }
    return {
      analisis: textos(data.analisis),
      diarios: textos(data.diarios),
      volumenes,
      prioritarias: textos(data.prioritarias),
    };
  } catch {
    return VACIO;
  }
}

export function limpiarRutaCargada(): void {
  if (!isBrowser) return;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Ver guardarRutaCargada.
  }
}
