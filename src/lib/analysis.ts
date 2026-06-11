// =============================================================================
// CONDORFINDER - SERVICIO DE ANALISIS DE VOLUMEN (HDU2)
// Archivo: src/lib/analysis.ts
// =============================================================================

const BACKEND_URL = "http://localhost:8000";
const POLLING_INTERVAL_MS = 3000;

export interface EnrichedDetection {
  id: number;
  class: string;
  confidence: number;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
  polygon: null | number[][];
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
        summary: {
          totalVolumeM3: Math.round(totalVolumeM3 * 100) / 100,
          totalWeightKg: Math.round(totalWeightKg),
          totalAreaM2:   Math.round(totalAreaM2 * 100) / 100,
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
