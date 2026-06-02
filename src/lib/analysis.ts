// =============================================================================
// CONDORFINDER - SERVICIO DE ANALISIS DE VOLUMEN
// Archivo: src/lib/analysis.ts
//
// Este modulo actua como la capa de comunicacion entre el frontend y el
// backend para el calculo de volumen de basurales (HDU2).
//
// Estado actual: SIMULADO
// El backend aun no esta implementado. La funcion principal retorna poligonos
// y volumenes predefinidos para permitir el desarrollo del frontend.
//
// Contexto PMV:
// - HDU2 pide calcular volumen por poligono desde un mapa/imagen unificada.
// - HDU3 pide visualizar zonas detectadas con area, volumen y tipo de residuo.
// - DroneWaste se considera referencia futura para deteccion/clasificacion de
//   residuos, pero este archivo no usa el dataset ni ejecuta modelos.
//
// Pendiente para backend/modelo:
// 1. Definir endpoint real para analizar el mapa unificado.
// 2. Reemplazar puntos SVG normalizados por geometria real (idealmente GeoJSON).
// 3. Definir metodo de volumen validado: altura estimada, fotogrametria, DEM/DSM
//    u otra aproximacion aceptada por el equipo municipal.
// 4. Conectar categorias reales de residuo y confianza del modelo.
// =============================================================================

// Representa una zona de basura detectada. Hoy la geometria se guarda en
// `points` como coordenadas porcentuales para dibujar un <polygon> SVG sobre la
// imagen simulada. En produccion conviene reemplazarlo por GeoJSON o por un
// contrato geoespacial explicitamente documentado.
export interface WastePolygon {
  id: string;
  name: string;
  category: string;
  color: string;
  areaM2: number;
  heightM: number;
  volumeM3: number;
  confidence: number;
  points: string;
}

// Caso exitoso: el backend/modelo encontro una o mas zonas de basura y retorna
// el resumen necesario para que el frontend muestre metricas operativas.
export interface AnalyzeSuccess {
  status: "success";
  polygons: WastePolygon[];
  summary: {
    areaM2: number;
    volumeM3: number;
  };
}

// Caso valido sin detecciones. Es distinto de error porque responde a un
// criterio de aceptacion de HDU2: informar que no hay basura detectada.
export interface AnalyzeEmpty {
  status: "empty";
  message: string;
  polygons: [];
  summary: {
    areaM2: 0;
    volumeM3: 0;
  };
}

// Caso de error real del servicio: entrada invalida, modelo no disponible,
// geometria corrupta, timeout, etc.
export interface AnalyzeError {
  status: "error";
  reason: string;
  message: string;
}

export type AnalyzeResponse = AnalyzeSuccess | AnalyzeEmpty | AnalyzeError;

// Flags temporales de demo/testing. No deberian exponerse a usuarios finales
// cuando exista backend real.
export interface AnalyzeOptions {
  forceEmpty?: boolean;
}

const SIMULATED_POLYGONS: WastePolygon[] = [
  {
    id: "P-01",
    name: "Acopio norte",
    category: "Construction and demolition materials",
    color: "#f59e0b",
    areaM2: 186,
    heightM: 1.35,
    volumeM3: 251,
    confidence: 88,
    points: "54,33 61,34 63,40 58,45 51,43 49,37",
  },
  {
    id: "P-02",
    name: "Zona mixta central",
    category: "Mixed items",
    color: "#22d3ee",
    areaM2: 128,
    heightM: 0.95,
    volumeM3: 122,
    confidence: 81,
    points: "47,48 54,49 56,55 52,60 45,58 43,52",
  },
  {
    id: "P-03",
    name: "Chatarra y pallets",
    category: "Scrap / Pallets",
    color: "#34d399",
    areaM2: 76,
    heightM: 1.1,
    volumeM3: 84,
    confidence: 79,
    points: "64,55 70,56 72,61 68,66 62,64 60,59",
  },
  {
    id: "P-04",
    name: "Neumaticos dispersos",
    category: "Tyres",
    color: "#a78bfa",
    areaM2: 42,
    heightM: 0.65,
    volumeM3: 27,
    confidence: 74,
    points: "70,68 75,69 76,73 73,77 68,76 67,72",
  },
];

function summarize(polygons: WastePolygon[]) {
  return polygons.reduce(
    (acc, polygon) => ({
      areaM2: acc.areaM2 + polygon.areaM2,
      volumeM3: acc.volumeM3 + polygon.volumeM3,
    }),
    { areaM2: 0, volumeM3: 0 },
  );
}

export async function analyzeUnifiedMap(
  mapUrl: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResponse> {
  // --- Llamada real al backend (descomentar cuando el API este disponible) ---
  // Contrato sugerido:
  // - Entrada: { mapUrl }
  // - Salida: AnalyzeResponse
  //
  // Si el backend recibe archivos o IDs persistidos en lugar de URL, actualizar
  // tambien `src/routes/analysis.tsx` y README.MD.
  // const res = await fetch("/api/maps/analyze-volume", {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify({ mapUrl }),
  // });
  // return (await res.json()) as AnalyzeResponse;

  // Evita que el parametro quede sin uso mientras el servicio esta simulado.
  void mapUrl;

  await new Promise((resolve) => setTimeout(resolve, 800));

  if (options.forceEmpty) {
    return {
      status: "empty",
      message: "No hay basura detectada en el área",
      polygons: [],
      summary: { areaM2: 0, volumeM3: 0 },
    };
  }

  return {
    status: "success",
    polygons: SIMULATED_POLYGONS,
    summary: summarize(SIMULATED_POLYGONS),
  };
}
