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
  /** Análisis de esta versión, del más antiguo al más reciente. */
  analyses: SavedAnalysisRecord[];
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
  volumeM3: number;
  analysisId: string;
  sourceTaskId: string;
  algorithmVersion: number | null;
  /** Análisis idénticos que este punto representa, además de sí mismo. */
  repeated: number;
}

export function evolutionSeries(versions: ZoneVersion[]): EvolutionPoint[] {
  const puntos: EvolutionPoint[] = [];

  for (const version of versions) {
    for (const analysis of version.analyses) {
      if (analysis.changeKind === "sin-cambios" && puntos.length > 0) {
        puntos[puntos.length - 1].repeated += 1;
        continue;
      }
      puntos.push({
        date: analysis.captureDate ?? analysis.savedAt,
        volumeM3: zoneTotals(analysis).volumeM3,
        analysisId: analysis.id,
        sourceTaskId: version.sourceTaskId,
        algorithmVersion: analysis.algorithmVersion ?? null,
        repeated: 0,
      });
    }
  }

  return puntos;
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
