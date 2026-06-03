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
// - DroneWaste se considera referencia futura para deteccion/clasificacion de
//   residuos, pero este archivo no usa el dataset ni ejecuta modelos.
//
// Pendiente para backend/modelo:
// 1. Definir endpoint real para analizar el mapa unificado.
// 2. Definir metodo de volumen validado: altura estimada, fotogrametria, DEM/DSM
//    u otra aproximacion aceptada por el equipo municipal.
// 3. Conectar la deteccion real de basura solo como insumo para calcular volumen.
// =============================================================================

// Representa el resultado de volumen asociado a un poligono detectado. Este
// contrato no incluye geometria ni estilos de visualizacion, porque este corte
// del frontend solo cubre calculo y resumen de volumen.
export interface WastePolygon {
  id: string;
  name: string;
  areaM2: number;
  heightM: number;
  volumeM3: number;
  confidence: number;
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
    areaM2: 186,
    heightM: 1.35,
    volumeM3: 251,
    confidence: 88,
  },
  {
    id: "P-02",
    name: "Zona mixta central",
    areaM2: 128,
    heightM: 0.95,
    volumeM3: 122,
    confidence: 81,
  },
  {
    id: "P-03",
    name: "Acopio oeste",
    areaM2: 76,
    heightM: 1.1,
    volumeM3: 84,
    confidence: 79,
  },
  {
    id: "P-04",
    name: "Acopio sur",
    areaM2: 42,
    heightM: 0.65,
    volumeM3: 27,
    confidence: 74,
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
