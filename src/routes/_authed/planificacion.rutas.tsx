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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRightCircle,
  Boxes,
  Pencil,
  Plus,
  Clock,
  Construction,
  Crosshair,
  Layers,
  Trash2,
  FolderOpen,
  Loader2,
  Map as MapIcon,
  MapPin,
  Route as RouteIcon,
  Scale,
  Search,
  Star,
  StarFill,
  TriangleAlert,
  Truck,
  Users,
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
  createWorker,
  deleteWorker,
  listResourcePoints,
  listResources,
  listWorkers,
  nombresRepetidos,
  ROLES,
  updateWorker,
  type Persona,
  type RolPersonal,
  resourcePhotoUrl,
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
import { RELLENO_SANITARIO } from "@/lib/disposalSite";
import { projectPolygonToWgs84 } from "@/lib/projection";
import {
  generateRoute,
  type RoutePlanSegment,
  type RoutePlanStop,
  type RoutePlanUnassigned,
  type RoutePlanVehicle,
} from "@/lib/routePlan";
import { RouteTimeline, type DatosDeParada } from "@/components/RouteTimeline";
import { reverseGeocode } from "@/lib/geocoding";
import { notify } from "@/lib/notify";
// Aca se importaban ROUTE_OUTBOUND_COLOR/RETURN_COLOR/RETURN_OPACITY para
// armar la leyenda de colores del trazo. La leyenda se elimino junto con las
// burbujas sobre el mapa, y los imports quedaron sin uso: afirmaban que esta
// vista todavia dibujaba una. Los colores siguen viviendo en route-colors.ts,
// que es desde donde GeoMapImpl.tsx los dibuja.

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
  /** Si el trabajador la dejó activa en la vista de análisis. Ausente en los
   *  análisis guardados antes de que el campo existiera, y ahí significa
   *  activa. */
  enabled?: boolean;
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
    // Las detecciones que el trabajador desactivó en la vista de análisis NO
    // entran. Esta vista las estaba contando, así que el volumen de una zona
    // acá podía no coincidir con el que muestran Vista Principal y la vista de
    // análisis, que sí respetan la bandera. El plan en sí no estaba mal, porque
    // routing.py resuelve los volúmenes contra Mongo por su cuenta, pero la
    // cifra que el trabajador leía antes de generar la ruta sí lo estaba.
    if (d.enabled === false) continue;
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

  // Zonas marcadas como prioritarias: entran al plan antes que el resto y son
  // las últimas en salir cuando la capacidad o las horas obligan a recortar.
  //
  // Vive acá, en la vista, y no en Mongo: es una decisión de ESTE plan. Que una
  // zona sea urgente hoy, por un reclamo o por estar al lado de un colegio, es
  // información que el sistema no tiene forma de deducir, y tampoco es un
  // atributo permanente del basural. Guardarla convertiría la urgencia de una
  // jornada en una propiedad de la zona, y la siguiente ruta la arrastraría sin
  // que nadie la haya vuelto a pedir.
  //
  // La lista las sube al tope (ver `zonasOrdenadas` más abajo): la lista hace
  // scroll a partir de la cuarta fila, así que una zona marcada podía quedar
  // fuera de la vista y la marca dejaba de ser verificable justo cuando hay
  // muchas zonas, que es cuando sirve.
  const [prioritarias, setPrioritarias] = useState<Set<string>>(new Set());
  const togglePrioritaria = (id: string) => {
    setPrioritarias((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

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
  // El cajón de detalle arranca plegado: al entrar, lo que importa es el mapa
  // y el panel, no una tabla de cifras que todavía no tiene nada que comparar.
  // Qué recorrido se está mirando en detalle, o null si se está viendo el plan
  // completo. Es el índice dentro de routeSegments y no el objeto: así, cuando
  // se regenera la ruta, el detalle abierto apunta al recorrido equivalente del
  // plan nuevo en vez de a uno que ya no existe.
  const [rutaAbierta, setRutaAbierta] = useState<number | null>(null);
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

  /** Saca UN recorrido del plan, con su trazo del mapa. El resto del plan
   *  sigue en pie, que es la diferencia con descartar la ruta entera.
   *
   *  Las paradas de ese recorrido NO se quitan, y no es un olvido: hoy
   *  `route.stops` llega como una lista plana sin dueño, así que la vista no
   *  tiene cómo saber cuáles eran suyas. Cuando el backend mande `stopOrders`
   *  por segmento (ya está declarado en routePlan.ts), esta función las quita
   *  también. Con un solo punto de origen, que es el caso de hoy, descartar el
   *  único recorrido equivale a descartar el plan, así que la diferencia no se
   *  nota todavía. */
  const descartarRecorrido = (indice: number) => {
    const quedan = (routeSegments ?? []).filter((_, i) => i !== indice);
    if (quedan.length === 0) {
      descartarRuta();
      return;
    }
    const sinEl = <T,>(xs: T[] | null) => (xs ? xs.filter((_, i) => i !== indice) : null);
    setRouteSegments(quedan);
    setRouteOutboundPaths(sinEl(routeOutboundPaths));
    setRouteDisposalPaths(sinEl(routeDisposalPaths));
    setRouteReturnPaths(sinEl(routeReturnPaths));
    // El detalle abierto se corrige: si se borró el que se estaba mirando se
    // vuelve a la lista, y si se borró uno anterior el índice del que queda
    // abierto se corrió en uno.
    setRutaAbierta((abierta) => {
      if (abierta === null) return null;
      if (abierta === indice) return null;
      return abierta > indice ? abierta - 1 : abierta;
    });
    // Los totales del plan dejan de corresponder: el backend los mandó para el
    // plan completo. Se ponen en null y la vista vuelve a sumar los segmentos
    // que quedan, que es el camino que ya tenía previsto.
    setRouteTotals(null);
  };

  /** Descarta el plan y deja la vista como antes de generarlo. Una sola
   *  función porque son seis estados que tienen que caer juntos: sueltos, el
   *  mapa quedaba con el trazo de una ruta que el panel ya no mostraba. */
  const descartarRuta = () => {
    setRutaAbierta(null);
    setRouteStops(null);
    setRouteOutboundPaths(null);
    setRouteDisposalPaths(null);
    setRouteReturnPaths(null);
    setRouteSegments(null);
    setRouteTotals(null);
    setUnassigned(null);
    setSalidaPlan(null);
    setRouteError(null);
  };
  /** Desglose de la flota del punto abierto en la ficha. */
  const resumenPunto = resumenParaRuta(zoomPoint ? (recursosPorPunto[zoomPoint.id] ?? []) : []);

  // AC1 — confirmación.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loadingPoints, setLoadingPoints] = useState(false);
  const [availableHours, setAvailableHours] = useState("8");
  const [priorityWasteType, setPriorityWasteType] = useState<string>("none");

  /** La cuadrilla declarada para hoy (AC1 y AC2 de HDU5.1).
   *
   *  Vive en el servidor: empezó en el navegador para no almacenar datos
   *  personales, y se movió a pedido del equipo, porque una lista que no se
   *  comparte entre equipos obliga a reescribirla en cada máquina. */
  const [cuadrilla, setCuadrilla] = useState<Persona[]>([]);
  const [buscandoPersonal, setBuscandoPersonal] = useState("");
  const [guardandoPersona, setGuardandoPersona] = useState(false);
  /** Filas recién agregadas que el trabajador todavía no terminó de escribir.
   *
   *  Una fila nueva nace vacía porque existe para llenarse, así que avisar que
   *  "no entra en el plan" en el mismo instante en que aparece es regañar por
   *  algo que nadie hizo todavía. El aviso aparece recién cuando el campo se
   *  deja, que es cuando el blanco pasa de ser un estado intermedio a ser una
   *  decisión.
   *
   *  Solo las de ESTA sesión: una fila vacía que vuelve del servidor quedó
   *  abandonada en algún momento anterior, y esa sí hay que señalarla. */
  const [recienAgregadas, setRecienAgregadas] = useState<Set<string>>(new Set());
  const sinTerminar = (p: Persona) =>
    p.disponible && !p.nombre.trim() && !recienAgregadas.has(p.id);

  const recargarCuadrilla = useCallback(() => {
    listWorkers()
      .then(setCuadrilla)
      .catch(() => {});
  }, []);
  useEffect(recargarCuadrilla, [recargarCuadrilla]);

  /** Escribe el cambio en el servidor y refleja la respuesta.
   *
   *  Optimista en la tabla local primero: marcar una casilla tiene que sentirse
   *  inmediato, y el viaje de red no debería notarse. Si falla, se recarga desde
   *  el servidor en vez de dejar la vista afirmando un estado que no se guardó. */
  const cambiarPersona = async (persona: Persona, cambios: Partial<Persona>) => {
    const optimista = { ...persona, ...cambios };
    setCuadrilla((prev) => prev.map((x) => (x.id === persona.id ? optimista : x)));
    try {
      const { id: _id, ...entrada } = optimista;
      const guardada = await updateWorker(persona.id, entrada);
      setCuadrilla((prev) => prev.map((x) => (x.id === persona.id ? guardada : x)));
    } catch (err) {
      notify.error(
        "No se pudo guardar el cambio",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
      recargarCuadrilla();
    }
  };

  const agregarPersona = async () => {
    setGuardandoPersona(true);
    try {
      const puntoDestino = activePoints[0]?.id ?? originPoints[0]?.id;
      if (!puntoDestino) {
        notify.warning("No hay ningún punto", "Crea un punto antes de agregar personal.");
        return;
      }
      const nueva = await createWorker({
        nombre: "",
        rol: "conductor",
        disponible: true,
        point_id: puntoDestino,
      });
      setCuadrilla((prev) => [...prev, nueva]);
      setRecienAgregadas((prev) => new Set(prev).add(nueva.id));
    } catch (err) {
      notify.error(
        "No se pudo agregar a la persona",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
    } finally {
      setGuardandoPersona(false);
    }
  };

  const quitarPersona = async (persona: Persona) => {
    setCuadrilla((prev) => prev.filter((x) => x.id !== persona.id));
    try {
      await deleteWorker(persona.id);
    } catch {
      recargarCuadrilla();
    }
  };

  const repetidos = nombresRepetidos(cuadrilla);
  const cuadrillaDeHoy = cuadrilla.filter((p) => p.disponible && p.nombre.trim());

  /** Cuántos hay marcados de cada rol. Es la cifra que decide qué vehículos
   *  pueden salir, y sin ella hay que contar filas a ojo en una lista que
   *  además está filtrada por el buscador. */
  const resumenCuadrilla = ROLES.map((r) => ({
    ...r,
    cantidad: cuadrillaDeHoy.filter((p) => p.rol === r.valor).length,
  }));

  const cuadrillaFiltrada = buscandoPersonal.trim()
    ? cuadrilla.filter((p) =>
        p.nombre.toLowerCase().includes(buscandoPersonal.trim().toLowerCase()),
      )
    : cuadrilla;

  /** La dotación que haría falta para tripular toda la flota disponible.
   *
   *  Es lo que se le dice al trabajador cuando no marcó a nadie: la ruta se
   *  genera igual, y conviene que sepa CUÁNTA gente haría falta. Cuánta y no
   *  quiénes, porque el sistema no tiene cómo saber quiénes. */
  const dotacionNecesaria = ROLES.map((r) => {
    const campo = (
      {
        conductor: "conductores_requeridos",
        peoneta: "peonetas_requeridas",
        operador: "operadores_requeridos",
      } as const
    )[r.valor];
    const total = activePoints.reduce(
      (suma, punto) =>
        suma +
        (recursosPorPunto[punto.id] ?? [])
          .filter((u) => u.disponible && u.familia === "carga" && u.capacidad_m3)
          .reduce((s, u) => s + (u[campo] ?? 0), 0),
      0,
    );
    return { ...r, total };
  }).filter((r) => r.total > 0);

  // AC2/AC6.
  const [generating, setGenerating] = useState(false);
  // RoutePlanStop y no una forma propia: la parada trae ahora `analysisId`, que
  // es lo que permite mostrar el volumen de cada zona en la línea de tiempo sin
  // volver a pedirlo por la red.
  const [routeStops, setRouteStops] = useState<RoutePlanStop[] | null>(null);
  // Trazos reales (calles, vía OSRM) de ida/vuelta -- separados para
  // pintarlos con estilos distintos (ver GeoMapImpl.tsx). Null hasta que
  // se genera una ruta con éxito.
  const [routeOutboundPaths, setRouteOutboundPaths] = useState<[number, number][][] | null>(null);
  const [routeDisposalPaths, setRouteDisposalPaths] = useState<[number, number][][] | null>(null);
  /** Vehiculo cuya foto se esta mirando, o null. Un trabajador reconoce "el
   *  ampliroll amarillo" antes que "KBVZ-41", asi que la foto es lo que
   *  convierte una patente en un vehiculo identificable en el patio. */
  const [vehiculoEnFoto, setVehiculoEnFoto] = useState<RoutePlanVehicle | null>(null);
  const [routeReturnPaths, setRouteReturnPaths] = useState<[number, number][][] | null>(null);
  // Resumen por sub-ruta/origen (mismo índice que los paths de arriba) --
  // para la leyenda (ida/vuelta por separado) y las ventanas flotantes
  // sobre cada tramo del mapa. null hasta que hay una ruta exitosa.
  const [routeSegments, setRouteSegments] = useState<RoutePlanSegment[] | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  // Totales del plan, para las dos cifras grandes del panel.
  const [routeTotals, setRouteTotals] = useState<{
    distanceKm?: number;
    durationHours?: number;
    volumeM3?: number;
    /** HDU5.1/AC5. Viaja con los totales y no en un estado aparte porque es una
     *  propiedad del plan generado, igual que sus cifras: describe con qué se
     *  calcularon, así que se guarda y se limpia junto con ellas. */
    trafficAware?: boolean;
  } | null>(null);
  // HDU5.1/AC6. Ausente mientras el backend no lo calcule, y entonces la
  // sección no se dibuja: una lista vacía de "zonas sin asignar" se lee como
  // que todas entraron, y eso todavía no lo podemos afirmar.
  const [unassigned, setUnassigned] = useState<RoutePlanUnassigned[] | null>(null);
  /** Cuándo empieza el plan. Se captura al generarlo y NO se recalcula: si
   *  fuera la hora actual en cada render, las horas de llegada correrían solas
   *  mientras el trabajador lee la pantalla, y un plan cuyas horas cambian por
   *  el solo hecho de mirarlo no sirve para coordinar a nadie. */
  const [salidaPlan, setSalidaPlan] = useState<Date | null>(null);

  // Acá vivían `hayVehiculo` y `hayDotacion`, que preguntaban si el backend ya
  // mandaba los datos del AC7 para decidir si dibujar sus columnas. Quedaron sin
  // uso cuando el vehículo y la dotación pasaron a mostrarse DENTRO de la línea
  // de tiempo, en el nodo de salida de cada recorrido (RouteTimeline.tsx), que
  // hace la misma pregunta pero por segmento: con varios puntos de origen, un
  // recorrido puede traer su patente y el otro no, y una bandera global los
  // trataba a los dos igual.

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
    // La marca de prioridad se va con la zona. El backend igual cruza los ids
    // marcados contra los cargados, así que dejarla no cambiaría ninguna ruta,
    // pero sí la interfaz: al volver a cargar la zona reaparecería con la
    // estrella encendida sin que nadie la haya vuelto a marcar.
    setPrioritarias((prev) => {
      if (!prev.has(id)) return prev;
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
      // Se filtra contra las cargadas antes de salir. El backend hace la misma
      // intersección por su cuenta (no confía en lo que mande el navegador),
      // pero mandar un id que no está en la ruta igual sería mandar una
      // contradicción, y el contrato se lee mejor sin ella.
      priorityAnalysisIds: Array.from(prioritarias).filter((id) => loadedIds.has(id)),
      // Solo las marcadas, y sin el id local ni la bandera, que son de la
      // vista. Lista vacía = el backend no restringe por personal.
      personal: cuadrillaDeHoy.map((p) => ({ nombre: p.nombre.trim(), rol: p.rol })),
    });
    setGenerating(false);
    setConfirmOpen(false);

    if (result.status === "success") {
      setRouteStops(result.route.stops);
      setRouteOutboundPaths(result.route.outboundPaths ?? null);
      setRouteDisposalPaths(result.route.disposalPaths ?? null);
      setRouteReturnPaths(result.route.returnPaths ?? null);
      setRouteSegments(result.route.segments ?? null);
      setRouteTotals({
        distanceKm: result.route.totalDistanceKm,
        durationHours: result.route.totalDurationHours,
        volumeM3: result.route.totalVolumeM3,
        trafficAware: result.route.trafficAware,
      });
      setUnassigned(result.route.unassignedZones ?? null);
      setSalidaPlan(new Date());
      setRouteError(null);
      // Con UN recorrido se entra directo a su detalle: es lo que el trabajador
      // viene a ver, y dejarlo en la lista lo obliga a apretar el único
      // elemento que hay. Con varios, en cambio, la lista es la información:
      // saltar al primero escondería que hay más de uno.
      setRutaAbierta(result.route.segments?.length === 1 ? 0 : null);
      notify.success("Ruta generada", "Revisa el orden de paradas propuesto en el panel.");
    } else {
      setRouteStops(null);
      setRouteOutboundPaths(null);
      setRouteDisposalPaths(null);
      setRouteReturnPaths(null);
      setRouteSegments(null);
      setRouteTotals(null);
      setUnassigned(null);
      setSalidaPlan(null);
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
      previewSubtitle: `${a.summary.totalVolumeM3} m³, ${a.summary.totalWeightKg} kg, ${a.detections.length} zona${
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
      label: p.active ? `${p.name}, ${capacityLabel}` : `${p.name} (inactivo), ${capacityLabel}`,
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
    if (routeOutboundPaths || routeDisposalPaths || routeReturnPaths) {
      return [
        ...(routeOutboundPaths ?? []).flat(),
        // El relleno queda al poniente de la comuna, bastante lejos de las
        // zonas: sin este tramo el encuadre automatico lo dejaba fuera de
        // pantalla y el plan parecia terminar en la ultima zona.
        ...(routeDisposalPaths ?? []).flat(),
        ...(routeReturnPaths ?? []).flat(),
        // El relleno sanitario entra al encuadre de la ruta, aunque el trazo
        // todavía no pase por él. Está al poniente del casco urbano, fuera de
        // la caja con la que abre el mapa, así que sin incluirlo acá el
        // marcador existe y no se ve nunca. Y es información de la ruta: es a
        // dónde va lo que se retira.
        RELLENO_SANITARIO.position,
      ];
    }
    return routePositions;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeOutboundPaths, routeDisposalPaths, routeReturnPaths]);

  // Cifras de cabecera. Las cuatro responden la pregunta con la que se entra a
  // esta vista: con qué cuento y cuánto hay que retirar.
  // ── Lo que el panel del plan necesita derivar ─────────────────────────────

  /** Qué zona es cada parada de un recorrido, con lo que hace falta para
   *  dibujarla: dónde queda, cuánto hay y de qué es.
   *
   *  Resuelve por `analysisId` cuando la parada lo trae, y cae a emparejar por
   *  NOMBRE cuando no. El respaldo existe porque el backend todavía no manda
   *  ese campo, y sin él la línea de tiempo muestra paradas mudas aunque la
   *  vista tenga los datos a mano. Es deliberadamente estricto: solo empareja
   *  si hay UNA zona cargada con ese nombre exacto, porque con dos zonas
   *  homónimas adivinar cuál es sería peor que no mostrar nada. */
  const datosDeParada = (stop: RoutePlanStop): DatosDeParada | undefined => {
    let zona = stop.analysisId ? loadedAnalyses.find((a) => a.id === stop.analysisId) : undefined;
    if (!zona) {
      const porNombre = loadedAnalyses.filter((a) => a.name === stop.label);
      if (porNombre.length === 1) zona = porNombre[0];
    }
    if (!zona) return undefined;
    return {
      volumeM3: zona.summary.totalVolumeM3,
      weightKg: zona.summary.totalWeightKg,
      wasteTypes: tiposDeZona(zona),
      wasteColor: classColor,
      direccion: direcciones[zona.id] || undefined,
    };
  };

  /** Los totales del plan. El backend puede mandarlos ya sumados; si no lo
   *  hace, se suman los segmentos, que es exactamente lo mismo. Sin esto, dos
   *  backends igualmente correctos darían paneles distintos. */
  const distanciaDelPlan =
    routeTotals?.distanceKm != null
      ? `${routeTotals.distanceKm.toFixed(1)} km`
      : routeSegments
        ? `${routeSegments
            .reduce(
              (t, x) => t + x.outboundDistanceKm + (x.disposalDistanceKm ?? 0) + x.returnDistanceKm,
              0,
            )
            .toFixed(1)} km`
        : "sin dato";

  const duracionDelPlan =
    routeTotals?.durationHours != null
      ? formatDuration(routeTotals.durationHours)
      : routeSegments
        ? formatDuration(
            routeSegments.reduce(
              (t, x) =>
                t +
                x.outboundDurationHours +
                (x.disposalDurationHours ?? 0) +
                x.returnDurationHours,
              0,
            ),
          )
        : "sin dato";

  /** Volumen cargado, sumando lo que las filas MUESTRAN y no el dato crudo.
   *
   *  Parece lo mismo y no lo es: cada fila imprime su volumen con dos
   *  decimales, así que sumar los valores sin redondear y después redondear el
   *  total da una cifra que no coincide con la suma de lo que se ve. Con dos
   *  zonas de 3,33 y 3,61 la cabecera decía 6,9, y el lector que suma a mano
   *  obtiene 6,94 y concluye, con razón, que una de las dos cifras está mal.
   *  Un total que no cuadra con su detalle no es un redondeo, es un error. */
  const volumenCargado = loadedAnalyses.reduce(
    (suma, a) => suma + Number(a.summary.totalVolumeM3.toFixed(2)),
    0,
  );

  /** Las zonas cargadas con las prioritarias arriba, que es el orden en el que
   *  se LISTAN. No es el orden en el que se visitan: eso lo decide el backend
   *  contra la matriz de tiempos de OSRM, y esta lista no tiene nada que decir
   *  al respecto.
   *
   *  Copia antes de ordenar, y sobre `loadedAnalyses` y no sobre `allAnalyses`:
   *  `sort` muta, y `allAnalyses` es la fuente de los círculos del mapa. El
   *  orden relativo del resto se conserva porque `sort` es estable. */
  const zonasOrdenadas = [...loadedAnalyses].sort(
    (a, b) => Number(prioritarias.has(b.id)) - Number(prioritarias.has(a.id)),
  );
  const cantidadPrioritarias = loadedAnalyses.filter((a) => prioritarias.has(a.id)).length;

  /** Dirección de cada zona cargada, resuelta contra Nominatim a partir de su
   *  centro. Una zona se llama "Zona A", que no dice dónde queda; la dirección
   *  sí, y es lo que un trabajador necesita para reconocerla en terreno.
   *
   *  Se pide UNA sola vez por zona y queda en caché mientras dure la vista.
   *  Nominatim pide no más de una consulta por segundo, así que las zonas
   *  nuevas se resuelven de a una y con pausa, en vez de disparar todas juntas
   *  al cargar varias: es el mismo servicio que usa el formulario de puntos y
   *  no queremos que nos corte por abuso. */
  const [direcciones, setDirecciones] = useState<Record<string, string>>({});
  useEffect(() => {
    const faltantes = loadedAnalyses.filter((a) => !(a.id in direcciones));
    if (faltantes.length === 0) return;
    let vivo = true;
    (async () => {
      for (const a of faltantes) {
        const r = await reverseGeocode(a.center[0], a.center[1]);
        if (!vivo) return;
        // Se guarda incluso el fallo, como cadena vacía: sin eso, una zona que
        // Nominatim no resuelve se volvería a pedir en cada render.
        setDirecciones((prev) => ({
          ...prev,
          [a.id]: r ? [r.address, r.comuna].filter(Boolean).join(", ") : "",
        }));
        await new Promise((listo) => setTimeout(listo, 1100));
      }
    })();
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedAnalyses]);

  /** Los tipos de residuo de una zona, ordenados por cuánto volumen aporta
   *  cada uno. El primero es el que la caracteriza. */
  const tiposDeZona = (a: LoadedAnalysis) => {
    const porClase: Record<string, number> = {};
    for (const d of a.detections) {
      porClase[d.wasteClass] = (porClase[d.wasteClass] ?? 0) + (d.volumeM3 ?? 0);
    }
    return Object.entries(porClase).sort((x, y) => y[1] - x[1]);
  };

  const totalesCabecera = {
    puntos: activePoints.length,
    capacidad: originPoints.reduce((sum, p) => sum + p.capacity_m3, 0),
    zonas: loadedAnalyses.length,
    volumen: volumenCargado,
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Cabecera y franja de cifras a lo ancho, arriba de todo. Es la
          estructura de un tablero de operaciones: primero el estado general,
          después el mapa con su panel, y al pie el detalle en tabla. */}
      {/* Cabecera con el mismo tratamiento .panel e íconos que la vista de
          recursos. Las cuatro cifras estaban sueltas sobre el fondo, alineadas
          a la derecha del título, sin superficie propia y compitiendo con él
          por la misma línea.

          El orden no es casual y es lo que hace útil la franja: capacidad y
          volumen a retirar son LA comparación que decide si un plan es posible,
          así que van una al lado de la otra, y cada una junto al número que la
          explica (cuántos puntos aportan esa capacidad, cuántas zonas ese
          volumen). Leída de izquierda a derecha dice "tengo esto, tengo que
          mover esto otro".

          Los íconos siguen la misma convención que el resto del sistema: el
          cubo es siempre capacidad, y el residuo a retirar lleva el suyo
          propio para no repetir el cubo con dos significados. */}
      <div className="flex flex-wrap items-end justify-between gap-4 px-6 pb-4 pt-4">
        <div>
          <p className="eyebrow">Planificación</p>
          <h1 className="font-rubik text-3xl font-semibold tracking-normal text-foreground md:text-4xl">
            Planificar Retiro
          </h1>
        </div>
      </div>
      <div className="px-6 pb-4">
        <div className="panel flex flex-wrap items-center divide-x divide-border/10 px-1">
          <CifraCabecera
            icono={<MapPin className="h-4 w-4" />}
            etiqueta="Puntos activos"
            valor={String(totalesCabecera.puntos)}
          />
          <CifraCabecera
            icono={<Boxes className="h-4 w-4" />}
            etiqueta="Capacidad"
            valor={`${totalesCabecera.capacidad} m³`}
          />
          <CifraCabecera
            icono={<Layers className="h-4 w-4" />}
            etiqueta="Zonas cargadas"
            valor={String(totalesCabecera.zonas)}
          />
          <CifraCabecera
            icono={<Construction className="h-4 w-4" />}
            etiqueta="Volumen a retirar"
            valor={`${totalesCabecera.volumen.toFixed(2)} m³`}
          />
          {/* La holgura, que es la lectura que las dos cifras de m³ piden y
              que nadie debería tener que hacer de cabeza. Solo aparece cuando
              hay zonas cargadas: sin nada que retirar no hay nada que comparar. */}
          {totalesCabecera.zonas > 0 && (
            <div className="ml-auto flex flex-shrink-0 items-center gap-2 border-l-0 px-5 py-3.5">
              <span
                className={`rounded px-2 py-1 text-[0.6875rem] font-semibold ${
                  totalesCabecera.volumen <= totalesCabecera.capacidad
                    ? "bg-success/15 text-success-strong"
                    : "bg-warning/15 text-warning-strong"
                }`}
              >
                {totalesCabecera.volumen <= totalesCabecera.capacidad
                  ? `Alcanza, sobran ${(totalesCabecera.capacidad - totalesCabecera.volumen).toFixed(1)} m³`
                  : `Faltan ${(totalesCabecera.volumen - totalesCabecera.capacidad).toFixed(1)} m³ de capacidad`}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* El mapa a la IZQUIERDA y grande, el panel a la derecha. Era al revés,
          con el panel ocupando la columna de lectura y el mapa relegado: acá el
          mapa es el contenido y el panel son los controles. */}
      {/* Panel y mapa son dos BLOQUES hermanos de la misma grilla, cada uno
          con su superficie y su marco.

          El panel estuvo flotando sobre un mapa a sangre, y se revirtió: un
          mapa sin borde llega hasta el último pixel de la página y no se sabe
          dónde termina el mapa y dónde empieza la interfaz, así que se lee como
          si se derramara. Acotado, el mapa es una pieza más de la página, del
          mismo peso visual que el panel de al lado, y el panel deja de tapar
          parte del territorio que el trabajador necesita ver.

          El alto lo fija la fila: los dos bloques miden exactamente lo mismo,
          que es lo que evita el escalón al pie que deja una columna más corta
          que la otra. */}
      <main className="grid min-h-0 flex-1 gap-5 px-6 pb-6 lg:grid-cols-[clamp(21rem,30vw,28rem)_1fr]">
        <section className="map-frame order-2 min-h-[24rem] min-w-0 bg-background animate-in fade-in duration-500 lg:min-h-0">
          <GeoMap
            className="h-full w-full"
            points={mapPoints}
            onPointClick={handlePointClick}
            // Apretar el trazo abre SU recorrido en el panel. El mapa dice
            // dónde va la ruta y el panel dice qué pasa en ella; sin esto, la
            // única forma de pasar de uno al otro era buscar el recorrido en
            // la lista a mano.
            onRouteClick={setRutaAbierta}
            disposalSite={RELLENO_SANITARIO}
            routePositions={routePositions}
            outboundPaths={routeOutboundPaths}
            disposalPaths={routeDisposalPaths}
            returnPaths={routeReturnPaths}
            routeSegments={routeSegments}
            // El recentrado manual gana sobre el encuadre automático de la
            // ruta: es una acción explícita y reciente del usuario.
            // Sin fitPadLeft: el panel dejó de flotar sobre el mapa, así que
            // el encuadre ya no tiene nada que esquivar.
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
            className="absolute right-4 top-4 z-[550] shadow-md"
          >
            <Crosshair className="mr-1.5 h-3.5 w-3.5" /> Centrar en Maipú
          </Button>

          {mapDataLoading && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/60">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </section>

        {/* ── Panel del plan ──────────────────────────────────────────────
            Flota sobre el mapa, con margen, y de alto completo. Es el único
            lugar donde se lee la planificación: acá viven las zonas cargadas y
            los recorridos, que antes estaban repartidos entre el panel y una
            tabla al pie con pestañas.

            Esa tabla se eliminó, y no porque estorbara: mientras las dos
            listas vivían en pestañas, ver una obligaba a dejar de ver la otra,
            y la pregunta de la planificación es precisamente cuánto hay que
            retirar CONTRA con qué se cuenta. Juntas en una columna se leen a la
            vez. Ningún criterio de HDU5 ni de HDU5.1 pide una tabla: el más
            cercano habla de cargar los polígonos "junto con su metadata", y eso
            lo cumple cada fila con su volumen, su área y su peso.

            Dos niveles, no pestañas: la lista de recorridos, y el detalle de
            uno. Se entra apretando un recorrido y se vuelve con la flecha, que
            es la misma navegación de una bandeja de correo. */}
        {/* El panel va PRIMERO en las dos direcciones, y el `order` no se
            resetea en pantalla ancha: la grilla declara la columna angosta a la
            izquierda, así que dejar que mandara el orden del código ponía el
            mapa en esa columna y el panel en la ancha, al revés. En una
            columna, el panel arriba es lo correcto: es desde donde se carga y
            se genera. */}
        <aside className="order-1 flex min-h-0 flex-col">
          <div className="panel flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
            <div className="flex items-start justify-between gap-2 border-b border-border/60 px-4 py-3.5">
              {rutaAbierta === null ? (
                <div className="min-w-0">
                  <p className="eyebrow">Planificación</p>
                  <h2 className="truncate font-rubik text-base font-semibold text-foreground">
                    Plan de retiro
                  </h2>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setRutaAbierta(null)}
                  className="flex min-w-0 cursor-pointer items-center gap-2 text-left"
                >
                  <ArrowLeft className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="eyebrow block">Volver al plan</span>
                    <span className="block truncate font-rubik text-base font-semibold text-foreground">
                      Recorrido {rutaAbierta + 1}
                    </span>
                  </span>
                </button>
              )}
              {/* Acá había una X para descartar la ruta entera. Se fue: cada
                  recorrido ya se descarta desde su propia fila, y al sacar el
                  último el plan queda vacío por sí solo. Con las dos, la X de
                  la cabecera borraba de un golpe algo que la lista de abajo
                  deja borrar pieza por pieza, y ninguna de las dos decía cuál
                  hacía qué. */}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {/* ── Nivel 1: el plan completo ── */}
              {rutaAbierta === null && (
                <div className="animate-in fade-in flex flex-col gap-5 duration-300">
                  <div className="flex flex-col gap-2">
                    <Button onClick={openLoadDialog} variant="secondary" className="w-full">
                      <FolderOpen className="mr-2 h-4 w-4" /> Cargar archivo de análisis
                    </Button>
                    <Button
                      onClick={openConfirm}
                      disabled={loadedAnalyses.length === 0}
                      size="lg"
                      className="btn-cta w-full"
                      title={
                        loadedAnalyses.length === 0
                          ? "Carga al menos una zona para poder generar una ruta"
                          : undefined
                      }
                    >
                      <RouteIcon className="mr-2 h-4 w-4" /> Generar ruta
                    </Button>
                  </div>

                  {routeError && (
                    <div className="animate-in fade-in rounded-lg border border-warning/40 bg-warning/10 p-3 duration-300">
                      <TriangleAlert className="mb-1.5 h-4 w-4 text-warning-strong" />
                      <p className="text-xs font-semibold">No se pudo generar la ruta</p>
                      <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">
                        {routeError}
                      </p>
                    </div>
                  )}

                  {/* ── Zonas cargadas ──
                      La lista tiene ALTO FIJO y hace scroll. Antes crecía con
                      la cantidad de zonas, así que el bloque medía distinto en
                      cada sesión y empujaba a los recorridos fuera de la vista
                      justo cuando más zonas había, que es cuando más importa
                      verlos. Cuatro filas es lo que entra sin comerse la mitad
                      del panel; de ahí en adelante se desplaza.

                      Cada fila puede descargarse desde acá con su papelera:
                      antes había que abrir el diálogo de carga para sacar una
                      zona de la ruta, o sea salir del plan para editar el plan. */}
                  <section className="flex min-h-0 flex-col">
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                      {/* El conteo va en una pastilla, no entre paréntesis.
                          Un paréntesis dentro de un título se lee como una
                          aclaración de la frase, no como un dato, y además lo
                          hace crecer y encoger cuando el número cambia de
                          dígitos. La pastilla es un dato con forma de dato. */}
                      <h3 className="flex items-center gap-2 text-xs font-semibold text-foreground">
                        Zonas cargadas
                        <Conteo n={loadedAnalyses.length} />
                      </h3>
                      {loadedAnalyses.length > 0 && (
                        <span className="flex items-baseline gap-1.5">
                          <span className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                            Volumen total
                          </span>
                          <span className="mono text-xs font-semibold tabular-nums text-foreground">
                            {volumenCargado.toFixed(2)} m³
                          </span>
                        </span>
                      )}
                    </div>
                    {loadedAnalyses.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-border/60 px-3 py-5 text-center text-[0.6875rem] leading-relaxed text-muted-foreground">
                        Ninguna zona cargada todavía. Una ruta se arma con las zonas que elijas.
                      </p>
                    ) : (
                      <ul className="max-h-[19rem] space-y-1.5 overflow-y-auto pr-0.5">
                        {zonasOrdenadas.map((a) => (
                          <li
                            key={a.id}
                            className={`rounded-lg border bg-background/60 transition-colors hover:bg-primary/5 ${
                              prioritarias.has(a.id)
                                ? /* El borde ámbar, además de la estrella: una
                                     fila marcada se reconoce desde el bloque
                                     entero sin tener que leer un ícono de
                                     14 px en la esquina. */
                                  "border-warning-strong/40"
                                : "border-border/60 hover:border-primary/40"
                            }`}
                          >
                            {/* La fila estaba comprimida en cuatro líneas de
                                texto chico apiladas sin respiro, todas del
                                mismo peso: nombre, dirección, tipos y tres
                                cifras corridas. Todo cabía, pero nada
                                destacaba, y leer el volumen de una zona
                                obligaba a recorrer las otras tres líneas.

                                Ahora son dos zonas separadas por una hairline:
                                arriba QUÉ es (nombre, dónde queda, de qué es),
                                abajo CUÁNTO mide, en tres columnas con su
                                etiqueta encima. Las columnas son lo que permite
                                comparar una zona con otra de un vistazo, que es
                                para lo que se mira esta lista. */}
                            <div className="flex items-start gap-1.5 px-3 pb-2.5 pt-2.5">
                              <button
                                type="button"
                                onClick={() => setZoomAnalysis(a)}
                                title="Ver el detalle de esta zona"
                                className="min-w-0 flex-1 cursor-pointer text-left"
                              >
                                <span className="block truncate text-[0.8125rem] font-semibold text-foreground">
                                  {a.name}
                                </span>

                                {/* La dirección, que es lo que permite
                                    reconocer la zona en terreno. Mientras
                                    Nominatim responde no se dibuja nada, en vez
                                    de un esqueleto que haría saltar la fila. */}
                                {direcciones[a.id] && (
                                  <span className="mt-1 flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                                    <MapPin className="h-3 w-3 flex-shrink-0 opacity-70" />
                                    <span className="min-w-0 truncate">{direcciones[a.id]}</span>
                                  </span>
                                )}

                                {/* Los tipos de residuo. El primero, que es el
                                    que más volumen aporta, va con su nombre;
                                    los demás quedan como puntos de color con su
                                    detalle al pasar el cursor. Nombrarlos todos
                                    en esta columna los parte en varias líneas. */}
                                {(() => {
                                  const tipos = tiposDeZona(a);
                                  if (tipos.length === 0) return null;
                                  return (
                                    <span className="mt-1.5 flex items-center gap-1.5">
                                      <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-muted/70 py-0.5 pl-1.5 pr-2">
                                        <span
                                          className="h-2 w-2 flex-shrink-0 rounded-full"
                                          style={{ background: classColor(tipos[0][0]) }}
                                        />
                                        <span className="min-w-0 truncate text-[0.625rem] text-foreground/80">
                                          {tipos[0][0]}
                                        </span>
                                      </span>
                                      {tipos.length > 1 && (
                                        <span
                                          className="flex flex-shrink-0 items-center gap-1"
                                          title={tipos
                                            .slice(1)
                                            .map(([clase, vol]) => `${clase}: ${vol.toFixed(2)} m³`)
                                            .join("\n")}
                                        >
                                          {tipos.slice(1).map(([clase]) => (
                                            <span
                                              key={clase}
                                              className="h-2 w-2 rounded-full opacity-70"
                                              style={{ background: classColor(clase) }}
                                            />
                                          ))}
                                          <span className="text-[0.625rem] text-muted-foreground">
                                            +{tipos.length - 1}
                                          </span>
                                        </span>
                                      )}
                                      {/* El número de detecciones va acá y no
                                          con las medidas: una detección es un
                                          montón, y lo que la caracteriza es su
                                          tipo, no sus metros. */}
                                      <span className="flex-shrink-0 text-[0.625rem] text-muted-foreground">
                                        <span className="mono tabular-nums">
                                          {a.detections.length}
                                        </span>{" "}
                                        detección{a.detections.length === 1 ? "" : "es"}
                                      </span>
                                    </span>
                                  );
                                })()}
                              </button>

                              {/* Marcar la zona como prioritaria.
                                  Va junto a la papelera y no en el diálogo de
                                  confirmación porque es una propiedad de ESTA
                                  zona: se decide mirándola, con su volumen y su
                                  dirección a la vista, no en una pantalla
                                  aparte donde las zonas ya no se ven.

                                  Enciende y apaga en el mismo lugar, sin
                                  confirmación: equivocarse cuesta otro clic. */}
                              <button
                                type="button"
                                onClick={() => togglePrioritaria(a.id)}
                                aria-pressed={prioritarias.has(a.id)}
                                aria-label={
                                  prioritarias.has(a.id)
                                    ? `Quitar la prioridad de ${a.name}`
                                    : `Marcar ${a.name} como prioritaria`
                                }
                                title={
                                  prioritarias.has(a.id)
                                    ? "Prioritaria: entra al plan antes que las demás. Clic para quitarla."
                                    : "Marcar como prioritaria, para que entre al plan aunque haya que recortar"
                                }
                                // El ámbar es --warning-strong y no --cta ni
                                // --yellow-dark: el del CTA no tiene contraste
                                // como texto sobre el cuerpo claro (por eso
                                // existe --primary aparte), y --yellow-dark no
                                // está declarado en el @theme, así que la clase
                                // no generaría ninguna utilidad y la estrella
                                // quedaría heredando el gris.
                                className={`flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded transition-colors ${
                                  prioritarias.has(a.id)
                                    ? "text-warning-strong hover:bg-muted"
                                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                }`}
                              >
                                {prioritarias.has(a.id) ? (
                                  <StarFill className="h-3.5 w-3.5" />
                                ) : (
                                  <Star className="h-3.5 w-3.5" />
                                )}
                              </button>

                              <button
                                type="button"
                                onClick={() => handleUnload(a.id)}
                                aria-label={`Quitar ${a.name} de la ruta`}
                                title="Quitar de la ruta"
                                className="flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive-strong"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>

                            <dl className="grid grid-cols-3 gap-2 border-t border-border/50 px-3 py-2">
                              <Medida
                                etiqueta="Volumen"
                                valor={a.summary.totalVolumeM3.toFixed(2)}
                                unidad="m³"
                                destacada
                              />
                              <Medida
                                etiqueta="Área"
                                valor={String(a.summary.totalAreaM2)}
                                unidad="m²"
                              />
                              <Medida
                                etiqueta="Peso"
                                valor={String(a.summary.totalWeightKg)}
                                unidad="kg"
                              />
                            </dl>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  {/* ── Recorridos generados ── */}
                  <section>
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                      <h3 className="flex items-center gap-2 text-xs font-semibold text-foreground">
                        Recorridos
                        <Conteo n={routeSegments?.length ?? 0} />
                      </h3>
                      {routeStops && (
                        <span className="text-right">
                          <span className="mono block text-xs tabular-nums text-muted-foreground">
                            {distanciaDelPlan} en {duracionDelPlan}
                          </span>
                          {/* El volumen que el plan mueve, contra el que se
                              cargó. Son dos cifras distintas desde que el plan
                              puede dejar zonas fuera, y la diferencia es
                              exactamente lo que el trabajador necesita ver: sin
                              esto, la cabecera dice "6,94 m³ cargados" y nada
                              delata que el recorrido mueve la mitad. Cuando
                              coinciden se imprime una sola, porque repetir el
                              mismo número dos veces no informa nada. */}
                          {routeTotals?.volumeM3 != null && (
                            <span className="mono block text-[0.625rem] tabular-nums text-muted-foreground">
                              {routeTotals.volumeM3.toFixed(2)} m³
                              {Math.abs(routeTotals.volumeM3 - volumenCargado) > 0.005 && (
                                <span className="text-warning-strong">
                                  {" "}
                                  de {volumenCargado.toFixed(2)} cargados
                                </span>
                              )}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                    {!routeSegments || routeSegments.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-border/60 px-3 py-5 text-center text-[0.6875rem] leading-relaxed text-muted-foreground">
                        Todavía no hay ningún recorrido. Se generan a partir de las zonas cargadas.
                      </p>
                    ) : (
                      <ul className="space-y-1">
                        {routeSegments.map((seg, i) => (
                          <li key={i}>
                            {/* Misma estructura que una zona cargada: arriba
                                qué es, abajo cuánto mide en columnas con su
                                etiqueta. Dos listas del mismo panel que se
                                leyeran distinto obligarían a aprender dos
                                formatos para comparar lo mismo. */}
                            {/* La papelera va FUERA del botón que abre el
                                detalle: anidar un botón dentro de otro no es
                                válido en HTML y el navegador los separa como
                                quiere, así que el contenedor pasa a ser un div
                                y cada acción tiene su propio botón. */}
                            <div className="relative rounded-lg border border-border/60 bg-background/60 transition-colors hover:border-primary/40 hover:bg-primary/5">
                              <button
                                type="button"
                                onClick={() => descartarRecorrido(i)}
                                aria-label={`Descartar el recorrido ${i + 1}`}
                                title="Descartar este recorrido"
                                className="absolute right-2 top-2 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive-strong"
                              >
                                <X className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setRutaAbierta(i)}
                                title="Ver el detalle de este recorrido"
                                className="w-full cursor-pointer text-left"
                              >
                                <span className="flex items-start gap-2.5 px-3 pt-2.5">
                                  <span className="mono flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-[0.625rem] font-semibold text-primary">
                                    {i + 1}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[0.8125rem] font-semibold text-foreground">
                                      {seg.originName}
                                    </span>
                                    <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">
                                      {routeStops?.length ?? 0} parada
                                      {routeStops?.length === 1 ? "" : "s"}
                                    </span>
                                  </span>
                                  <ArrowRightCircle className="mt-0.5 mr-7 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                                </span>
                                <span className="mt-2 grid grid-cols-3 gap-2 border-t border-border/50 px-3 py-2">
                                  {/* Los TRES tramos: ida, descarga en el relleno
                                      y regreso. Sumando dos, esta tarjeta mostraba
                                      110,7 km mientras la cabecera del plan decía
                                      220,8: la misma ruta con dos cifras distintas
                                      en la misma pantalla. */}
                                  <Medida
                                    etiqueta="Distancia"
                                    valor={(
                                      seg.outboundDistanceKm +
                                      (seg.disposalDistanceKm ?? 0) +
                                      seg.returnDistanceKm
                                    ).toFixed(1)}
                                    unidad="km"
                                    destacada
                                  />
                                  <Medida
                                    etiqueta="Duración"
                                    valor={formatDuration(
                                      seg.outboundDurationHours +
                                        (seg.disposalDurationHours ?? 0) +
                                        seg.returnDurationHours,
                                    )}
                                    unidad=""
                                  />
                                  <Medida
                                    etiqueta="Camiones"
                                    valor={String(seg.trucksUsed)}
                                    unidad=""
                                  />
                                </span>
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  {/* ── HDU5.1/AC6 ──
                      Va en el nivel del plan y no dentro de un recorrido: una
                      zona sin asignar no pertenece a ningún recorrido, esa es
                      justamente su condición. Solo aparece cuando el backend
                      manda el campo; una lista vacía se leería como "todas
                      entraron", y eso todavía no se puede afirmar. */}
                  {unassigned && unassigned.length > 0 && (
                    <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
                      <p className="flex items-center gap-1.5 text-xs font-semibold">
                        <TriangleAlert className="h-3.5 w-3.5 flex-shrink-0 text-warning-strong" />
                        {unassigned.length} zona{unassigned.length === 1 ? "" : "s"} sin asignar
                      </p>
                      <ul className="mt-2 space-y-1.5">
                        {unassigned.map((z) => (
                          <li key={z.analysisId}>
                            <p className="text-xs font-medium text-foreground">{z.name}</p>
                            <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                              {z.reason}
                            </p>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-2.5 text-[0.6875rem] leading-relaxed text-muted-foreground">
                        El resto del plan sigue siendo válido. Estas zonas quedan pendientes para
                        otra jornada.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* ── Nivel 2: un recorrido en detalle ── */}
              {rutaAbierta !== null && routeSegments?.[rutaAbierta] && routeStops && (
                <div className="animate-in fade-in slide-in-from-right-2 flex flex-col gap-4 duration-300">
                  <div className="grid grid-cols-2 gap-2">
                    <CifraPlan
                      icono={<RouteIcon className="h-3.5 w-3.5" />}
                      etiqueta="Distancia"
                      // Los TRES tramos: ida, descarga en el relleno y
                      // regreso. Sumando solo ida y vuelta, estas dos cifras
                      // subestimaban el recorrido justo en el tramo que se
                      // acababa de agregar, y no coincidian con la suma de lo
                      // que la linea de tiempo muestra fila por fila.
                      valor={`${(
                        routeSegments[rutaAbierta].outboundDistanceKm +
                        (routeSegments[rutaAbierta].disposalDistanceKm ?? 0) +
                        routeSegments[rutaAbierta].returnDistanceKm
                      ).toFixed(1)} km`}
                    />
                    <CifraPlan
                      icono={<Clock className="h-3.5 w-3.5" />}
                      etiqueta="Duración"
                      valor={formatDuration(
                        routeSegments[rutaAbierta].outboundDurationHours +
                          (routeSegments[rutaAbierta].disposalDurationHours ?? 0) +
                          routeSegments[rutaAbierta].returnDurationHours,
                      )}
                    />
                  </div>

                  {/* ── AC5 de HDU5.1 ──
                      El criterio pide que los tiempos se ajusten al tráfico
                      "sin requerir que el trabajador lo indique", y eso solo se
                      puede comprobar si el trabajador ve que está pasando: un
                      ajuste invisible es indistinguible de no haberlo hecho.
                      Lleva la hora de salida porque el tráfico es de un
                      momento, no una propiedad de la calle.

                      Solo aparece cuando el plan se calculó así. Mostrarlo
                      siempre afirmaría de un plan a flujo libre algo que no
                      hizo. */}
                  {routeTotals?.trafficAware && salidaPlan && (
                    <p className="-mt-2 flex items-center gap-1.5 text-[0.625rem] leading-relaxed text-muted-foreground">
                      <Clock className="h-3 w-3 flex-shrink-0" />
                      Tiempos ajustados al tráfico de las{" "}
                      <span className="mono tabular-nums">
                        {salidaPlan.toLocaleTimeString("es-CL", {
                          timeZone: "America/Santiago",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </p>
                  )}

                  <RouteTimeline
                    segment={routeSegments[rutaAbierta]}
                    stops={routeStops}
                    datosDeParada={datosDeParada}
                    salida={salidaPlan ?? undefined}
                    onStopClick={(stop) => setFocusPoint([stop.lat, stop.lng])}
                    onVerFoto={setVehiculoEnFoto}
                  />

                  <Button
                    variant="secondary"
                    onClick={() => descartarRecorrido(rutaAbierta)}
                    className="w-full text-destructive-strong hover:bg-destructive/10"
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Descartar este recorrido
                  </Button>
                </div>
              )}
            </div>
          </div>
        </aside>
      </main>

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
                        {record.summary && `, ${record.summary.totalVolumeM3} m³`}
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
              {/* La dirección antes que la descripción genérica: es el dato que
                  permite reconocer la zona en terreno, y "Zona A" no lo da.
                  Solo aparece cuando Nominatim la resolvió. */}
              {zoomAnalysis && direcciones[zoomAnalysis.id] ? (
                <span className="flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5 flex-shrink-0 text-primary/70" />
                  {direcciones[zoomAnalysis.id]}
                </span>
              ) : (
                "Mapa unificado real de esta zona, con los basurales detectados."
              )}
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
      {/* ── Foto del vehículo asignado ──
          Se llega desde la fila del vehículo en la línea de tiempo. La patente
          identifica la unidad en la planilla, pero no en el patio: lo que
          permite salir a buscarla es verla. La ficha repite el tipo, la
          capacidad y la dotación bajo la imagen, porque quien abre esto está
          decidiendo si ese es el vehículo que va a sacar, y volver a la línea
          de tiempo para confirmar el dato anula el propósito. */}
      <Dialog
        open={vehiculoEnFoto !== null}
        onOpenChange={(open) => !open && setVehiculoEnFoto(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="mono">{vehiculoEnFoto?.patente}</DialogTitle>
            <DialogDescription>
              {vehiculoEnFoto?.tipo}
              {vehiculoEnFoto?.numeroEquipo ? ` · N° ${vehiculoEnFoto.numeroEquipo}` : ""}
            </DialogDescription>
          </DialogHeader>
          {vehiculoEnFoto && (
            <div className="space-y-3">
              {vehiculoEnFoto.foto && (
                <img
                  src={resourcePhotoUrl(vehiculoEnFoto.foto)}
                  alt={`${vehiculoEnFoto.tipo} ${vehiculoEnFoto.patente}`}
                  className="max-h-[22rem] w-full rounded-lg border border-border/60 object-contain"
                />
              )}
              {/* Los tres límites van en una fila de TRES, no en una grilla de
                  2x2 con la dotación de cuarta. Las tres son cifras cortas de la
                  misma naturaleza y se comparan entre sí; la dotación es una
                  LISTA de personas, y metida en una celda de cifra se envolvía
                  en cuatro renglones que rompían la fila y empujaban el resto.

                  Un dato de otra forma no entra en la grilla de los demás solo
                  porque sea el cuarto. */}
              <div className="grid grid-cols-3 gap-2">
                <CifraPlan
                  icono={<Boxes className="h-3.5 w-3.5" />}
                  etiqueta="Capacidad"
                  valor={
                    vehiculoEnFoto.capacityM3 != null
                      ? `${vehiculoEnFoto.capacityM3} m³`
                      : "Sin declarar"
                  }
                />
                <CifraPlan
                  icono={<Scale className="h-3.5 w-3.5" />}
                  etiqueta="Peso máximo"
                  valor={
                    vehiculoEnFoto.capacityTon != null
                      ? `${vehiculoEnFoto.capacityTon} t`
                      : "Sin límite"
                  }
                />
                <CifraPlan
                  icono={<RouteIcon className="h-3.5 w-3.5" />}
                  etiqueta="Autonomía"
                  valor={
                    vehiculoEnFoto.autonomiaKm != null
                      ? `${vehiculoEnFoto.autonomiaKm} km`
                      : "Sin límite"
                  }
                />
              </div>

              {/* La dotación como lista, una persona por fila con su rol al
                  costado. Es la tripulación que va en ESTE vehículo, así que el
                  nombre manda y el rol lo califica: en una sola línea separada
                  por comas había que leer la frase entera para contar cuántos
                  van. */}
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <p className="flex items-center gap-1.5 text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                  <Users className="h-3 w-3" />
                  Dotación
                  {vehiculoEnFoto.crew && vehiculoEnFoto.crew.length > 0 && (
                    <Conteo n={vehiculoEnFoto.crew.length} />
                  )}
                </p>
                {vehiculoEnFoto.crew && vehiculoEnFoto.crew.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {vehiculoEnFoto.crew.map((persona, i) => {
                      // El backend manda "Juan Pérez (conductor)" cuando hay
                      // personal declarado, y "2 peonetas" cuando no. Se parte
                      // el paréntesis para poder jerarquizar nombre y rol; si no
                      // lo trae, es un rol suelto y se imprime tal cual.
                      const m = /^(.*?)\s*\(([^)]+)\)$/.exec(persona);
                      return (
                        <li
                          key={`${persona}-${i}`}
                          className="flex items-baseline justify-between gap-2"
                        >
                          <span className="min-w-0 truncate text-xs text-foreground">
                            {m ? m[1] : persona}
                          </span>
                          {m && (
                            <span className="flex-shrink-0 text-[0.625rem] text-muted-foreground">
                              {m[2]}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="mt-1.5 text-xs text-muted-foreground">Sin declarar</p>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

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

                {/* La lista va a mano y no recorriendo las claves de `fuera`
                    para fijar el ORDEN en que se leen los motivos. El precio es
                    que un motivo nuevo hay que agregarlo acá o no se muestra:
                    pasó con `solo_toneladas`, que si no estuviera dejaría al
                    CAMION 3/4 PLANO sin aparecer en ningún renglón y el
                    desglose no sumaría 21. */}
                {(
                  [
                    "no_disponible",
                    "sin_capacidad",
                    "solo_toneladas",
                    "no_transporta",
                    "se_remolca",
                  ] as const
                ).map((motivo) =>
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
        {/* Sin foco automático al abrir. Radix enfoca el primer elemento
            enfocable del diálogo, que acá es el campo de horas, y abría con el
            "8" seleccionado en azul: parece que el valor está por reemplazarse,
            y de hecho basta teclear cualquier cosa para perderlo. El diálogo es
            de CONFIRMACIÓN, así que lo primero que hay que hacer es leerlo, no
            escribir. El teclado no queda afuera: el Tab entra igual, y Escape
            sigue cerrando porque eso lo maneja el diálogo y no el foco. */}
        {/* Más ancho y con alto acotado: el diálogo pasó de tres controles
            cortos a llevar también la cuadrilla, y en el ancho por omisión cada
            fila de persona (casilla, nombre, rol y papelera) quedaba apretada.
            El scroll es del diálogo entero y no solo de la lista, porque con la
            lista llena el resto de los campos también necesita poder alcanzarse. */}
        <DialogContent
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="max-h-[90vh] max-w-2xl overflow-y-auto"
        >
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
                          {resumen.suman.length} de {p.resource_count} suman {resumen.capacidad} m³
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

            {/* ── Personal disponible (AC1 y AC2 de HDU5.1) ──
                Se declara acá y no en una pantalla de administración porque es
                una decisión de ESTA jornada: la municipalidad describió su
                operación como "se designa personal según requerimiento" y "se
                flexibiliza por inasistencias".

                La casilla, y no la papelera, es lo que cubre la inasistencia:
                quien falta hoy vuelve mañana, y obligar a reescribir su nombre
                convertiría una ausencia en un alta nueva. */}
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <label className="text-xs font-medium text-muted-foreground">
                  Personal disponible hoy
                </label>
                {/* El resumen por rol, que es la cifra que decide qué vehículos
                    pueden salir. Sin esto hay que contar filas a ojo en una
                    lista que además puede estar filtrada por el buscador. */}
                {cuadrillaDeHoy.length > 0 && (
                  <span className="flex items-baseline gap-2">
                    {resumenCuadrilla
                      .filter((r) => r.cantidad > 0)
                      .map((r) => (
                        <span key={r.valor} className="text-[0.625rem] text-muted-foreground">
                          <span className="mono font-semibold tabular-nums text-foreground">
                            {r.cantidad}
                          </span>{" "}
                          {r.cantidad === 1 ? r.etiqueta.toLowerCase() : r.plural}
                        </span>
                      ))}
                  </span>
                )}
              </div>

              {/* El buscador aparece recién cuando hay suficientes filas para
                  que buscar tenga sentido: con cuatro personas es un control de
                  más que ocupa el lugar de una de ellas. */}
              {cuadrilla.length > 6 && (
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={buscandoPersonal}
                    onChange={(e) => setBuscandoPersonal(e.target.value)}
                    placeholder="Buscar por nombre"
                    className="h-8 pl-8 text-xs"
                  />
                </div>
              )}

              {cuadrilla.length === 0 ? (
                <p className="rounded-md border border-dashed border-border/60 px-3 py-3 text-center text-[0.6875rem] leading-relaxed text-muted-foreground">
                  Sin personal declarado, el plan no restringe por dotación y la ruta se genera
                  igual.
                  {dotacionNecesaria.length > 0 && (
                    <>
                      {" "}
                      Para tripular toda la flota disponible harían falta{" "}
                      <span className="font-medium text-foreground">
                        {dotacionNecesaria
                          .map(
                            (r) =>
                              `${r.total} ${r.total === 1 ? r.etiqueta.toLowerCase() : r.plural}`,
                          )
                          .join(" y ")}
                      </span>
                      .
                    </>
                  )}
                </p>
              ) : cuadrillaFiltrada.length === 0 ? (
                <p className="rounded-md border border-dashed border-border/60 px-3 py-3 text-center text-[0.6875rem] text-muted-foreground">
                  Nadie coincide con esa búsqueda.
                </p>
              ) : (
                // Alto acotado con scroll: con treinta personas el diálogo
                // crecería hasta sacar el botón de generar de la pantalla.
                <ul className="max-h-60 space-y-1 overflow-y-auto pr-0.5">
                  {cuadrillaFiltrada.map((persona) => {
                    const repetido =
                      persona.disponible && repetidos.has(persona.nombre.trim().toLowerCase());
                    // Marcada pero sin nombre, y ya se dejó el campo: no entra
                    // al plan, y callarlo dejaría al trabajador contando a
                    // alguien que el sistema no cuenta. Ámbar y no rojo, porque
                    // es un dato que falta y no un error, mismo criterio que una
                    // capacidad sin declarar.
                    const incompleta = sinTerminar(persona);
                    return (
                      <li key={persona.id} className="flex items-center gap-1.5">
                        <Checkbox
                          checked={persona.disponible}
                          onCheckedChange={(v) =>
                            cambiarPersona(persona, { disponible: v === true })
                          }
                          aria-label={`${persona.nombre || "Sin nombre"} disponible hoy`}
                        />
                        <Input
                          value={persona.nombre}
                          // Se escribe local y se guarda al salir del campo: una
                          // petición por tecla sería una ráfaga contra el
                          // servidor y haría saltar el cursor con cada respuesta.
                          onChange={(e) =>
                            setCuadrilla((prev) =>
                              prev.map((x) =>
                                x.id === persona.id ? { ...x, nombre: e.target.value } : x,
                              ),
                            )
                          }
                          onBlur={() => {
                            setRecienAgregadas((prev) => {
                              if (!prev.has(persona.id)) return prev;
                              const next = new Set(prev);
                              next.delete(persona.id);
                              return next;
                            });
                            cambiarPersona(persona, {});
                          }}
                          placeholder="Nombre"
                          className={`h-8 flex-1 text-xs ${
                            repetido
                              ? "border-destructive focus-visible:ring-destructive"
                              : incompleta
                                ? "border-warning-strong/60"
                                : ""
                          }`}
                        />
                        <Select
                          value={persona.rol}
                          onValueChange={(v) => cambiarPersona(persona, { rol: v as RolPersonal })}
                        >
                          <SelectTrigger className="h-8 w-[7.5rem] text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLES.map((r) => (
                              <SelectItem key={r.valor} value={r.valor}>
                                {r.etiqueta}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <button
                          type="button"
                          onClick={() => quitarPersona(persona)}
                          aria-label={`Quitar a ${persona.nombre || "esta persona"}`}
                          title="Quitar de la cuadrilla"
                          className="flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive-strong"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {cuadrilla.some(sinTerminar) && (
                <p className="text-[0.625rem] leading-relaxed text-warning-strong">
                  Hay personas marcadas sin nombre. No entran en el plan hasta que lo tengan: el
                  plan identifica a cada una por su nombre para poder comprobar que nadie esté en
                  dos vehículos.
                </p>
              )}

              {repetidos.size > 0 && (
                <p className="text-[0.625rem] leading-relaxed text-destructive">
                  Hay nombres repetidos entre las personas marcadas. El plan comprueba que nadie
                  esté en dos vehículos a la vez, y con dos filas llamadas igual esa comprobación
                  deja de poder hacerse.
                </p>
              )}

              {/* El mismo aviso cuando hay gente cargada pero nadie marcado: es
                  el mismo caso para el algoritmo y no se ve igual en pantalla. */}
              {cuadrilla.length > 0 && cuadrillaDeHoy.length === 0 && (
                <p className="text-[0.625rem] leading-relaxed text-muted-foreground">
                  Sin nadie marcado la ruta se genera igual, sin restringir por dotación.
                </p>
              )}

              <Button
                variant="secondary"
                size="sm"
                className="h-8 w-full text-xs"
                disabled={guardandoPersona}
                onClick={agregarPersona}
              >
                <Plus className="mr-1.5 h-3 w-3" /> Agregar persona
              </Button>
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

            {/* Las zonas marcadas, recordadas en el último paso antes de
                generar. La marca se pone en la lista de zonas, que acá ya no
                está a la vista, así que sin esta línea no habría forma de
                confirmar que quedó puesta sin cerrar el diálogo y volver.

                Solo aparece si hay alguna: una línea que dice "0 prioritarias"
                describe el caso normal y ocupa lugar sin informar nada. */}
            {cantidadPrioritarias > 0 && (
              <p className="flex items-start gap-2 rounded-md border border-warning-strong/30 bg-warning/10 px-2.5 py-2 text-[0.6875rem] leading-relaxed">
                <StarFill className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning-strong" />
                <span>
                  <span className="mono tabular-nums">{cantidadPrioritarias}</span>{" "}
                  {cantidadPrioritarias === 1 ? "zona marcada" : "zonas marcadas"} como{" "}
                  {cantidadPrioritarias === 1 ? "prioritaria" : "prioritarias"}:{" "}
                  {cantidadPrioritarias === 1 ? "entra" : "entran"} al plan antes que el resto y{" "}
                  {cantidadPrioritarias === 1 ? "es la última" : "son las últimas"} en salir si hay
                  que recortar por capacidad u horas.
                </span>
              </p>
            )}
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

/** Una cifra de la franja. Idéntica a la de las otras dos vistas de
 *  planificación, a propósito: ícono al costado, etiqueta chica arriba y el
 *  valor en .mono debajo. */
function CifraCabecera({
  icono,
  etiqueta,
  valor,
}: {
  icono: React.ReactNode;
  etiqueta: string;
  valor: string;
}) {
  return (
    <div className="flex flex-shrink-0 items-center gap-3 px-5 py-3.5">
      <span className="flex h-8 w-8 items-center justify-center text-muted-foreground">
        {icono}
      </span>
      <span>
        <span className="block text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
          {etiqueta}
        </span>
        <span className="mono block text-sm font-semibold tabular-nums text-foreground">
          {valor}
        </span>
      </span>
    </div>
  );
}

/** Una de las dos cifras grandes del plan. Las dos al mismo tamaño: son la
 *  misma clase de magnitud y ninguna manda sobre la otra. */
function CifraPlan({
  icono,
  etiqueta,
  valor,
}: {
  icono: React.ReactNode;
  etiqueta: string;
  valor: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[0.625rem] uppercase tracking-wide text-muted-foreground">
        <span className="flex-shrink-0 opacity-70">{icono}</span>
        {etiqueta}
      </p>
      <p className="mono mt-1 text-base font-semibold tabular-nums text-foreground">{valor}</p>
    </div>
  );
}

/** El conteo de una sección, con forma de dato y no de aclaración. En cero se
 *  atenúa en vez de desaparecer: que la sección exista y esté vacía es
 *  información, y un conteo que aparece y desaparece mueve el título. */
function Conteo({ n }: { n: number }) {
  return (
    <span
      className={`mono inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.5625rem] font-semibold tabular-nums ${
        n === 0 ? "bg-muted text-muted-foreground" : "bg-primary/15 text-primary"
      }`}
    >
      {n}
    </span>
  );
}

/** Una de las tres medidas de una fila, sea una zona o un recorrido. Etiqueta arriba y cifra debajo, en
 *  columnas: es lo que permite comparar la misma magnitud entre dos zonas sin
 *  buscarla dentro de una frase. La unidad va junto a la cifra y en su propio
 *  tamaño, porque es la cifra lo que se compara, no la unidad. */
function Medida({
  etiqueta,
  valor,
  unidad,
  destacada = false,
}: {
  etiqueta: string;
  valor: string;
  unidad: string;
  destacada?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[0.5625rem] uppercase tracking-wide text-muted-foreground">
        {etiqueta}
      </dt>
      <dd
        className={`mono truncate text-[0.6875rem] tabular-nums ${
          destacada ? "font-semibold text-foreground" : "text-muted-foreground"
        }`}
      >
        {valor} <span className="opacity-70">{unidad}</span>
      </dd>
    </div>
  );
}
