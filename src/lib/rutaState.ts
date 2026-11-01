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
// Un plan GENERADO sí se persiste, desde la Fase 2: vive en la colección
// `route_plans` con su máquina de estados, y es lo que C5 y C6 de HDU5.2 piden.
// Esto es otra cosa, y por eso sigue existiendo: lo que una PESTAÑA está A PUNTO
// de generar, que todavía no es un plan y no tiene por qué ocupar la base.
//
// Perder diez paradas recién cargadas por un F5 accidental es fricción sin
// ninguna ventaja, y el proyecto ya tiene el patrón para eso: un envoltorio
// chico por asunto en `src/lib/`, como `imageState.ts` o `mapState.ts`.
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
  /** El plan guardado que se está EDITANDO, si se entró desde el historial
   *  (C5 de HDU5.2).
   *
   *  **Editar una ruta es regenerarla**, así que el camino es: el historial
   *  escribe acá las paradas y los volúmenes del plan guardado, `/rutas` los
   *  restaura con el mismo mecanismo de siempre, y al generar manda este id
   *  para que el backend REEMPLACE el registro en vez de crear uno nuevo.
   *
   *  Vive en el mismo lugar que el resto de lo cargado porque es lo mismo: el
   *  estado de esta pestaña. Con una clave aparte habría dos cosas que limpiar
   *  al descargar las paradas, y olvidar una dejaría a `/rutas` reemplazando un
   *  plan que el trabajador ya no está editando. */
  editandoPlanId?: string | null;
  /** Las horas de jornada con que se generó, tal como se tecleó.
   *
   *  **Se restaura solo al EDITAR un plan guardado**, y es necesario: las horas
   *  son lo que decide cuántos viajes entran, así que reabrir una ruta de 10
   *  horas con el 8 por omisión la regeneraría más corta sin que nada lo dijera,
   *  y el trabajador vería desaparecer paradas que él no quitó. */
  horas?: string | null;
  /** Cuántos convoyes por punto se usaron, por el mismo motivo que `horas`. */
  convoyes?: number | null;
}

const VACIO: RutaCargada = {
  analisis: [],
  diarios: [],
  volumenes: {},
  prioritarias: [],
  editandoPlanId: null,
  horas: null,
  convoyes: null,
};

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
      !estado.editandoPlanId &&
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
      editandoPlanId: typeof data.editandoPlanId === "string" ? data.editandoPlanId : null,
      horas: typeof data.horas === "string" ? data.horas : null,
      // Se acota al rango que el selector ofrece: un valor fuera de rango vino
      // de otra versión de la vista y el backend lo iba a recortar igual, así
      // que es mejor que la pantalla muestre lo que de verdad se va a usar.
      convoyes:
        typeof data.convoyes === "number" && data.convoyes >= 1 && data.convoyes <= 4
          ? Math.round(data.convoyes)
          : null,
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
