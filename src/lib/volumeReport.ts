// =============================================================================
// CONDORFINDER — ARITMÉTICA DE VOLUMEN COMPARTIDA
// Archivo: src/lib/volumeReport.ts
//
// Vive acá, y no dentro de una vista, porque HDU9 (informe PDF) y HDU10
// (evolución de zona) necesitan exactamente los mismos números y no pueden
// calcularlos cada una por su lado: si difieren aunque sea por redondeo, el
// informe y el gráfico contarían historias distintas de la misma zona.
//
// Mismo patrón que el resto de src/lib: funciones planas, sin clase ni hook.
// =============================================================================

import type { SavedAnalysisRecord, ZoneRecord } from "@/lib/analysisStore";

/** Forma mínima de una detección guardada que a este módulo le interesa. El
 *  registro la trae como `unknown` porque el backend la guarda como blob
 *  opaco; acá se le da forma solo a los campos que se leen. */
interface StoredDetection {
  id?: number;
  class?: string;
  volume_m3?: number | null;
  area_m2?: number | null;
  weight_kg?: number | null;
  /** Ausente en análisis guardados antes de que se persistiera la selección:
   *  en ese caso cuenta como activa, que es como se comportaban. */
  enabled?: boolean;
  /** Desglose por clase de una detección fusionada. Ver repartirPorTipo(). */
  breakdown?: { class: string; volume_m3: number | null }[];
}

function detectionsOf(record: SavedAnalysisRecord): StoredDetection[] {
  return Array.isArray(record.detections) ? (record.detections as StoredDetection[]) : [];
}

/** Las detecciones que cuentan para los totales. Una sin la marca `enabled`
 *  cuenta como activa: es el criterio de compatibilidad con lo guardado antes
 *  de que la selección se persistiera. */
export function activeDetections(record: SavedAnalysisRecord): StoredDetection[] {
  return detectionsOf(record).filter((d) => d.enabled !== false);
}

export interface ZoneTotals {
  volumeM3: number;
  weightKg: number;
  areaM2: number;
  count: number;
}

export function zoneTotals(record: SavedAnalysisRecord): ZoneTotals {
  const activas = activeDetections(record);
  return {
    volumeM3: round2(activas.reduce((s, d) => s + (d.volume_m3 ?? 0), 0)),
    weightKg: Math.round(activas.reduce((s, d) => s + (d.weight_kg ?? 0), 0)),
    areaM2: round2(activas.reduce((s, d) => s + (d.area_m2 ?? 0), 0)),
    count: activas.length,
  };
}

/** Lo retirado de una zona desde que se midió, para descontarlo (pieza 2.5). */
export interface RetiroAcumulado {
  /** m³ retirados en total. */
  totalM3: number;
  /** Fecha del retiro más reciente, en ISO. */
  ultimo: string | null;
  veces: number;
}

/**
 * El volumen que queda HOY en una zona: lo medido menos lo retirado después.
 *
 * **El análisis guardado NUNCA se muta**, y esa es la decisión que sostiene
 * toda la pieza. Un análisis es una medición con su fecha y su
 * `algorithmVersion`; reescribir su volumen porque pasó un camión destruiría la
 * evolución de la zona y rompería la aritmética única de este módulo. El retiro
 * es un EVENTO NUEVO en la línea de tiempo y el volumen actual es una resta que
 * se hace al mostrar, no un dato que se guarda.
 *
 * **Solo se descuentan los retiros POSTERIORES a la medición.** Uno anterior al
 * vuelo ya está reflejado en lo que el dron vio: volver a restarlo contaría dos
 * veces la misma basura que ya no estaba. Por eso hace falta la fecha del
 * último retiro y no alcanza con el total.
 *
 * **No baja de cero.** Si la cuadrilla retiró más de lo que el vuelo midió (la
 * medición quedó corta, o el basural creció entre el vuelo y el retiro), el
 * resultado es cero y no un volumen negativo, que no significa nada. El dato
 * crudo sigue disponible en `medidoM3` para quien quiera ver la diferencia.
 */
export function volumenActual(
  record: SavedAnalysisRecord,
  retirado?: RetiroAcumulado,
): { medidoM3: number; retiradoM3: number; actualM3: number } {
  const medidoM3 = zoneTotals(record).volumeM3;
  if (!retirado || retirado.totalM3 <= 0) {
    return { medidoM3, retiradoM3: 0, actualM3: medidoM3 };
  }
  // La medición es la de la captura, no la de cuándo se guardó el análisis: lo
  // que importa es cuándo se VIO el terreno.
  const medidoEn = record.captureDate ?? record.savedAt;
  const posterior = !retirado.ultimo || !medidoEn || new Date(retirado.ultimo) > new Date(medidoEn);
  if (!posterior) return { medidoM3, retiradoM3: 0, actualM3: medidoM3 };
  return {
    medidoM3,
    retiradoM3: round2(retirado.totalM3),
    actualM3: round2(Math.max(0, medidoM3 - retirado.totalM3)),
  };
}

/**
 * Volumen por tipo de residuo dentro de un análisis.
 *
 * El detalle está en las detecciones fusionadas. Cuando dos detecciones se
 * solapan más del 50%, `mergeOverlapping` (analysis.tsx) las junta en una sola
 * con `class: "Varios tipos"`, y su `volume_m3` es el PROMEDIO o el MÁXIMO del
 * grupo, nunca la suma: justamente para no contar dos veces la misma basura
 * vista por dos detecciones distintas.
 *
 * Por eso no se puede sumar el `breakdown` tal cual. En una zona fusionada de
 * 10 m³ cuyo desglose mide 8 de orgánico y 4 de metal, sumar daría 12 y el
 * detalle por tipo excedería el total de la zona, que es exactamente lo que la
 * fusión existe para evitar.
 *
 * Se reparte el volumen ya consolidado entre las clases del grupo según el
 * peso relativo de cada una dentro del desglose. En el ejemplo: 6.67 de
 * orgánico y 3.33 de metal, que suman los 10 reales. Para una detección de una
 * sola clase el reparto es trivial y no cambia nada.
 */
export function volumeByWasteType(record: SavedAnalysisRecord): Map<string, number> {
  const porTipo = new Map<string, number>();

  for (const det of activeDetections(record)) {
    const total = det.volume_m3 ?? 0;
    if (total === 0) continue;

    const desglose = det.breakdown ?? [];
    const sumaDesglose = desglose.reduce((s, b) => s + (b.volume_m3 ?? 0), 0);

    if (desglose.length === 0 || sumaDesglose <= 0) {
      // Sin desglose utilizable, todo va a la clase de la detección. Cubre
      // tanto las detecciones de una sola clase como los registros viejos.
      acumular(porTipo, det.class ?? "Sin clasificar", total);
      continue;
    }

    for (const parte of desglose) {
      const proporcion = (parte.volume_m3 ?? 0) / sumaDesglose;
      acumular(porTipo, parte.class, total * proporcion);
    }
  }

  for (const [tipo, valor] of porTipo) porTipo.set(tipo, round2(valor));
  return porTipo;
}

function acumular(mapa: Map<string, number>, clave: string, valor: number): void {
  mapa.set(clave, (mapa.get(clave) ?? 0) + valor);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── versiones y evolución ──────────────────────────────────────────────────

/** Una versión es un vuelo: un set de imágenes, un mapa unificado, y los
 *  análisis que se hicieron sobre él. */
export interface ZoneVersion {
  /** Tarea que generó el mapa. Es la identidad de la versión. */
  sourceTaskId: string;
  mapUrl: string;
  thumbnailUrl?: string | null;
  captureDate: string | null;
  captureDateEstimated: boolean;
  /** Cuándo entró este vuelo al sistema. Es lo que desempata dos versiones con
   *  la misma fecha de captura, y por eso además se MUESTRA: volver a subir el
   *  mismo set de imágenes produce dos versiones con idéntica `captureDate`, y
   *  sin la hora son indistinguibles en pantalla aunque el sistema las ordene
   *  bien. */
  uploadedAt: string | null;
  /** Análisis de esta versión, del más antiguo al más reciente. */
  analyses: SavedAnalysisRecord[];
}

/** Cómo se nombra una captura en pantalla: fecha y, cuando se sabe, la hora en
 *  que entró al sistema.
 *
 *  Vive acá y no en cada vista por la misma razón que el resto de este archivo:
 *  la barra de capturas, el gráfico de evolución y el informe tienen que
 *  nombrar la misma captura igual, o parecerían tres cosas distintas.
 *
 *  La zona horaria va EXPLÍCITA, igual que en la línea de tiempo de las rutas:
 *  las capturas son de vuelos sobre Maipú y la hora tiene que ser la de Maipú
 *  aunque el equipo que mira esté configurado en otra. */
export function versionLabel(
  captureDate: string | null | undefined,
  uploadedAt?: string | null,
): string {
  const d = captureDate ? new Date(captureDate) : null;
  const fecha =
    d && !Number.isNaN(d.getTime())
      ? d.toLocaleDateString("es-CL", { timeZone: "America/Santiago" })
      : "sin fecha";

  const u = uploadedAt ? new Date(uploadedAt) : null;
  if (!u || Number.isNaN(u.getTime())) return fecha;

  return `${fecha} · ${versionTime(uploadedAt)}`;
}

/** Solo la hora de subida, en 24 horas.
 *
 *  `hour12: false` explícito: `es-CL` devuelve "11:16 p. m." según el runtime,
 *  que son once caracteres donde "23:16" son cinco, y además Chile escribe la
 *  hora en 24. En el eje de un gráfico esa diferencia decide si la etiqueta
 *  entra o se recorta.
 *
 *  Se expone aparte porque cuando todas las capturas de una zona son del mismo
 *  día, repetir la fecha en cada marca del eje es ruido: la fecha ya está en la
 *  cabecera. */
export function versionTime(uploadedAt: string | null | undefined): string {
  const u = uploadedAt ? new Date(uploadedAt) : null;
  if (!u || Number.isNaN(u.getTime())) return "";
  return u.toLocaleTimeString("es-CL", {
    timeZone: "America/Santiago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** La fecha de una captura sin la hora, para comparar si dos son del mismo día. */
export function versionDay(captureDate: string | null | undefined): string {
  const d = captureDate ? new Date(captureDate) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("es-CL", { timeZone: "America/Santiago" });
}

/** Fecha con la que se ordena una versión. Prioriza la captura; si falta, cae
 *  a la de guardado, que es lo único disponible en los registros viejos. */
function orderKey(record: SavedAnalysisRecord): number {
  const captura = record.captureDate ? Date.parse(record.captureDate) : NaN;
  if (!Number.isNaN(captura)) return captura;
  return Date.parse(record.savedAt);
}

/** Desempate cuando dos versiones comparten fecha de captura: manda cuál se
 *  cargó primero. */
function tieKey(record: SavedAnalysisRecord): number {
  const carga = record.uploadedAt ? Date.parse(record.uploadedAt) : NaN;
  return Number.isNaN(carga) ? Date.parse(record.savedAt) : carga;
}

/**
 * Agrupa los análisis de una zona en versiones, ordenadas cronológicamente.
 *
 * La versión sale de `sourceTaskId`: un vuelo produce una tarea y una tarea
 * produce un mapa. Los análisis sin esa referencia (guardados antes de que
 * existiera) cuentan como versión propia, porque no hay forma de saber con
 * cuál compartían vuelo.
 */
export function buildVersions(analyses: SavedAnalysisRecord[]): ZoneVersion[] {
  const porVersion = new Map<string, SavedAnalysisRecord[]>();

  for (const a of analyses) {
    const clave = a.sourceTaskId || `sin-tarea:${a.id}`;
    const lista = porVersion.get(clave);
    if (lista) lista.push(a);
    else porVersion.set(clave, [a]);
  }

  const versiones: ZoneVersion[] = [];
  for (const [sourceTaskId, lista] of porVersion) {
    const ordenados = [...lista].sort((a, b) => Date.parse(a.savedAt) - Date.parse(b.savedAt));
    const referencia = ordenados[0];
    versiones.push({
      sourceTaskId,
      mapUrl: referencia.mapUrl,
      thumbnailUrl: referencia.thumbnailUrl,
      captureDate: referencia.captureDate ?? null,
      captureDateEstimated: referencia.captureDateEstimated ?? true,
      // Si el registro no la trae (los anteriores a este campo), se cae a
      // cuándo se guardó el análisis: es lo mismo que usa tieKey() para
      // ordenar, así que lo que se muestra y lo que decide el orden coinciden.
      uploadedAt: referencia.uploadedAt ?? referencia.savedAt ?? null,
      analyses: ordenados,
    });
  }

  return versiones.sort((a, b) => {
    const diff = orderKey(a.analyses[0]) - orderKey(b.analyses[0]);
    return diff !== 0 ? diff : tieKey(a.analyses[0]) - tieKey(b.analyses[0]);
  });
}

/** Los análisis de una zona, agrupados en versiones y ordenados en el tiempo. */
export function zoneHistory(zone: ZoneRecord, analyses: SavedAnalysisRecord[]): ZoneVersion[] {
  return buildVersions(analyses.filter((a) => a.zoneId === zone.id));
}

/**
 * Puntos para el gráfico de evolución: uno por análisis que aportó algo nuevo.
 *
 * Los marcados "sin-cambios" repiten la cifra anterior por construcción (mismo
 * vuelo, misma selección, mismo algoritmo), así que dibujarlos agregaría
 * puntos superpuestos que parecen un error de datos. Se omiten, pero se cuenta
 * cuántos había detrás de cada punto para poder decirlo en la interfaz.
 */
export interface EvolutionPoint {
  date: string;
  /** Hora de subida de la versión a la que pertenece. Se arrastra hasta acá
   *  para que el eje del gráfico pueda distinguir dos capturas del mismo set de
   *  imágenes, que comparten `date` exacta. */
  uploadedAt: string | null;
  volumeM3: number;
  analysisId: string;
  sourceTaskId: string;
  algorithmVersion: number | null;
  /** Análisis idénticos que este punto representa, además de sí mismo. */
  repeated: number;
  /** De dónde salió la cifra (pieza 2.5 de HDU5.2).
   *
   *  **Un retiro y una medición son el MISMO tipo de dato**: los dos dicen
   *  cuánto volumen había en un lugar en una fecha, y van a la misma línea de
   *  tiempo. Lo que los distingue es quién lo contó, uno el dron y el otro la
   *  cuadrilla, y eso hay que decirlo porque cambia cuánta confianza merece la
   *  cifra. Ausente significa `medicion`, que es lo que eran todos los puntos
   *  antes de que existieran los retiros. */
  origen?: "medicion" | "retiro";
}

/** Un retiro registrado, en lo mínimo que la serie necesita de él. */
export interface RetiroDeZona {
  fecha: string;
  /** Lo que salió. `null` cuando nadie lo midió, y en ese caso el retiro **no
   *  entra a la serie**: un punto sin cifra no se puede dibujar, y poner un 0
   *  afirmaría que el camión se fue vacío. */
  volumenRetiradoM3: number | null;
}

/** La serie del gráfico: las mediciones y, opcionalmente, los retiros.
 *
 *  **Los retiros se dibujan como lo que QUEDÓ, no como lo que salió**, que es
 *  la única forma de que convivan en el mismo eje: el eje es "cuánto hay en
 *  este lugar", así que un retiro de 8 m³ sobre una medición de 20 es un punto
 *  en 12 y no un punto en 8. Dibujar lo retirado haría que limpiar un basural
 *  pareciera llenarlo.
 *
 *  Es lo que le da historial de volumen a los 54 puntos permanentes sin
 *  volarle el dron a ninguno: un lugar sin mediciones pero con retiros tiene
 *  una serie, aunque arranque sin línea de base.
 */
export function evolutionSeries(
  versions: ZoneVersion[],
  retiros?: RetiroDeZona[],
): EvolutionPoint[] {
  const puntos: EvolutionPoint[] = [];

  for (const version of versions) {
    for (const analysis of version.analyses) {
      if (analysis.changeKind === "sin-cambios" && puntos.length > 0) {
        puntos[puntos.length - 1].repeated += 1;
        continue;
      }
      puntos.push({
        date: analysis.captureDate ?? analysis.savedAt,
        // La hora de la VERSIÓN, no la del análisis: el eje del gráfico nombra
        // capturas, y dos análisis del mismo vuelo son el mismo punto en el
        // tiempo aunque se hayan calculado en momentos distintos.
        uploadedAt: version.uploadedAt,
        volumeM3: zoneTotals(analysis).volumeM3,
        analysisId: analysis.id,
        sourceTaskId: version.sourceTaskId,
        algorithmVersion: analysis.algorithmVersion ?? null,
        repeated: 0,
        origen: "medicion",
      });
    }
  }

  if (!retiros || retiros.length === 0) return puntos;

  // **Las dos listas se MEZCLAN y después se recorre una sola vez**, arrastrando
  // cuánto queda. Se intentó al revés, buscando para cada retiro el punto
  // anterior más cercano, y estaba mal de una forma que solo aparece con dos
  // retiros separados por un vuelo: los retiros se iban agregando al final del
  // arreglo en vez de en su lugar, así que la búsqueda encontraba un retiro
  // viejo como si fuera lo último ocurrido. Con mediciones en 20 y 30 y retiros
  // de 15 y 10, el último punto daba 0 en vez de 20.
  //
  // Un retiro sin cifra no entra: `null` significa que nadie lo midió, y
  // tratarlo como 0 afirmaría que el camión se fue vacío. Uno en cero tampoco,
  // porque no mueve la curva y agregaría un punto encima del anterior.
  const utilizables = retiros.filter(
    (r) => r.volumenRetiradoM3 != null && r.volumenRetiradoM3 > 0 && r.fecha,
  );

  type Item = { t: number; punto?: EvolutionPoint; retiro?: RetiroDeZona };
  const mezcla: Item[] = [
    ...puntos.map((p): Item => ({ t: new Date(p.date).getTime(), punto: p })),
    ...utilizables.map((r): Item => ({ t: new Date(r.fecha).getTime(), retiro: r })),
  ];
  // En un empate exacto de fecha manda la MEDICIÓN: si el dron voló el mismo
  // día que pasó el camión, lo que el dron vio ya incluye el retiro, así que
  // descontarlo otra vez sería contarlo dos veces.
  mezcla.sort((a, b) => a.t - b.t || (a.punto ? -1 : 1));

  const serie: EvolutionPoint[] = [];
  // `null` mientras no haya habido ninguna medición. No es 0: un lugar sin
  // medir no es un lugar vacío.
  let queda: number | null = null;

  for (const item of mezcla) {
    if (item.punto) {
      // **Una medición vuelve a FIJAR la cifra**, no la ajusta. El dron ve lo
      // que hay hoy, así que todo lo retirado antes ya está descontado en lo
      // que vio: seguir arrastrando el acumulado lo restaría dos veces.
      queda = item.punto.volumeM3;
      serie.push(item.punto);
      continue;
    }
    const retiro = item.retiro!;
    // Sin medición previa no hay de dónde descontar, y se dibuja en 0: la
    // cuadrilla pasó y se llevó algo, y omitirlo dejaría a un punto permanente
    // sin ninguna línea de tiempo, que es justo lo que esto vino a dar.
    queda = queda == null ? 0 : Math.max(0, round2(queda - (retiro.volumenRetiradoM3 ?? 0)));
    serie.push({
      date: retiro.fecha,
      uploadedAt: null,
      volumeM3: queda,
      // No es un análisis: no tiene id que abrir, y el gráfico no lo ofrece.
      analysisId: "",
      sourceTaskId: "",
      // `null` y no una versión inventada: un retiro no lo calculó ningún
      // algoritmo, así que no puede disparar el aviso de algoritmos mezclados.
      algorithmVersion: null,
      repeated: 0,
      origen: "retiro",
    });
  }

  return serie;
}

/** true si la serie mezcla análisis calculados con algoritmos distintos. En ese
 *  caso un salto de volumen puede venir de la medición y no del terreno, y
 *  tanto el gráfico como el informe tienen que advertirlo: atribuir a una
 *  limpieza un cambio que en realidad fue de precisión es peor que no informar
 *  nada. */
export function hasMixedAlgorithms(points: EvolutionPoint[]): boolean {
  const versiones = new Set(points.map((p) => p.algorithmVersion ?? 0));
  return versiones.size > 1;
}
