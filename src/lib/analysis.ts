// =============================================================================
// CONDORFINDER - SERVICIO DE ANALISIS DE VOLUMEN (HDU2)
// Archivo: src/lib/analysis.ts
// =============================================================================

// CLIENT_BACKEND_URL (no BACKEND_URL): este archivo corre 100% en el
// navegador — necesita la ruta relativa que proxyea vite.config.ts, para
// que la cookie de sesión no se pierda por ser cross-origin. Ver config.ts.
import { CLIENT_BACKEND_URL as BACKEND_URL } from "./config";

const POLLING_INTERVAL_MS = 3000;

export interface EnrichedDetection {
  id: number;
  class: string;
  confidence: number;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
  polygon: null | number[][];
  // Coordenadas reales (en el CRS proyectado del ortomosaico, ver `crs` en
  // AnalyzeSuccess) — volumeCalc.py ya las calcula (backendModel/detecting/
  // volumeCalc.py:104) a partir del geotransform del .tif, HDU5 las usa para
  // ubicar el polígono en un mapa real.
  geo_polygon?: number[][] | null;
  area_m2?: number | null;
  volume_m3?: number | null;
  weight_kg?: number | null;
  ndsm_mean_m?: number | null;
  ndsm_max_m?: number | null;
}

export interface AnalyzeSummary {
  totalVolumeM3: number;
  totalWeightKg: number;
  totalAreaM2: number;
  detectionCount: number;
}

export interface AnalyzeSuccess {
  status: "success";
  detections: EnrichedDetection[];
  summary: AnalyzeSummary;
  // CRS proyectado del ortomosaico (ej. "EPSG:32719") — mismo para todas las
  // detecciones de un análisis, ver src/lib/projection.ts para reproyectarlo.
  crs: string;
  // Centro geográfico real del ortomosaico completo (mismo CRS que `crs`),
  // calculado por volumeCalc.py a partir de la extensión real del mapa —
  // no de las detecciones. HDU5/rutas.tsx lo usa para ubicar la zona en el
  // mapa de forma consistente entre corridas de análisis del mismo set de
  // fotos, aunque encuentren detecciones distintas entre sí.
  orthoCenter: [number, number] | null;
  // Huella geográfica COMPLETA del ortomosaico: [left, bottom, right, top],
  // mismo CRS que `crs` — HDU7 la usa para detectar duplicados comparando
  // la imagen completa entre análisis en vez de detecciones puntuales (ver
  // backendModel/analyses.py::_find_possible_duplicate).
  orthoBounds: [number, number, number, number] | null;
}

export interface AnalyzeEmpty {
  status: "empty";
  message: string;
}

export interface AnalyzeError {
  status: "error";
  message: string;
}

export type AnalyzeResponse = AnalyzeSuccess | AnalyzeEmpty | AnalyzeError;

// Kept for type compatibility with components that may still reference WastePolygon
export interface WastePolygon {
  id: string;
  name: string;
  areaM2: number;
  heightM: number;
  volumeM3: number;
  confidence: number;
}

export async function startVolumeAnalysis(
  taskId: string,
): Promise<{ status: string; message?: string }> {
  const res = await fetch(`${BACKEND_URL}/analyze/${taskId}`, { method: "POST" });
  return res.json();
}

export async function pollVolumeAnalysis(
  taskId: string,
  detectionJsonUrl: string,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<AnalyzeResponse> {
  let pct = 15;

  while (true) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");

    const res = await fetch(`${BACKEND_URL}/status/${taskId}`, { signal });
    const data = await res.json();
    const analysisStatus = data.analysis_status;

    if (analysisStatus === "done") {
      if (onProgress) onProgress(100);

      const jsonRes = await fetch(detectionJsonUrl, { signal });
      const jsonData = await jsonRes.json();
      const detections: EnrichedDetection[] = jsonData.detections ?? [];

      if (detections.length === 0) {
        return { status: "empty", message: "No hay basura detectada en el área" };
      }

      const totalVolumeM3 = detections.reduce((s, d) => s + (d.volume_m3 ?? 0), 0);
      const totalWeightKg = detections.reduce((s, d) => s + (d.weight_kg ?? 0), 0);
      const totalAreaM2 = detections.reduce((s, d) => s + (d.area_m2 ?? 0), 0);

      return {
        status: "success",
        detections,
        crs: jsonData.crs ?? "",
        orthoCenter: jsonData.ortho_center ?? null,
        orthoBounds: jsonData.ortho_bounds ?? null,
        summary: {
          totalVolumeM3: Math.round(totalVolumeM3 * 100) / 100,
          totalWeightKg: Math.round(totalWeightKg),
          totalAreaM2: Math.round(totalAreaM2 * 100) / 100,
          detectionCount: detections.length,
        },
      };
    }

    if (analysisStatus === "error") {
      return {
        status: "error",
        message: data.analysis_message ?? "Error en el análisis de volumen",
      };
    }

    pct = Math.min(88, pct + 8);
    if (onProgress) onProgress(pct);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, POLLING_INTERVAL_MS);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }
}
