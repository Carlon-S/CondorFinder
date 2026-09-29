// =============================================================================
// CONDORFINDER — GENERAR RUTA ÓPTIMA (HDU5)
// Archivo: src/routes/_authed/rutas.tsx
//
// AC4: "Cargar archivo de análisis" enlista los análisis guardados (HDU4) y,
// al elegir uno (o varios, con checkbox), cada zona detectada se marca en el
// mapa como un círculo grande y preciso (geo_polygon reproyectado UTM→WGS84,
// centroide como posición) — no como el polígono real dibujado sobre
// Leaflet: a la escala de toda la comuna, un polígono de detección (unos
// pocos metros) es ilegible. Al clickear el círculo se abre un "zoom"
// (diálogo grande) con el mapa unificado REAL de esa zona y sus polígonos en
// precisión de píxel — mismo tipo de vista que ya usa /analysis. Cada carga
// SUMA análisis, no reemplaza, para poder armar una ruta que cubra varios
// basurales.
//
// Todos los análisis guardados con coordenadas ubicables se ven SIEMPRE en
// el mapa como círculos (atenuados si todavía no están "cargados" para la
// ruta) — no hace falta abrir el diálogo para saber dónde están; cargar un
// análisis solo decide si participa en el cálculo de la ruta. La interacción
// (hover con miniatura, click con zoom) es la misma estén cargados o no.
//
// AC3: "Generar ruta" queda deshabilitado mientras no haya ningún análisis
// cargado. AC1: confirmación con el estado de los puntos activos
// (HDU6), horas disponibles y tipo de basura prioritario. AC5: cancelar solo
// cierra la confirmación, no toca los análisis ya cargados. AC2/AC6: llama
// al contrato de src/lib/routePlan.ts — el algoritmo real es backend
// (pendiente), así que hoy cualquier intento cae en el camino de AC6.
//
// Mismo layout de dos columnas (aside + mapa) que recursos.tsx.
// =============================================================================

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightCircle,
  Boxes,
  Pencil,
  Crosshair,
  FolderOpen,
  Loader2,
  Map as MapIcon,
  MapPin,
  Route as RouteIcon,
  Scale,
  TriangleAlert,
  Truck,
  Warehouse,
  X,
} from "@/components/icons/Icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { GeoMap, type GeoMapPoint } from "@/components/GeoMap";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listAnalyses,
  setPendingOpenId,
  type AnalysisSummary,
  type SavedAnalysisRecord,
} from "@/lib/analysisStore";
import {
  listResourcePoints,
  listResources,
  resumenParaRuta,
  TEXTO_FUERA_DE_RUTA,
  type Resource,
  type ResourcePoint,
} from "@/lib/resources";
import { MAIPU_BBOX } from "@/lib/maipuBoundary";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { projectPolygonToWgs84 } from "@/lib/projection";
import { generateRoute, type RoutePlanSegment } from "@/lib/routePlan";
import { notify } from "@/lib/notify";
import {
  ROUTE_OUTBOUND_COLOR,
  ROUTE_RETURN_COLOR,
  ROUTE_RETURN_OPACITY,
} from "@/components/route-colors";

export const Route = createFileRoute("/_authed/planificacion/rutas")({
  component: RutasPage,
});

const WASTE_CLASSES = [
  "Residuo de construcción",
  "Metal",
  "Plástico",
  "Residuo orgánico",
  "Muebles",
  "Neumáticos",
  "Tipo de basura indefinido",
];

// Mismos colores que analysis.tsx usa para las mismas clases — consistencia
// visual entre el "zoom" de acá y la vista real de análisis.
const CLASS_COLORS: Record<string, string> = {
  "Residuo de construcción": "#ef4444",
  Metal: "#f97316",
  Plástico: "#3b82f6",
  "Residuo orgánico": "#22c55e",
  Muebles: "#a855f7",
  Neumáticos: "#64748b",
  "Tipo de basura indefinido": "#f59e0b",
  "Varios tipos": "#7c3aed",
};

function classColor(cls: string): string {
  return CLASS_COLORS[cls] ?? "#7c3aed";
}

const ZONE_COLORS = ["#7c3aed", "#0ea5e9", "#f97316", "#22c55e", "#ef4444", "#eab308"];

/** Forma mínima de una detección tal como quedó en un SavedAnalysisRecord —
 *  `detections` ahí es `unknown`, este es el subset que HDU5 necesita leer. */
interface StoredDetection {
  id: number;
  class: string;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
  geo_polygon?: number[][] | null;
  volume_m3?: number | null;
  weight_kg?: number | null;
  area_m2?: number | null;
}

interface LoadedDetection {
  id: number;
  wasteClass: string;
  volumeM3: number | null;
  weightKg: number | null;
  areaM2: number | null;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
  geoPolygon: [number, number][];
}

interface LoadedAnalysis {
  id: string;
  name: string;
  mapUrl: string;
  /** Centroide de todas sus detecciones — posición del círculo en el mapa. */
  center: [number, number];
  detections: LoadedDetection[];
  /** Totales recalculados a partir de `detections` (las que efectivamente se
   *  pudieron ubicar) — nunca los del análisis original guardado. Si se
   *  usara ese total original y alguna detección no se pudiera reproyectar,
   *  el resumen mostrado quedaría desincronizado del listado real de zonas. */
  summary: AnalysisSummary;
  /** true si el análisis original tenía detecciones que no se pudieron
   *  ubicar (CRS no reconocido, polígono inválido) — se avisa en el "zoom". */
  partial: boolean;
  /** Dimensiones naturales de mapUrl — para alinear los rects de detección
   *  sobre la miniatura del tooltip de hover. Null hasta que la imagen
   *  termine de cargar (se resuelve async, ver refreshAllAnalyses). */
  imgSize: { w: number; h: number } | null;
}

/** Centroide simple (promedio de todos los vértices) — suficiente para
 *  ubicar el círculo, un polígono de detección es chico (metros) comparado
 *  con el zoom al que se vuela. */
function centroidOf(polygons: [number, number][][]): [number, number] | null {
  const points = polygons.flat();
  if (points.length === 0) return null;
  const lat = points.reduce((sum, [la]) => sum + la, 0) / points.length;
  const lng = points.reduce((sum, [, ln]) => sum + ln, 0) / points.length;
  return [lat, lng];
}

/** "2.27" horas -> "2 h 16 min" -- la leyenda de la ruta (AC2) muestra
 *  tiempo estimado, y horas decimales crudas no se leen bien de un
 *  vistazo en una demo en vivo. */
function formatDuration(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/** Mismo cálculo que activeSummary en analysis.tsx (misma cantidad de
 *  decimales) — se recalcula acá en vez de confiar en el resumen guardado
 *  del análisis original, para que nunca pueda desincronizarse de qué
 *  detecciones realmente se lograron ubicar en el mapa. */
function computeSummary(detections: LoadedDetection[]): AnalysisSummary {
  return {
    totalVolumeM3: Math.round(detections.reduce((s, d) => s + (d.volumeM3 ?? 0), 0) * 100) / 100,
    totalWeightKg: Math.round(detections.reduce((s, d) => s + (d.weightKg ?? 0), 0)),
    totalAreaM2: Math.round(detections.reduce((s, d) => s + (d.areaM2 ?? 0), 0) * 100) / 100,
  };
}

/** Reproyecta un SavedAnalysisRecord a algo ubicable en el mapa, o `null` si
 *  no se puede (sin CRS, o ninguna detección con geo_polygon reproyectable).
 *  Sin efectos secundarios (sin toasts) — se usa tanto en bulk al entrar a
 *  la vista como al cargar uno puntual desde el diálogo. */
function processRecord(record: SavedAnalysisRecord): LoadedAnalysis | null {
  // HDU7/AC3 — un análisis histórico (reemplazado por uno más reciente
  // confirmado como la misma zona) ya no debe poder cargarse en una ruta
  // nueva — es la versión vigente (la que lo reemplazó) la que hay que
  // usar. Mismo criterio que ya aplica Vista Principal al ocultarlo de
  // "Todas".
  if (record.historical) return null;
  if (!record.crs) return null;

  const detections = (record.detections as StoredDetection[]) ?? [];
  const resolved: LoadedDetection[] = [];
  for (const d of detections) {
    if (!d.geo_polygon || d.geo_polygon.length < 3) continue;
    const geoPolygon = projectPolygonToWgs84(d.geo_polygon, record.crs);
    if (!geoPolygon) continue;
    resolved.push({
      id: d.id,
      wasteClass: d.class,
      volumeM3: d.volume_m3 ?? null,
      weightKg: d.weight_kg ?? null,
      areaM2: d.area_m2 ?? null,
      bbox: d.bbox,
      geoPolygon,
    });
  }
  if (resolved.length === 0) return null;

  // La ubicación del círculo viene del centro REAL del ortomosaico
  // (mismo para cualquier análisis que use el mismo set de fotos, sin
  // importar qué detecciones encontró YOLO esa corrida en particular) —
  // no del promedio de las detecciones, que cambia si el análisis
  // encuentra menos/más/distintas zonas entre corridas del mismo terreno.
  // Fallback al centroide de detecciones solo para análisis guardados
  // ANTES de este cambio (sin orthoCenter todavía).
  let center: [number, number] | null = null;
  if (record.orthoCenter) {
    const reprojected = projectPolygonToWgs84([record.orthoCenter], record.crs);
    center = reprojected?.[0] ?? null;
  }
  if (!center) {
    center = centroidOf(resolved.map((d) => d.geoPolygon));
  }
  if (!center) return null;

  return {
    id: record.id,
    name: record.name,
    mapUrl: record.mapUrl,
    center,
    detections: resolved,
    summary: computeSummary(resolved),
    partial: resolved.length < detections.length,
    imgSize: null,
  };
}

function RutasPage() {
  const navigate = useNavigate();

  // Todos los análisis guardados que se pudieron ubicar en el mapa —
  // reproyectados una sola vez al entrar a la vista. Se muestran SIEMPRE
  // como círculos (atenuados si no están en `loadedIds`), no solo los que
  // el trabajador decidió sumar a la ruta.
  const [allAnalyses, setAllAnalyses] = useState<LoadedAnalysis[]>([]);
  // Subconjunto de allAnalyses.id que participa en el cálculo de la ruta.
  const [loadedIds, setLoadedIds] = useState<Set<string>>(new Set());
  const loadedAnalyses = allAnalyses.filter((a) => loadedIds.has(a.id));

  // Punto al que el mapa vuela — mismo mecanismo que focusPoint en
  // recursos.tsx. Sin esto, el mapa se queda en el centro por defecto de
  // Maipú (zoom de toda la comuna).
  const [focusPoint, setFocusPoint] = useState<[number, number] | null>(null);
  // Análisis cuyo "zoom" (mapa real + polígonos en precisión de píxel) está
  // abierto — null si el diálogo está cerrado. Puede ser uno no cargado
  // todavía: la interacción es la misma para ambos casos.
  const [zoomAnalysis, setZoomAnalysis] = useState<LoadedAnalysis | null>(null);
  const [zoomImgSize, setZoomImgSize] = useState<{ w: number; h: number } | null>(null);
  // true si el PNG del mapa de esta zona no cargó (404) — pasa si el archivo
  // se borró desde otra pestaña/sesión (ej. "Eliminar zona" en Vista
  // Principal) mientras esta zona seguía en memoria acá.
  const [zoomImgError, setZoomImgError] = useState(false);

  // Ficha de datos de un punto (HDU6) — a diferencia de zoomAnalysis, no hay
  // mapa/imagen que ampliar, solo su información (dirección, recursos,
  // activo/inactivo) en modo solo lectura, mismo estilo de diálogo.
  const [zoomPoint, setZoomPoint] = useState<ResourcePoint | null>(null);

  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  const [savedAnalyses, setSavedAnalyses] = useState<SavedAnalysisRecord[]>([]);
  const [loadingSaved, setLoadingSaved] = useState(false);
  // AC4 — selección múltiple: ids marcados en el diálogo, todavía no cargados.
  const [selectedToLoad, setSelectedToLoad] = useState<Set<string>>(new Set());

  // Puntos (HDU6) — se ven siempre en el mapa (atenuados si están
  // inactivos), y su subconjunto activo es lo que la confirmación (AC1)
  // necesita. Un solo fetch cubre ambos usos.
  const [originPoints, setOriginPoints] = useState<ResourcePoint[]>([]);
  // La flota de cada punto, para explicar QUÉ cuenta en una ruta y qué no.
  // El total en m³ ya lo trae el punto calculado por el backend; esto es el
  // desglose, que es lo que hace visible el AC5 de HDU8.
  const [recursosPorPunto, setRecursosPorPunto] = useState<Record<string, Resource[]>>({});

  // Pestaña de la tabla al pie. Es el detalle de lo que el mapa muestra
  // como marcadores: las zonas que se van a retirar y los puntos desde
  // donde sale la flota. En el mapa son círculos; acá son cifras.
  const [tabla, setTabla] = useState<"zonas" | "tramos">("zonas");
  // Encuadre manual a la comuna. Es un array nuevo en cada clic a propósito:
  // FitBounds en GeoMapImpl reacciona al cambio de REFERENCIA, así que mandar
  // la misma constante no volvería a encuadrar la segunda vez.
  const [recentrar, setRecentrar] = useState<[number, number][] | null>(null);
  // Solo para el mapa principal (mapPoints, abajo) -- se apaga cuando la
  // carga INICIAL de ambas fuentes (zonas + puntos de origen) resuelve, no
  // en cada refresh posterior (multi-pestaña). Antes el mapa se veía vacío
  // sin ningún indicio de carga hasta que ambos fetches resolvían solos.
  const [mapDataLoading, setMapDataLoading] = useState(true);
  const activePoints = originPoints.filter((p) => p.active);
  /** Desglose de la flota del punto abierto en la ficha. */
  const resumenPunto = resumenParaRuta(zoomPoint ? (recursosPorPunto[zoomPoint.id] ?? []) : []);

  // AC1 — confirmación.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loadingPoints, setLoadingPoints] = useState(false);
  const [availableHours, setAvailableHours] = useState("8");
  const [priorityWasteType, setPriorityWasteType] = useState<string>("none");

  // AC2/AC6.
  const [generating, setGenerating] = useState(false);
  const [routeStops, setRouteStops] = useState<
    { order: number; lat: number; lng: number; label: string }[] | null
  >(null);
  // Trazos reales (calles, vía OSRM) de ida/vuelta -- separados para
  // pintarlos con estilos distintos (ver GeoMapImpl.tsx). Null hasta que
  // se genera una ruta con éxito.
  const [routeOutboundPaths, setRouteOutboundPaths] = useState<[number, number][][] | null>(null);
  const [routeReturnPaths, setRouteReturnPaths] = useState<[number, number][][] | null>(null);
  // Resumen por sub-ruta/origen (mismo índice que los paths de arriba) --
  // para la leyenda (ida/vuelta por separado) y las ventanas flotantes
  // sobre cada tramo del mapa. null hasta que hay una ruta exitosa.
  const [routeSegments, setRouteSegments] = useState<RoutePlanSegment[] | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);

  // ¿El backend está mandando ya los datos de HDU5.1? Las columnas de vehículo
  // y personal existen solo si SÍ. Preguntarlo por los datos y no por una
  // bandera de configuración es lo que hace que aparezcan solas el día que el
  // backend las devuelva, sin tocar esta vista.
  const hayVehiculo = routeSegments?.some((seg) => seg.vehicle) ?? false;
  const hayDotacion = routeSegments?.some((seg) => seg.crew && seg.crew.length > 0) ?? false;

  // Horas disponibles: 0/negativo/vacío no es una entrada válida — sin esto
  // se podía confirmar una ruta con "0 horas" en silencio (Number("") || 0).
  const hoursNum = Number(availableHours);
  const hoursValid = availableHours.trim() !== "" && Number.isFinite(hoursNum) && hoursNum > 0;

  // Cache de tamaños de imagen ya resueltos, por mapUrl — un ref (no state)
  // porque tiene que sobrevivir a refrescos repetidos de allAnalyses sin
  // volver a descargar la imagen completa cada vez (ver refreshAllAnalyses).
  const imgSizeCacheRef = useRef<Map<string, { w: number; h: number }>>(new Map());

  // Trae los puntos reales (HDU6) — se usa al entrar a la vista,
  // al abrir la confirmación, y al refrescar por multi-pestaña (ver el
  // useEffect de abajo). Es la única fuente de "activo" para el mapa y AC1.
  const refreshOriginPoints = async (): Promise<void> => {
    try {
      // Los dos en paralelo, y los recursos SIN filtrar por punto: una sola
      // petición trae la flota completa y se agrupa acá. Pidiendo por punto
      // serían tantas peticiones como puntos activos para mostrar un desglose.
      const [puntos, recursos] = await Promise.all([listResourcePoints(), listResources()]);
      setOriginPoints(puntos);
      setRecursosPorPunto(
        recursos.reduce<Record<string, Resource[]>>((mapa, r) => {
          (mapa[r.point_id] ??= []).push(r);
          return mapa;
        }, {}),
      );
    } catch (err) {
      notify.error(
        "No se pudieron cargar los puntos",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
      setOriginPoints([]);
      setRecursosPorPunto({});
    }
  };

  // Reproyecta TODOS los análisis guardados que tengan CRS — se ven en el
  // mapa desde que se entra a la vista, no solo los que ya se cargaron.
  // Se puede llamar repetidas veces (multi-pestaña, ver useEffect) sin
  // volver a descargar imágenes ya conocidas gracias a imgSizeCacheRef.
  const refreshAllAnalyses = async (): Promise<void> => {
    let records: SavedAnalysisRecord[];
    try {
      records = await listAnalyses();
    } catch (err) {
      notify.error(
        "No se pudieron cargar los análisis guardados",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
      setAllAnalyses([]);
      return;
    }

    const processed = records
      .map(processRecord)
      .filter((a): a is LoadedAnalysis => a !== null)
      .map((a) => {
        const cached = imgSizeCacheRef.current.get(a.mapUrl);
        return cached ? { ...a, imgSize: cached } : a;
      });
    setAllAnalyses(processed);

    for (const a of processed) {
      if (imgSizeCacheRef.current.has(a.mapUrl)) continue;
      const probe = new Image();
      probe.onload = () => {
        const size = { w: probe.naturalWidth, h: probe.naturalHeight };
        imgSizeCacheRef.current.set(a.mapUrl, size);
        setAllAnalyses((prev) => prev.map((x) => (x.id === a.id ? { ...x, imgSize: size } : x)));
      };
      probe.src = a.mapUrl;
    }
  };

  // Multi-pestaña: tanto los análisis guardados como los puntos
  // viven ahora en Mongo (sin evento nativo tipo "storage" para eso, a
  // diferencia de cuando los análisis vivían en localStorage) — se
  // refrescan al recuperar el foco de la ventana, mismo patrón que usan
  // librerías de fetching tipo react-query. Sin esto, una zona eliminada
  // en otra pestaña/sesión seguía viéndose acá como si nada.
  useEffect(() => {
    Promise.all([refreshOriginPoints(), refreshAllAnalyses()]).finally(() =>
      setMapDataLoading(false),
    );

    const handleFocus = () => {
      refreshOriginPoints();
      refreshAllAnalyses();
    };

    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  const openLoadDialog = async () => {
    setLoadDialogOpen(true);
    setSelectedToLoad(new Set());
    setLoadingSaved(true);
    try {
      // HDU7/AC3 — un análisis histórico (reemplazado) no debe aparecer acá
      // ni siquiera deshabilitado/"no ubicable" — directamente no es una
      // opción válida para cargar, es la versión vigente la que corresponde.
      const records = await listAnalyses();
      setSavedAnalyses(records.filter((r) => !r.historical));
    } catch (err) {
      notify.error(
        "No se pudieron cargar los análisis guardados",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
      setSavedAnalyses([]);
    } finally {
      setLoadingSaved(false);
    }
  };

  const toggleSelectToLoad = (id: string) => {
    setSelectedToLoad((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // AC4 — carga (suma a la ruta) todos los análisis marcados en el diálogo.
  // No reemplaza lo que ya estaba cargado.
  const handleLoadSelected = () => {
    const ids = Array.from(selectedToLoad);
    if (ids.length === 0) return;

    let placedCount = 0;
    let unplaceableCount = 0;
    let lastCenter: [number, number] | null = null;

    setLoadedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        const analysis = allAnalyses.find((a) => a.id === id);
        if (!analysis) {
          unplaceableCount++;
          continue;
        }
        next.add(id);
        lastCenter = analysis.center;
        placedCount++;
      }
      return next;
    });

    setLoadDialogOpen(false);
    setSelectedToLoad(new Set());

    if (lastCenter) setFocusPoint(lastCenter);

    if (placedCount > 0) {
      notify.success(
        placedCount === 1 ? "Análisis cargado" : "Análisis cargados",
        `${placedCount} análisis se agregaron a la ruta${
          unplaceableCount > 0 ? ` (${unplaceableCount} no se pudieron ubicar en el mapa)` : ""
        }.`,
      );
    } else {
      notify.warning(
        "No se pudo cargar ningún análisis",
        "Ninguno de los seleccionados tiene coordenadas ubicables — vuelve a analizarlos y guardarlos.",
      );
    }
  };

  // "Descargar" un análisis (deja de participar en la ruta) — sigue
  // apareciendo en el mapa como círculo, solo que atenuado, igual que uno
  // que nunca se cargó.
  const handleUnload = (id: string) => {
    setLoadedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  // Volver a centrar el mapa en un análisis ya cargado — para cuando el
  // usuario se alejó/cargó otro después y quiere ubicarlo de nuevo.
  //
  // analysis.center es SIEMPRE la misma referencia de array mientras ese
  // análisis siga en allAnalyses — si se vuelve a clickear el mismo,
  // setFocusPoint recibe el mismo objeto de antes, React lo descarta por
  // igualdad referencial y el useEffect de FlyToPoint (dependiente de esa
  // referencia) nunca vuelve a correr. Por eso se clona en una tupla nueva.
  const focusOnAnalysis = (id: string) => {
    const analysis = allAnalyses.find((a) => a.id === id);
    if (analysis) setFocusPoint([analysis.center[0], analysis.center[1]]);
  };

  // Click en el círculo de una zona (cargada o no — misma interacción) abre
  // el "zoom" con el mapa real. Click en un cuadrado de punto (HDU6) abre
  // su ficha de datos en vez — no matchea ningún id de allAnalyses, así que
  // se busca aparte en originPoints. En los dos casos, además del diálogo,
  // el mapa de fondo vuela hacia esa ubicación (mismo mecanismo que usa
  // "Cargar archivo de análisis" con focusPoint/FlyToPoint) — antes solo
  // abría el diálogo sin mover el mapa.
  const handlePointClick = (point: GeoMapPoint) => {
    const analysis = allAnalyses.find((a) => a.id === point.id);
    if (analysis) {
      setZoomImgSize(null);
      setZoomImgError(false);
      setZoomAnalysis(analysis);
      setFocusPoint(point.position);
      return;
    }
    const originPoint = originPoints.find((p) => p.id === point.id);
    if (originPoint) {
      // Con el panel de puntos abierto, el clic lo atiende ese panel (abre su
      // ficha para editarlo). Con el de ruta, sigue abriendo la ficha de solo
      // lectura de siempre, que es lo que sirve mientras se planifica.
      setZoomPoint(originPoint);
      setFocusPoint(point.position);
    }
  };

  // AC1 — abre la confirmación, trae el estado real de los puntos.
  const openConfirm = async () => {
    setRouteError(null);
    setConfirmOpen(true);
    setLoadingPoints(true);
    await refreshOriginPoints();
    setLoadingPoints(false);
  };

  // AC5 — cancelar/cerrar la confirmación no toca el mapa ni los análisis cargados.
  const handleCancelConfirm = () => setConfirmOpen(false);

  // AC2/AC6.
  const handleGenerateRoute = async () => {
    if (!hoursValid || activePoints.length === 0) return;

    setGenerating(true);
    // Solo se mandan los ids de los análisis cargados — el backend resuelve
    // el volumen/polígono real de cada uno contra Mongo (routing.py), nunca
    // confía en los datos que arma el navegador.
    const result = await generateRoute({
      analysisIds: Array.from(loadedIds),
      activePointIds: activePoints.map((p) => p.id),
      availableHours: hoursNum,
      priorityWasteType: priorityWasteType === "none" ? null : priorityWasteType,
    });
    setGenerating(false);
    setConfirmOpen(false);

    if (result.status === "success") {
      setRouteStops(result.route.stops);
      setRouteOutboundPaths(result.route.outboundPaths ?? null);
      setRouteReturnPaths(result.route.returnPaths ?? null);
      setRouteSegments(result.route.segments ?? null);
      setRouteError(null);
      notify.success("Ruta generada", "Revisa el orden de paradas propuesto en el panel.");
    } else {
      setRouteStops(null);
      setRouteOutboundPaths(null);
      setRouteReturnPaths(null);
      setRouteSegments(null);
      setRouteError(result.message);
    }
  };

  // Círculos de zonas (todas las ubicables — huecos si no están cargadas
  // en la ruta) + cuadrados de puntos (huecos si están
  // inactivos) — ambos en el mismo mapa. Sólido vs. hueco en vez de
  // opacidad: la opacidad se perdía apenas se solapaba con las capas del
  // mapa base, sólido/hueco se reconoce a cualquier zoom.
  // AC4/HDU5 (texto literal): "cuando se seleccione uno de los archivos de
  // análisis guardados... el sistema cargará los polígonos asociados en el
  // mapa" — el marcador de una zona solo debe existir una vez que esa zona
  // se cargó a la ruta, no antes. Antes se mostraban TODAS las zonas
  // guardadas de una vez (huecas las no cargadas), lo cual no lo pide la AC
  // y hacía que el mapa se llenara de íconos apenas resolvía listAnalyses().
  const zoneMapPoints: GeoMapPoint[] = allAnalyses
    .filter((a) => loadedIds.has(a.id))
    .map((a, i) => ({
      id: a.id,
      position: a.center,
      label: a.name,
      color: ZONE_COLORS[i % ZONE_COLORS.length],
      muted: false,
      previewImageUrl: a.mapUrl,
      previewSubtitle: `${a.summary.totalVolumeM3} m³ · ${a.summary.totalWeightKg} kg · ${a.detections.length} zona${
        a.detections.length === 1 ? "" : "s"
      }`,
      previewImageSize: a.imgSize ?? undefined,
      previewDetections: a.detections.map((d) => ({
        id: d.id,
        bbox: d.bbox,
        color: classColor(d.wasteClass),
      })),
    }));

  const originMapPoints: GeoMapPoint[] = originPoints.map((p) => {
    // La capacidad viene calculada por el backend (capacity_m3 del punto) y es
    // exactamente la que usa el ruteo: recursos de familia "carga",
    // disponibles y con capacidad declarada. Antes se sumaba acá a mano desde
    // los contadores del punto, y eso era una segunda aritmética sobre el mismo
    // número: la pantalla podía decir una cifra y la ruta armarse con otra.
    // Es lo que de verdad limita si una ruta es factible desde acá, así que
    // vale la pena verlo sin abrir la ficha completa del punto.
    const capacityLabel = `${p.capacity_m3} m³ disponibles`;
    return {
      id: p.id,
      position: [p.lat, p.lng] as [number, number],
      label: p.active ? `${p.name} · ${capacityLabel}` : `${p.name} (inactivo) · ${capacityLabel}`,
      muted: !p.active,
    };
  });

  const mapPoints: GeoMapPoint[] = [...zoneMapPoints, ...originMapPoints];

  const routePositions = routeStops?.map((s) => [s.lat, s.lng] as [number, number]) ?? null;
  // Encuadre automático de la ruta recién generada -- todos los puntos de
  // ambos trazos reales (no solo las paradas), para que el zoom quede justo
  // sobre las calles que realmente recorre, no solo sobre los pines.
  //
  // useMemo (no un const plano) es imprescindible acá: sin él, este array
  // se recreaba en CADA render de la página (no solo cuando llega una ruta
  // nueva), y como el efecto de FitBounds en GeoMapImpl.tsx depende de esa
  // referencia, el mapa hacía flyToBounds en cualquier re-render sin
  // relación (hover de un marcador, abrir un diálogo, etc.), no solo al
  // generar. Memoizado sobre las referencias reales de estado, que solo
  // cambian cuando de verdad llega una ruta nueva.
  const routeFitPoints = useMemo<[number, number][] | null>(() => {
    if (routeOutboundPaths || routeReturnPaths) {
      return [...(routeOutboundPaths ?? []).flat(), ...(routeReturnPaths ?? []).flat()];
    }
    return routePositions;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeOutboundPaths, routeReturnPaths]);

  // Cifras de cabecera. Las cuatro responden la pregunta con la que se entra a
  // esta vista: con qué cuento y cuánto hay que retirar.
  const totalesCabecera = {
    puntos: activePoints.length,
    capacidad: originPoints.reduce((sum, p) => sum + p.capacity_m3, 0),
    zonas: loadedAnalyses.length,
    volumen: loadedAnalyses.reduce((sum, a) => sum + a.summary.totalVolumeM3, 0),
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Cabecera y franja de cifras a lo ancho, arriba de todo. Es la
          estructura de un tablero de operaciones: primero el estado general,
          después el mapa con su panel, y al pie el detalle en tabla. */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border/25 px-6 py-4">
        <div>
          <p className="eyebrow">Planificación</p>
          <h1 className="font-rubik text-3xl font-semibold tracking-normal text-foreground md:text-4xl">
            Planificar Retiro
          </h1>
        </div>
        <div className="flex flex-wrap items-center divide-x divide-border/10">
          <CifraCabecera etiqueta="Puntos activos" valor={String(totalesCabecera.puntos)} />
          <CifraCabecera etiqueta="Capacidad" valor={`${totalesCabecera.capacidad} m³`} />
          <CifraCabecera etiqueta="Zonas cargadas" valor={String(totalesCabecera.zonas)} />
          <CifraCabecera
            etiqueta="Volumen a retirar"
            valor={`${totalesCabecera.volumen.toFixed(1)} m³`}
          />
        </div>
      </div>

      {/* El mapa a la IZQUIERDA y grande, el panel a la derecha. Era al revés,
          con el panel ocupando la columna de lectura y el mapa relegado: acá el
          mapa es el contenido y el panel son los controles. */}
      <main className="grid min-h-0 flex-1 grid-cols-[1fr_clamp(19rem,26vw,25rem)]">
        <section className="relative min-w-0 overflow-hidden border-r border-border/35 bg-background animate-in fade-in duration-500">
          <GeoMap
            className="h-full w-full"
            points={mapPoints}
            onPointClick={handlePointClick}
            routePositions={routePositions}
            outboundPaths={routeOutboundPaths}
            returnPaths={routeReturnPaths}
            routeSegments={routeSegments}
            // El recentrado manual gana sobre el encuadre automático de la
            // ruta: es una acción explícita y reciente del usuario.
            fitBoundsTo={recentrar ?? routeFitPoints}
            focusPoint={focusPoint}
            lockToMaipu
          />
          {/* Volver al encuadre de la comuna. El mapa se puede mover dentro de
              un margen alrededor de Maipú, y después de seguir una ruta hasta
              un borde no hay forma evidente de recomponer la vista: el zoom del
              navegador no la devuelve y arrastrar a ojo tampoco. */}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setRecentrar([...MAIPU_BBOX])}
            title="Volver a ver toda la comuna"
            className="absolute right-4 top-4 z-[500] shadow-md"
          >
            <Crosshair className="mr-1.5 h-3.5 w-3.5" /> Centrar en Maipú
          </Button>

          {mapDataLoading && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/60">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </section>

        <aside className="overflow-y-auto p-5">
          <div className="flex flex-col gap-4">
            {/* Los dos bloques conviven, uno debajo del otro, como el panel de
                la referencia (Fleet arriba, Alerts abajo). Estuvieron detrás de
                un par de pestañas y era un estorbo: planificar es mirar la ruta
                Y los puntos a la vez, y alternar obligaba a recordar lo que
                mostraba la otra. */}
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center gap-2.5 border-l-2 border-primary/50 pl-3">
                <RouteIcon className="h-3.5 w-3.5 text-foreground/70" />
                <h2 className="text-sm font-semibold tracking-tight text-foreground">Ruta</h2>
              </div>

              <div className="animate-in fade-in slide-in-from-left-2 duration-300 flex flex-col gap-2">
                <Button onClick={openLoadDialog} variant="secondary" className="w-full">
                  <FolderOpen className="mr-2 h-4 w-4" /> Cargar archivo de análisis
                </Button>
                <Button
                  onClick={openConfirm}
                  disabled={loadedAnalyses.length === 0}
                  size="lg"
                  className="btn-cta w-full"
                >
                  <RouteIcon className="mr-2 h-4 w-4" /> Generar ruta
                </Button>
              </div>

              {/* La lista de zonas cargadas NO va acá. Vive en la tabla al pie,
                donde cada zona muestra su volumen, su área y su peso, que es lo
                que se compara al decidir. En el panel era una lista de nombres
                sin cifras que además duplicaba lo de abajo. */}

              {routeError && (
                <div className="animate-in fade-in slide-in-from-left-2 duration-300 rounded-lg border border-warning/40 bg-warning/10 p-4">
                  <TriangleAlert className="mb-2 h-5 w-5 text-warning" />
                  <p className="text-sm font-semibold">No se pudo generar la ruta</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{routeError}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Revisa los puntos en el bloque de abajo.
                  </p>
                </div>
              )}

              {routeStops && (
                <div className="animate-in fade-in slide-in-from-left-2 duration-300 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-foreground">Ruta propuesta</p>
                    <button
                      type="button"
                      onClick={() => {
                        setRouteStops(null);
                        setRouteOutboundPaths(null);
                        setRouteReturnPaths(null);
                        setRouteSegments(null);
                      }}
                      aria-label="Cerrar"
                      className="flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <ul className="space-y-1.5">
                    {routeStops.map((s) => (
                      <li
                        key={s.order}
                        className="flex items-center gap-2 rounded-md border border-border/60 bg-background/60 p-2 text-sm"
                      >
                        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-[0.625rem] font-semibold text-primary">
                          {s.order}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{s.label}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </aside>
      </main>

      {/* Detalle en tabla al pie, con pestañas. El mapa dice DÓNDE y esta tabla
          dice CUÁNTO: un círculo en el mapa no se puede comparar con otro, y
          las dos preguntas de la planificación (cuánto hay que retirar, con qué
          cuento) son comparaciones entre filas. */}
      <div className="flex h-[clamp(11rem,26vh,18rem)] flex-shrink-0 flex-col border-t border-border/35 bg-card">
        <div className="flex items-center gap-1 border-b border-border px-5 py-2">
          {(
            [
              ["zonas", `Zonas cargadas (${loadedAnalyses.length})`],
              ["tramos", `Tramos de la ruta (${routeSegments?.length ?? 0})`],
            ] as const
          ).map(([valor, etiqueta]) => (
            <button
              key={valor}
              type="button"
              onClick={() => setTabla(valor)}
              className={`cursor-pointer rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                tabla === valor
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {etiqueta}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          {tabla === "zonas" ? (
            loadedAnalyses.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                Ninguna zona cargada todavía. Se cargan desde el panel de la derecha.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableHead>Zona</TableHead>
                    <TableHead className="w-[7rem] text-right">
                      Volumen <span className="mono opacity-70">(m³)</span>
                    </TableHead>
                    <TableHead className="w-[7rem] text-right">
                      Área <span className="mono opacity-70">(m²)</span>
                    </TableHead>
                    <TableHead className="w-[7rem] text-right">
                      Peso <span className="mono opacity-70">(kg)</span>
                    </TableHead>
                    <TableHead className="w-[6rem]">Detecciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loadedAnalyses.map((a) => (
                    <TableRow
                      key={a.id}
                      onClick={() => {
                        setFocusPoint(a.center);
                      }}
                      title="Centrar el mapa en esta zona"
                      className="cursor-pointer hover:bg-card/60"
                    >
                      <TableCell className="text-xs font-medium">{a.name}</TableCell>
                      <TableCell className="mono text-right text-xs tabular-nums">
                        {a.summary.totalVolumeM3}
                      </TableCell>
                      <TableCell className="mono text-right text-xs tabular-nums">
                        {a.summary.totalAreaM2}
                      </TableCell>
                      <TableCell className="mono text-right text-xs tabular-nums">
                        {a.summary.totalWeightKg}
                      </TableCell>
                      <TableCell className="mono text-xs tabular-nums text-muted-foreground">
                        {a.detections.length}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          ) : !routeSegments || routeSegments.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              Todavía no hay una ruta generada. Los tramos aparecen acá al generarla.
            </p>
          ) : (
            // Tabla de tramos. Hoy muestra lo que el backend devuelve: origen,
            // camiones usados y las distancias y duraciones de ida y vuelta.
            //
            // Es también donde aterriza HDU5.1, que pide que "cada tramo del
            // plan muestre qué vehículo lo recorre, por patente y tipo, y su
            // personal asociado". Esas columnas se renderizan SOLO cuando el
            // backend las manda (son campos opcionales del contrato en
            // routePlan.ts): mientras no existan, la tabla muestra lo que hay.
            // No se dibujan columnas vacías ni guiones a la espera de un dato,
            // que es lo que convertiría una tabla en una promesa.
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="w-[3rem]">#</TableHead>
                  <TableHead>Origen</TableHead>
                  {hayVehiculo && <TableHead>Vehículo</TableHead>}
                  {hayDotacion && <TableHead>Personal</TableHead>}
                  <TableHead className="w-[7rem] text-right">Camiones</TableHead>
                  <TableHead className="w-[8rem] text-right">
                    Ida <span className="mono opacity-70">(km)</span>
                  </TableHead>
                  <TableHead className="w-[8rem] text-right">
                    Vuelta <span className="mono opacity-70">(km)</span>
                  </TableHead>
                  <TableHead className="w-[7rem] text-right">
                    Duración <span className="mono opacity-70">(h)</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {routeSegments.map((seg, i) => (
                  <TableRow key={i} className="hover:bg-card/60">
                    <TableCell className="mono text-xs tabular-nums text-muted-foreground">
                      {i + 1}
                    </TableCell>
                    <TableCell className="text-xs font-medium">{seg.originName}</TableCell>
                    {hayVehiculo && (
                      <TableCell className="text-xs">
                        {seg.vehicle ? (
                          <>
                            <span className="mono font-medium">{seg.vehicle.patente}</span>
                            <span className="ml-1.5 text-muted-foreground">{seg.vehicle.tipo}</span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">sin asignar</span>
                        )}
                      </TableCell>
                    )}
                    {hayDotacion && (
                      <TableCell className="text-xs text-muted-foreground">
                        {seg.crew && seg.crew.length > 0 ? seg.crew.join(", ") : "sin asignar"}
                      </TableCell>
                    )}
                    <TableCell className="mono text-right text-xs tabular-nums">
                      {seg.trucksUsed}
                    </TableCell>
                    <TableCell className="mono text-right text-xs tabular-nums">
                      {seg.outboundDistanceKm.toFixed(1)}
                    </TableCell>
                    <TableCell className="mono text-right text-xs tabular-nums">
                      {seg.returnDistanceKm.toFixed(1)}
                    </TableCell>
                    <TableCell className="mono text-right text-xs tabular-nums">
                      {(seg.outboundDurationHours + seg.returnDurationHours).toFixed(1)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      {/* AC4 — elegir uno o varios análisis guardados para cargar */}
      <Dialog open={loadDialogOpen} onOpenChange={setLoadDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cargar archivo de análisis</DialogTitle>
            <DialogDescription>
              Marca uno o más análisis guardados para agregar sus basurales al mapa.
            </DialogDescription>
          </DialogHeader>
          {loadingSaved ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : savedAnalyses.length === 0 ? (
            <p className="rounded-md border border-dashed border-border/50 py-6 text-center text-xs text-muted-foreground">
              Todavía no hay análisis guardados.
            </p>
          ) : (
            <ul className="max-h-80 space-y-1.5 overflow-y-auto">
              {savedAnalyses.map((record) => {
                const placeable = allAnalyses.some((a) => a.id === record.id);
                const alreadyLoaded = loadedIds.has(record.id);
                const checked = alreadyLoaded || selectedToLoad.has(record.id);
                // Un análisis ya cargado también se puede "descargar" desde
                // acá mismo, clickeándolo de nuevo — no hace falta ir hasta
                // "Análisis cargados" para eso. Solo lo no-ubicable (sin
                // CRS) queda realmente sin interacción.
                const toggle = () => {
                  if (!placeable) return;
                  if (alreadyLoaded) {
                    handleUnload(record.id);
                    return;
                  }
                  toggleSelectToLoad(record.id);
                };
                return (
                  <li
                    key={record.id}
                    role="checkbox"
                    aria-checked={checked}
                    aria-disabled={!placeable}
                    tabIndex={placeable ? 0 : -1}
                    onClick={toggle}
                    onKeyDown={(e) => {
                      if (!placeable) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle();
                      }
                    }}
                    title={
                      alreadyLoaded
                        ? "Quitar de la ruta"
                        : placeable
                          ? "Agregar a la ruta"
                          : undefined
                    }
                    className={`flex items-center gap-2 rounded-md border border-border/60 bg-background/60 p-2 ${
                      placeable ? "cursor-pointer transition-colors hover:bg-muted" : ""
                    }`}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={!placeable}
                      tabIndex={-1}
                      className="pointer-events-none"
                    />
                    <MapPin className="h-3.5 w-3.5 flex-shrink-0 text-primary/70" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{record.name}</p>
                      <p className="text-[0.625rem] text-muted-foreground">
                        {new Date(record.savedAt).toLocaleDateString("es-CL")}
                        {record.summary && ` · ${record.summary.totalVolumeM3} m³`}
                      </p>
                    </div>
                    {alreadyLoaded ? (
                      <span className="flex-shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[0.625rem] font-medium text-primary">
                        En la ruta
                      </span>
                    ) : !placeable ? (
                      <span className="flex-shrink-0 rounded-full bg-muted px-2 py-0.5 text-[0.625rem] font-medium text-muted-foreground">
                        No ubicable
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <DialogFooter>
            <Button onClick={handleLoadSelected} disabled={selectedToLoad.size === 0}>
              Cargar seleccionados{selectedToLoad.size > 0 ? ` (${selectedToLoad.size})` : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* "Zoom" de una zona: el mapa unificado real, con sus polígonos en
          precisión de píxel — mismo tipo de vista que /analysis. Se abre
          igual esté la zona cargada en la ruta o no. */}
      <Dialog
        open={zoomAnalysis !== null}
        onOpenChange={(open) => {
          if (!open) {
            setZoomAnalysis(null);
            setZoomImgSize(null);
            setZoomImgError(false);
          }
        }}
      >
        <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <DialogTitle>{zoomAnalysis?.name}</DialogTitle>
              {zoomAnalysis && (
                <span
                  className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${
                    loadedIds.has(zoomAnalysis.id)
                      ? "bg-primary/15 text-primary"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {loadedIds.has(zoomAnalysis.id) ? "En la ruta" : "No está en la ruta"}
                </span>
              )}
            </div>
            <DialogDescription>
              Mapa unificado real de esta zona, con los basurales detectados.
            </DialogDescription>
          </DialogHeader>
          {zoomAnalysis && (
            // Dos columnas parejas (imagen | información) para que el
            // diálogo quede simétrico, cerca de un cuadrado, en vez de una
            // franja angosta y muy alta.
            <div className="grid grid-cols-2 gap-4">
              {/* group acá arriba (no en el <button> de más abajo): la
                  etiqueta "Ver análisis" necesita pintar por ENCIMA del
                  <svg> de polígonos, que en el DOM viene después del
                  botón -- moverla afuera del botón, como último hijo de
                  este div, la deja arriba por simple orden de pintado, sin
                  depender de z-index contra un hermano de un ancestro. */}
              {/* detect-frame va en este contenedor, no en el <img>: así las
                  esquinas quedan en el marco del visor y no se recortan con el
                  rounded-md de la imagen. */}
              <div className="group relative detect-frame">
                <span className="detect-corners" aria-hidden="true" />
                {zoomImgError ? (
                  // El PNG no cargó (404) — probablemente se eliminó desde
                  // otra pestaña/sesión mientras esta zona seguía en
                  // memoria acá. Aviso claro en vez de un ícono de imagen
                  // rota o un overlay que nunca termina de aparecer.
                  <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/50 bg-muted/30 p-6 text-center">
                    <TriangleAlert className="h-6 w-6 flex-shrink-0 text-warning" />
                    <p className="text-xs text-muted-foreground">
                      No se pudo cargar el mapa de esta zona — puede que se haya eliminado desde
                      otra pestaña o sesión.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Placeholder mientras la imagen carga -- sin esto, el
                        <img> se renderizaba visible desde el primer byte,
                        mostrando el clásico efecto de PNG grande cargando
                        de arriba hacia abajo antes de que el overlay de
                        polígonos (que espera a onLoad) apareciera. Ahora
                        la imagen queda oculta hasta que termina de cargar
                        del todo, y aparece ya completa junto al overlay. */}
                    {!zoomImgSize && (
                      <div className="flex aspect-square w-full items-center justify-center rounded-md border border-border/40 bg-muted/20">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    )}
                    {/* <button> real (no un <img> con onClick suelto) — mismo
                        patrón que "Ver análisis de detección" en /carga:
                        cursor y estado hover garantizados por ser un
                        control nativo, con la etiqueta apareciendo al
                        pasar el mouse en vez de un cursor-pointer sin
                        ningún otro indicio visual. */}
                    <button
                      type="button"
                      onClick={() => {
                        setPendingOpenId(zoomAnalysis.id);
                        navigate({ to: "/analysis" });
                      }}
                      className={`block w-full cursor-pointer ${zoomImgSize ? "" : "hidden"}`}
                      title="Ver análisis de esta zona"
                    >
                      <img
                        src={zoomAnalysis.mapUrl}
                        alt={`Mapa unificado de ${zoomAnalysis.name}`}
                        className="w-full rounded-md transition-opacity group-hover:opacity-80"
                        decoding="async"
                        onLoad={(e) => {
                          const img = e.currentTarget;
                          setZoomImgSize({ w: img.naturalWidth, h: img.naturalHeight });
                        }}
                        onError={() => setZoomImgError(true)}
                      />
                    </button>
                  </>
                )}
                {!zoomImgError && zoomImgSize && (
                  <svg
                    viewBox={`0 0 ${zoomImgSize.w} ${zoomImgSize.h}`}
                    className="pointer-events-none absolute inset-0 h-full w-full"
                    preserveAspectRatio="xMidYMid meet"
                  >
                    {zoomAnalysis.detections.map((d) => {
                      const color = classColor(d.wasteClass);
                      const bw = d.bbox.maxx - d.bbox.minx;
                      const bh = d.bbox.maxy - d.bbox.miny;
                      return (
                        <g key={d.id}>
                          <rect
                            x={d.bbox.minx}
                            y={d.bbox.miny}
                            width={bw}
                            height={bh}
                            fill={color}
                            fillOpacity={0.35}
                            stroke={color}
                            strokeWidth={Math.max(2, zoomImgSize.w / 400)}
                            strokeLinejoin="round"
                          />
                          <text
                            x={d.bbox.minx}
                            y={d.bbox.miny - zoomImgSize.w / 200}
                            fontSize={Math.max(20, zoomImgSize.w / 60)}
                            fill={color}
                            fontFamily="monospace"
                            fontWeight="700"
                            paintOrder="stroke"
                            stroke="rgba(0,0,0,0.75)"
                            strokeWidth={zoomImgSize.w / 300}
                            strokeLinejoin="round"
                          >
                            {d.wasteClass}
                            {d.volumeM3 ? ` — ${d.volumeM3} m³` : ""}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                )}
                {!zoomImgError && zoomImgSize && (
                  // Último hijo del contenedor -> pinta por encima del <svg>
                  // de polígonos sin necesitar z-index. pointer-events-none
                  // para no tapar los clicks del <button> de más arriba
                  // (el pointer-events-none del svg ya deja pasar el click
                  // hacia el botón; este div necesita lo mismo).
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
                    <div className="flex items-center gap-2 rounded-md bg-background/85 px-4 py-2 shadow-xl backdrop-blur">
                      <MapIcon className="h-4 w-4 text-primary" />
                      <span className="text-sm font-semibold text-foreground">
                        Ver análisis de detección
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex min-h-0 flex-col gap-3">
                {zoomAnalysis.partial && (
                  <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-[0.625rem] text-muted-foreground">
                    <TriangleAlert className="h-3.5 w-3.5 flex-shrink-0 text-warning" />
                    <span>
                      Algunas zonas de este análisis no se pudieron ubicar en el mapa y no aparecen
                      abajo.
                    </span>
                  </div>
                )}

                {/* Resumen recalculado solo con las zonas efectivamente
                    ubicadas — ver computeSummary(). */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between rounded-md bg-background/40 p-2.5">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Boxes className="h-4 w-4 flex-shrink-0 text-primary/70" /> Volumen total
                    </span>
                    <span className="text-sm font-semibold">
                      {zoomAnalysis.summary.totalVolumeM3} m³
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-md bg-background/40 p-2.5">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Scale className="h-4 w-4 flex-shrink-0 text-primary/70" /> Peso total
                    </span>
                    <span className="text-sm font-semibold">
                      {zoomAnalysis.summary.totalWeightKg} kg
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-md bg-background/40 p-2.5">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Crosshair className="h-4 w-4 flex-shrink-0 text-primary/70" /> Área total
                    </span>
                    <span className="text-sm font-semibold">
                      {zoomAnalysis.summary.totalAreaM2} m²
                    </span>
                  </div>
                </div>

                {/* Zonas detectadas — mismo detalle que ya se ve en /analysis.
                    max-h fijo (no flex-1): el flex-1 dependía de una altura
                    real del grid de 2 columnas de arriba, que no la tiene
                    (las filas de grid se ajustan a su contenido por
                    default) -- con muchos tipos de basura, el scroll
                    terminaba pasando al DialogContent completo (imagen
                    incluida) en vez de quedar contenido solo en esta lista. */}
                <div className="flex flex-col">
                  <p className="mb-2 text-xs font-semibold text-muted-foreground">
                    Zonas detectadas
                  </p>
                  <ul className="max-h-[17.5rem] space-y-1.5 overflow-y-auto pr-0.5">
                    {zoomAnalysis.detections.map((d) => (
                      <li
                        key={d.id}
                        className="rounded-md border border-border/60 bg-background/60 p-2 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                            style={{ backgroundColor: classColor(d.wasteClass) }}
                          />
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {d.wasteClass}
                          </span>
                        </div>
                        <p className="mt-1 pl-4.5 text-muted-foreground">
                          {d.volumeM3 != null ? `${d.volumeM3} m³` : "—"}
                          {" · "}
                          {d.weightKg != null ? `${d.weightKg} kg` : "—"}
                          {" · "}
                          {d.areaM2 != null ? `${d.areaM2} m²` : "—"}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Ficha de datos de un punto (HDU6) — no hay mapa/imagen que ampliar
          como en zoomAnalysis, así que es una sola columna con la
          información del punto en modo solo lectura (mismos datos que
          recursos.tsx, sin poder editarlos desde acá). */}
      <Dialog open={zoomPoint !== null} onOpenChange={(open) => !open && setZoomPoint(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <DialogTitle>{zoomPoint?.name}</DialogTitle>
              {zoomPoint && (
                <span
                  className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${
                    zoomPoint.active
                      ? "bg-primary/15 text-primary"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {zoomPoint.active ? "Activo" : "Inactivo"}
                </span>
              )}
            </div>
            <DialogDescription>
              Punto de origen o destino para la generación de ruta.
            </DialogDescription>
          </DialogHeader>
          {zoomPoint && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 rounded-md bg-background/40 p-2.5">
                <MapPin className="h-4 w-4 flex-shrink-0 text-primary/70" />
                <span className="text-sm">
                  {zoomPoint.address}, {zoomPoint.comuna}
                </span>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground">Recursos disponibles</p>

                {/* Resumen calculado por el backend, no los contadores que el
                    punto guardaba: con HDU8 la maquinaria son recursos
                    individuales, y el detalle unidad por unidad vive en
                    /recursos, que es donde se administra. Acá lo que importa es
                    si este punto puede participar de una ruta y con cuánto. */}
                {/* "50 m³" y "20 de 21" son dos cifras que no se explican
                    entre sí: no se sabe cuáles de esas 20 unidades producen
                    esos 50 m³ ni por qué la otra no cuenta. Acá va el
                    desglose, que es lo que hace VISIBLE el AC5 de HDU8: al
                    marcar un recurso como no disponible se lo ve salir de la
                    cuenta y aparecer abajo con su motivo. */}
                <div className="grid grid-cols-2 gap-1.5">
                  <div className="rounded-md bg-background/40 p-2.5">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Boxes className="h-4 w-4 flex-shrink-0 text-primary/70" /> Capacidad
                    </span>
                    <p className="mono mt-1.5 text-sm font-semibold tabular-nums">
                      {zoomPoint.capacity_m3} m³
                    </p>
                  </div>
                  <div className="rounded-md bg-background/40 p-2.5">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Truck className="h-4 w-4 flex-shrink-0 text-primary/70" /> Cuentan
                    </span>
                    <p className="mono mt-1.5 text-sm font-semibold tabular-nums">
                      {resumenPunto.suman.length} de {zoomPoint.resource_count}
                    </p>
                  </div>
                </div>

                {(["no_disponible", "sin_capacidad", "no_transporta"] as const).map((motivo) =>
                  resumenPunto.fuera[motivo].length === 0 ? null : (
                    <div
                      key={motivo}
                      className="flex items-baseline justify-between gap-2 rounded-md bg-background/40 px-2.5 py-1.5"
                    >
                      <span className="text-[0.6875rem] text-muted-foreground">
                        Fuera, {TEXTO_FUERA_DE_RUTA[motivo]}
                      </span>
                      <span
                        className={`mono text-xs font-semibold tabular-nums ${
                          motivo === "sin_capacidad" ? "text-warning-strong" : "text-foreground"
                        }`}
                      >
                        {resumenPunto.fuera[motivo].length}
                      </span>
                    </div>
                  ),
                )}

                {/* Un punto con recursos pero sin capacidad disponible no puede
                    recibir volumen, y sin decirlo se vería como un origen
                    válido que después hace fallar la ruta sin motivo aparente. */}
                {zoomPoint.resource_count > 0 && zoomPoint.capacity_m3 === 0 && (
                  <p className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-[0.6875rem] leading-relaxed">
                    Este punto tiene recursos registrados pero ninguno con capacidad de transporte
                    disponible, así que no puede recibir zonas en una ruta.
                  </p>
                )}
                {zoomPoint.resource_count === 0 && (
                  <p className="rounded-md border border-border/60 bg-muted/40 px-2.5 py-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
                    Sin recursos registrados todavía. Se agregan desde Recursos Disponibles.
                  </p>
                )}

                {/* Acá iba "Personal", el contador del punto. Se fue junto
                    con su campo del formulario: la pregunta que importa no es
                    cuánta gente TIENE el punto sino quién va en cada tramo, y
                    eso es HDU5.1. Mostrando un 0 que ya nadie puede cambiar,
                    esta ficha decía que el punto no tiene personal, que es
                    falso. El dato sigue guardado en la base. */}
              </div>

              <p className="flex items-center gap-2 rounded-md border border-dashed border-border/60 p-2.5 text-xs text-muted-foreground">
                <Warehouse className="h-4 w-4 flex-shrink-0" />
                Se editan en el bloque Puntos
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* AC1 — confirmación antes de generar la ruta */}
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) handleCancelConfirm();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generar ruta óptima</DialogTitle>
            <DialogDescription>Confirma los datos antes de generar la ruta.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Puntos activos</p>
              {loadingPoints ? (
                <div className="flex justify-center py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : activePoints.length === 0 ? (
                <p className="rounded-md border border-dashed border-border/50 py-3 text-center text-xs text-muted-foreground">
                  No hay puntos activos. Revísalos en el bloque Puntos.
                </p>
              ) : (
                // Cada punto con lo que REALMENTE aporta, no solo su nombre.
                // Antes esta lista decía cuáles participan pero no con cuánto,
                // así que la ruta se mandaba a generar sin saber si había
                // capacidad para ella, y un "infeasible" después no tenía
                // ninguna explicación a la vista.
                <ul className="max-h-32 space-y-1 overflow-y-auto">
                  {activePoints.map((p) => {
                    const resumen = resumenParaRuta(recursosPorPunto[p.id] ?? []);
                    return (
                      <li
                        key={p.id}
                        className="flex items-baseline justify-between gap-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-xs"
                      >
                        <span className="truncate">{p.name}</span>
                        <span className="mono flex-shrink-0 tabular-nums text-muted-foreground">
                          {resumen.suman.length} u · {resumen.capacidad} m³
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="available-hours"
                className="text-xs font-medium text-muted-foreground"
              >
                Horas disponibles
              </label>
              <Input
                id="available-hours"
                type="number"
                min={0}
                value={availableHours}
                onChange={(e) => setAvailableHours(e.target.value)}
                className={
                  !hoursValid ? "border-destructive focus-visible:ring-destructive" : undefined
                }
              />
              {!hoursValid && (
                <p className="text-[0.625rem] text-destructive">
                  Ingresa un número de horas mayor a 0.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Tipo de basura prioritario
              </label>
              <Select value={priorityWasteType} onValueChange={setPriorityWasteType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sin prioridad</SelectItem>
                  {WASTE_CLASSES.map((cls) => (
                    <SelectItem key={cls} value={cls}>
                      {cls}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={handleCancelConfirm} disabled={generating}>
              Cancelar
            </Button>
            <Button
              onClick={handleGenerateRoute}
              disabled={generating || !hoursValid || activePoints.length === 0}
            >
              {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Generar ruta
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Una cifra de la cabecera. Sin ícono ni pastilla: son cuatro seguidas y a
 *  este tamaño lo que las separa es el divisor vertical, no un adorno por
 *  cifra. */
function CifraCabecera({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="flex-shrink-0 px-4">
      <p className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">{etiqueta}</p>
      <p className="mono text-lg font-semibold tabular-nums text-foreground">{valor}</p>
    </div>
  );
}
