// =============================================================================
// CONDORFINDER, VISTA PRINCIPAL
// Archivo: src/routes/index.tsx
//
// Página de entrada de la aplicación. El listado de zonas combina:
//   - "done"             → análisis guardados (analysisStore.ts, Mongo)
//   - "in_progress"       → generaciones de mapa corriendo en el backend
//                           (GET /tasks/pending), sin imagen ni datos todavía
//   - "pending_analysis"  → mapa ya generado pero nadie fue a /analysis a
//                           revisarlo/guardarlo todavía
//
// El botón "Abrir análisis" (HDU4/AC3) refresca este listado combinado.
// Desde aquí también se accede a:
//   - Agregar una zona nueva → /carga (flujo de carga de imágenes, HDU1)
//   - Modificar una zona existente → placeholder, sin funcionalidad todavía
//
// El sidebar izquierdo queda reservado para HDU6 (recursos disponibles).
//
// Layout: una sola página con una regla vertical separando el sidebar del
// contenido (mismo patrón que analysis.tsx), sin tarjetas ni paneles
// encajonando cada sección.
// =============================================================================

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { PuntoPermanenteDialog } from "@/components/PuntoPermanenteDialog";
import { notify } from "@/lib/notify";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  ArrowLeft,
  ArrowRightCircle,
  Boxes,
  ChartLineUp,
  Crosshair,
  Eye,
  FileText,
  FolderOpen,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Scale,
  Search,
  Trash2,
} from "@/components/icons/Icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SortableHead } from "@/components/SortableHead";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  listAnalyses,
  listZones,
  deleteZone,
  deleteAnalysis,
  setPendingOpenId,
  renameZone,
  type SavedAnalysisRecord,
  type AnalysisSummary,
  type ZoneRecord,
} from "@/lib/analysisStore";
import { RenameDialog } from "@/components/RenameDialog";
// Carga diferida por el mismo motivo que jspdf en el informe: ZoneEvolution
// arrastra recharts (cerca de 900 kB), y quien nunca abre la evolución de una
// zona no tiene por qué descargarlo. Importado de forma normal, recharts caía
// dentro del bundle principal y lo duplicaba de tamaño.
const ZoneEvolution = lazy(() =>
  import("@/components/ZoneEvolution").then((m) => ({ default: m.ZoneEvolution })),
);
import { ReportPreview } from "@/components/ReportPreview";
import { zoneTotals } from "@/lib/volumeReport";
import { borrarArchivosDeVersion } from "@/lib/versionCleanup";
import type { ReportSelection } from "@/lib/pdfReport";
import {
  listPendingTasks,
  getTaskStatus,
  cancelTask,
  deleteAllImages,
  deleteResultFile,
  listTaskImages,
  getTaskImageUrl,
  deleteTaskImages,
  deleteTask,
  type PendingTask,
} from "@/lib/unify";
import { entero } from "@/lib/formato";
import { FiltroDropdown } from "@/components/FiltroDropdown";
import {
  clearImageState,
  saveZonaDestino,
  clearZonaDestino,
  saveItems,
  saveUploadDone,
  saveTaskId,
  savePhase,
  saveBackendStage,
  saveDetectionJsonUrl,
  clearDetectionJsonUrl,
  saveNoWasteDetected,
  type PersistedFileItem,
} from "@/lib/imageState";
import { clearMapUrl, saveMapUrl, clearCurrentAnalysisId } from "@/lib/mapState";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/_authed/")({
  head: () => ({
    meta: [
      { title: "CondorFinder, Zonas monitoreadas" },
      {
        name: "description",
        content: "Panorama de las zonas con basurales detectados y analizados por CondorFinder.",
      },
    ],
  }),
  component: MainPage,
});

// ── modelo de fila combinado (guardadas + trackeadas) ──────────────────────

/** `no_flight` es una zona registrada a la que todavía no se le voló el dron.
 *
 *  Hasta HDU14 este estado no podía existir: una zona solo nacía al guardar un
 *  análisis, así que esta vista únicamente sabía mostrar lugares ya medidos. La
 *  municipalidad conoce 54 microbasurales y le voló el dron a dos, o sea que la
 *  tabla decía que administra dos lugares. */
type ZoneState = "done" | "in_progress" | "pending_analysis" | "no_flight";

interface ZoneRow {
  state: ZoneState;
  key: string;
  name: string;
  savedAt: string;
  mapUrl: string | null;
  /** Miniatura liviana para la tarjeta, preferida sobre mapUrl (varios MB)
   *  cuando existe; ausente en análisis guardados antes de este campo. */
  thumbnailUrl?: string | null;
  summary: AnalysisSummary | null;
  recordId?: string;
  taskId?: string;
  backendStage?: string;
  resultUrl?: string;
  resultJsonUrl?: string;
  detectionCount?: number;
  /** HDU7/AC3, true si este análisis quedó vinculado como versión anterior
   *  de uno más reciente (confirmado como la misma zona). Se oculta de los
   *  filtros normales, solo visible bajo el filtro "Historial". */
  historical?: boolean;
  /** HDU7/AC3, nombre del análisis que lo reemplazó, resuelto cruzando
   *  contra las demás filas ya cargadas (ver loadZoneRows), no hace falta
   *  pedirle nada extra al backend para esto. */
  supersededByName?: string;
  /** La zona a la que corresponde la fila. En `no_flight` la fila ES la zona;
   *  en `done` sale del análisis. Ausente en tareas en curso, que todavía no
   *  tienen una. */
  zoneId?: string;
  /** La dirección de la zona. Un punto permanente la trae de su alta; una zona
   *  nacida de un vuelo solo si alguien se la completó después. */
  address?: string;
  /** El barrio de la zona, del mismo juego de campos que `address`: ubica el
   *  lugar más gruesamente que la calle y es como la municipalidad agrupa su
   *  territorio en la planilla. */
  barrio?: string;
  /** Microbasural o VIRS, la categoría real del lugar en la planilla
   *  municipal. Es del LUGAR, no del residuo que haya dentro. */
  tipo?: string;
  /** El nombre de la ZONA, que es el que esta tabla muestra arriba en la
   *  columna de nombre.
   *
   *  **Existe porque el buscador tiene que buscar lo que se ve.** `name` es el
   *  nombre de la MEDICIÓN ("Medición 26-05-2026"), y el buscador filtraba por
   *  ese: escribir "Avenida Las Industrias", que es lo que la fila muestra en
   *  grande, no encontraba nada y la tabla quedaba vacía. Es el mismo defecto
   *  que /rutas ya había corregido en sus rótulos. */
  zoneName?: string;
}

function fromRecord(r: SavedAnalysisRecord): ZoneRow {
  return {
    state: "done",
    key: r.id,
    name: r.name,
    savedAt: r.savedAt,
    mapUrl: r.mapUrl,
    thumbnailUrl: r.thumbnailUrl,
    summary: r.summary,
    recordId: r.id,
    taskId: r.sourceTaskId,
    historical: r.historical,
  };
}

/**
 * Combina los análisis guardados (Mongo) con las tareas pendientes
 * (GET /tasks/pending, también Mongo), reemplaza el registro local en
 * taskRegistry.ts. Ya no hay ningún estado del lado del navegador que
 * pueda desincronizarse: cualquier navegador/dispositivo ve exactamente
 * las mismas tareas, y una falla de red al consultar el backend solo
 * significa "reintentar en el próximo refresh", no "perder la referencia
 * para siempre" (esa era la clase de bug que causaba el reinicio de
 * uvicorn en el momento equivocado antes de esta migración).
 */
async function loadZoneRows(): Promise<ZoneRow[]> {
  // Ambas listas pueden fallar (sesión perdida, red caída), se degradan en
  // silencio en vez de romper el resto del listado: una lista incompleta es
  // mucho mejor que una vista que no carga.
  // Las zonas se traen PRIMERO porque hacen falta dos veces: para las filas
  // sin vuelo, y para ponerle su dirección a las que sí tienen análisis. Una
  // zona nacida de un vuelo puede tener dirección si alguien se la completó.
  //
  // `analysisCount` lo calcula el backend en una sola agregación; contar acá
  // habría significado recorrer todos los análisis por cada zona.
  let zonas: ZoneRecord[] = [];
  try {
    zonas = await listZones();
  } catch {
    // ver comentario de arriba
  }
  const zonaPorId = new Map(zonas.map((z) => [z.id, z]));

  let doneRows: ZoneRow[] = [];
  try {
    const records = await listAnalyses();
    // HDU7/AC3, resuelve supersededByName cruzando contra las demás filas
    // ya traídas en esta misma llamada, sin pedirle nada extra al backend.
    const nameById = new Map(records.map((r) => [r.id, r.name]));
    doneRows = records.map((r) => {
      // Los tres campos salen de la MISMA zona, así que se resuelve una sola
      // vez: repetir `zonaPorId.get(...)` por campo invita a que el siguiente
      // que se agregue termine leyendo de otra.
      const zona = r.zoneId ? zonaPorId.get(r.zoneId) : undefined;
      return {
        ...fromRecord(r),
        supersededByName: r.supersededBy ? nameById.get(r.supersededBy) : undefined,
        address: zona?.address ?? undefined,
        barrio: zona?.barrio ?? undefined,
        tipo: zona?.tipo ?? undefined,
        zoneName: zona?.name ?? undefined,
        zoneId: r.zoneId ?? undefined,
      };
    });
  } catch {
    // ver comentario de arriba
  }

  // Las zonas SIN ningún análisis. No salen de `listAnalyses()` por
  // definición, así que sin esta consulta serían invisibles en la vista que
  // justamente lista lo que la municipalidad administra.
  const sinVuelo: ZoneRow[] = zonas
    .filter((z) => z.analysisCount === 0)
    .map((z) => ({
      state: "no_flight" as const,
      key: `zona-${z.id}`,
      name: z.name,
      address: z.address ?? undefined,
      barrio: z.barrio ?? undefined,
      tipo: z.tipo ?? undefined,
      // En una fila sin vuelo la fila ES la zona, así que los dos nombres son
      // el mismo. Se repite igual para que el buscador no tenga que ramificar.
      zoneName: z.name,
      // Se ordenan junto a las demás por esta fecha, que para una zona a
      // mano es cuándo se registró el lugar.
      savedAt: z.createdAt,
      mapUrl: null,
      summary: null,
      zoneId: z.id,
    }));

  let pending: PendingTask[] = [];
  try {
    pending = await listPendingTasks();
  } catch {
    // ver comentario de arriba
  }

  const trackedRows: ZoneRow[] = [];
  for (const t of pending) {
    // El backend la incluye para que se pueda descubrir y limpiar acá , 
    // nunca se muestra como fila (una tarea cancelada no llega a guardarse
    // ni analizarse), y se borra por completo (archivos + documento) para
    // que no siga apareciendo en el próximo refresh.
    if (t.status === "cancelled") {
      deleteTaskImages(t.taskId);
      deleteTask(t.taskId);
      continue;
    }

    if (t.status === "done") {
      trackedRows.push({
        state: "pending_analysis",
        key: t.taskId,
        name: "Análisis pendiente de revisión",
        savedAt: t.createdAt ?? new Date().toISOString(),
        // El mapa ya existe en el servidor en este punto (el pipeline
        // completo terminó, solo falta guardarlo/analizarlo), antes se
        // dejaba en null y la fila mostraba un ícono de placeholder en
        // vez de la miniatura real, aunque el sistema ya la tenía.
        mapUrl: t.resultUrl ?? null,
        thumbnailUrl: t.thumbnailUrl ?? null,
        summary: null,
        taskId: t.taskId,
        resultUrl: t.resultUrl,
        resultJsonUrl: t.resultJsonUrl,
        detectionCount: t.detectionCount,
      });
      continue;
    }

    trackedRows.push({
      state: "in_progress",
      key: t.taskId,
      name: "Generando mapa unificado...",
      savedAt: t.createdAt ?? new Date().toISOString(),
      mapUrl: null,
      summary: null,
      taskId: t.taskId,
      backendStage: t.status,
    });
  }

  const inProgress = trackedRows.filter((r) => r.state === "in_progress");
  const pendingAnalysis = trackedRows.filter((r) => r.state === "pending_analysis");
  const doneSorted = [...doneRows].sort(
    (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
  );

  const sinVueloSorted = [...sinVuelo].sort(
    (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
  );

  // En progreso y pendientes de análisis van primero (necesitan atención). Las
  // zonas sin vuelo van al final: no piden nada, solo están registradas.
  return [...inProgress, ...pendingAnalysis, ...doneSorted, ...sinVueloSorted];
}

/** El guion de una celda numérica sin dato.
 *
 *  Centrado, no alineado a la derecha como las cifras: pegado al borde derecho
 *  de la columna parecía el final de un número cortado. Componente y no un
 *  `<span>` escrito en cada celda porque son seis celdas entre esta tabla y la
 *  del itinerario, y es exactamente la clase de detalle que queda distinto en
 *  una de ellas. */
function SinDato() {
  return <span className="block text-center text-muted-foreground/60">-</span>;
}

/** Ancho común de la acción única de una fila.
 *
 *  "Ir a Carga", "Ir a Análisis" y "Generar mapa" son excluyentes entre sí y
 *  ocupan la MISMA celda según el estado de la fila, así que con el ancho
 *  natural de cada texto la columna cambiaba de tamaño al filtrar o al avanzar
 *  de página. Es el mismo motivo por el que las columnas de cifras llevan
 *  ancho fijo. */
const ACCION_FILA = "min-w-[9.5rem] justify-center";

/** Filas por página de la tabla de zonas.
 *
 *  10 y no 5 como las tablas de recursos y del itinerario: esta es la vista de
 *  aterrizaje y lo que se hace acá es barrer el listado, no comparar dos filas
 *  entre sí. */
const FILAS_POR_PAGINA = 10;

/** Normaliza para comparar sin distinguir tildes/diacríticos, "a" debe
 *  encontrar "á" en la búsqueda por nombre de zona. */
const DIACRITICS_RE = new RegExp("[\\u0300-\\u036f]", "g");

function normalize(s: string): string {
  return s.normalize("NFD").replace(DIACRITICS_RE, "").toLowerCase();
}

// ── página ───────────────────────────────────────────────────────────────

function MainPage() {
  const navigate = useNavigate();

  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [loading, setLoading] = useState(true);
  /** Selector de a qué zona existente pertenece la carga que viene. */
  const [deleteTarget, setDeleteTarget] = useState<ZoneRow | null>(null);
  // Retiene el último target no-nulo, deleteTarget se pone en null para
  // CERRAR el diálogo (dispara la animación de salida), pero si el texto de
  // la descripción también pasa a depender de null en ese instante, se ve
  // un flash con el mensaje genérico durante los ~200ms de la animación.
  // Este ref/estado mantiene el texto correcto mientras se cierra.
  const [deleteTargetDisplay, setDeleteTargetDisplay] = useState<ZoneRow | null>(null);
  useEffect(() => {
    if (deleteTarget) setDeleteTargetDisplay(deleteTarget);
  }, [deleteTarget]);
  // key de la fila que se está eliminando ahora mismo (o null), el diálogo
  // de confirmación se cierra al instante, y esta fila muestra su propio
  // estado de carga mientras confirmDelete corre en segundo plano. Antes no
  // había ningún indicio de que algo estaba pasando ni confirmación visible
  // hasta que la fila desaparecía de golpe al terminar.
  const [deletingRowKey, setDeletingRowKey] = useState<string | null>(null);

  // Filtro por estado, un desplegable al nivel de "Agregar punto".
  // "historical" (HDU7/AC3) es un quinto filtro aparte, no un ZoneState más
  //, ver filteredZones más abajo: los otros 4 SIEMPRE excluyen históricos,
  // "historical" muestra SOLO históricos.
  const [stateFilter, setStateFilter] = useState<"all" | ZoneState | "historical">("all");
  // Búsqueda por nombre de zona, se combina con el filtro de estado.
  const [nameQuery, setNameQuery] = useState("");
  /** Página de la tabla. Con 54 puntos permanentes más las zonas voladas, el
   *  listado completo era un scroll largo donde no se sabe cuánto falta. */
  const [pagina, setPagina] = useState(0);

  // ── HDU9 (informe PDF) y HDU10 (evolución) ────────────────────────────────
  // Las dos historias se apoyan en los mismos datos: los análisis guardados
  // agrupados por zona. Se cargan una vez acá y se comparten, en vez de que
  // cada diálogo pida lo suyo.
  const [savedAnalyses, setSavedAnalyses] = useState<SavedAnalysisRecord[]>([]);
  // zoneRecords, no "zones": en este archivo `zones` ya son las filas de la
  // tabla (ZoneRow), que mezclan análisis guardados con tareas en curso. Esto
  // otro son las zonas del modelo nuevo, la identidad que agrupa versiones.
  const [zoneRecords, setZoneRecords] = useState<ZoneRecord[]>([]);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportZoneIds, setReportZoneIds] = useState<Set<string>>(new Set());
  /** Zonas elegidas para el informe, ya resueltas, que consume la vista previa. */
  const [reportSelection, setReportSelection] = useState<ReportSelection[] | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  /** Zona cuya evolución se está viendo, o null si el diálogo está cerrado. */
  const [evolutionZone, setEvolutionZone] = useState<ZoneRecord | null>(null);
  /** Punto permanente que se esta editando con el formulario completo, o null. */
  const [editarPunto, setEditarPunto] = useState<ZoneRecord | null>(null);
  /** True mientras el formulario está dando de alta un punto NUEVO.
   *
   *  Separado de `editarPunto` porque el formulario distingue crear de editar
   *  por `punto === null`, y con un solo estado no había forma de decir "abierto
   *  para crear" sin que fuera "cerrado". */
  const [crearPuntoAbierto, setCrearPuntoAbierto] = useState(false);
  /** El punto recién creado, mientras se le pregunta si quiere volarlo ahora.
   *
   *  **Este es el paso que ordena el flujo.** Antes el alta de un lugar y la
   *  carga de su vuelo eran dos caminos que no se tocaban: se creaba el punto y
   *  el trabajador quedaba en la tabla sin ninguna pista de que lo siguiente
   *  era volarlo. Preguntar acá encadena las dos cosas sin obligar: un punto
   *  recién registrado al que todavía no se le voló el dron es un estado
   *  perfectamente válido, y de hecho es el de los 54 de la planilla. */
  const [puntoRecienCreado, setPuntoRecienCreado] = useState<ZoneRecord | null>(null);

  useEffect(() => {
    // Degrada en silencio: si falla, los botones de informe y evolución
    // simplemente no tienen con qué trabajar, no es motivo para romper la
    // vista principal.
    listAnalyses().then(setSavedAnalyses).catch(() => {});
    listZones().then(setZoneRecords).catch(() => {});
  }, []);

  /** La zona a la que pertenece un análisis guardado. Una fila de la tabla es
   *  un análisis; la evolución se abre sobre su zona, que es lo que agrupa
   *  todas las capturas del mismo terreno. Devuelve null para los análisis
   *  anteriores a la migración, que todavía no tienen zona. */
  const zoneOf = (recordId?: string): ZoneRecord | null => {
    if (!recordId) return null;
    const analisis = savedAnalyses.find((a) => a.id === recordId);
    if (!analisis?.zoneId) return null;
    return zoneRecords.find((z) => z.id === analisis.zoneId) ?? null;
  };

  /** Todas las capturas guardadas de la zona a la que pertenece la fila que se
   *  va a eliminar, de la más antigua a la más reciente. Con más de una, el
   *  diálogo ofrece borrar solo esa captura o la zona completa; con una sola no
   *  hay distinción que hacer. Se calcula sobre deleteTargetDisplay y no sobre
   *  deleteTarget por el mismo motivo que el texto: para que no se vacíe
   *  durante la animación de cierre. */
  const capturasDelObjetivo = useMemo(() => {
    if (deleteTargetDisplay?.state !== "done" || !deleteTargetDisplay.recordId) return [];
    const zonaId = savedAnalyses.find((a) => a.id === deleteTargetDisplay.recordId)?.zoneId;
    if (!zonaId) return [];
    return savedAnalyses
      .filter((a) => a.zoneId === zonaId)
      .sort((a, b) => Date.parse(a.savedAt) - Date.parse(b.savedAt));
  }, [deleteTargetDisplay, savedAnalyses]);

  // Orden estilo Excel: click en el encabezado de columna.
  // Solo aplica a las zonas terminadas, en progreso/pendientes siempre van primero.
  const [sortBy, setSortBy] = useState<"fecha" | "volumen" | "peso" | "area">("fecha");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const toggleSort = (field: "fecha" | "volumen" | "peso" | "area") => {
    if (sortBy === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortDir("asc");
    }
  };

  const refreshZones = async (announce?: boolean) => {
    const rows = await loadZoneRows();
    setZones(rows);
    // Los análisis y las zonas se recargan JUNTO con la tabla, no solo una vez
    // al montar. De ellos dependen el botón "Generar informe" (se deshabilita
    // con savedAnalyses vacío), el contenido de su diálogo y la evolución; al
    // cargarse una sola vez, después de eliminar una zona el botón seguía
    // habilitado y el diálogo seguía ofreciendo zonas que ya no existían,
    // hasta que alguien recargaba la página con F5.
    listAnalyses().then(setSavedAnalyses).catch(() => {});
    listZones().then(setZoneRecords).catch(() => {});
    setLoading(false);
    if (announce) {
      notify.success(
        "Listado actualizado",
        `Mostrando ${rows.length} zona${rows.length === 1 ? "" : "s"} disponible${rows.length === 1 ? "" : "s"}.`,
      );
    }
  };

  useEffect(() => {
    refreshZones();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh: mientras haya alguna zona "en progreso", vuelve a consultar
  // su estado cada 5s (mismo intervalo que usa el polling en vivo de
  // carga.tsx) para que pase sola a "pendiente de análisis" sin necesitar F5.
  useEffect(() => {
    if (!zones.some((z) => z.state === "in_progress")) return;
    const interval = setInterval(() => {
      refreshZones();
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones]);

  // AC4, abre una zona terminada en /analysis
  const openZone = (recordId: string) => {
    setPendingOpenId(recordId);
    navigate({ to: "/analysis" });
  };

  // Retoma una generación en curso, vuelve a donde se presionó
  // "Generar mapa unificado" originalmente.
  //
  // clearImageState() primero es clave: si no se limpia, cualquier resto de
  // OTRA tarea (items, resultUrl, detectionJsonUrl) que haya quedado en
  // sessionStorage podía mezclarse con la tarea que se está por retomar , 
  // con 2 procesos en progreso, eso hacía que a veces se mostrara el
  // proceso equivocado en /carga.
  const resumeInCarga = async (row: ZoneRow) => {
    if (!row.taskId) return;
    clearImageState();

    // Reconstruye el grid de "Imágenes adjuntas" con la "foto" que el
    // backend tomó de las imágenes de ESTA tarea al momento de crearla (ver
    // /generate en orquestador.py). No se puede usar la carpeta compartida
    // de subidas: si se cargó otro set de imágenes después, listarla
    // mostraría las miniaturas de esa carga más reciente, no las de la
    // tarea que se está retomando aquí.
    const uploaded = await listTaskImages(row.taskId);
    if (uploaded && uploaded.length > 0) {
      const items: PersistedFileItem[] = uploaded.map((name) => ({
        id: name,
        name,
        size: 0,
        status: "valid",
        preview: getTaskImageUrl(row.taskId!, name),
      }));
      saveItems(items);
      saveUploadDone(true);
    }

    saveTaskId(row.taskId);
    savePhase("generating_map");
    if (row.backendStage === "checking_overlap" || row.backendStage === "joining" || row.backendStage === "detecting") {
      saveBackendStage(row.backendStage);
    }
    navigate({ to: "/carga" });
  };

  // Lleva un mapa ya generado (pero sin analizar/guardar) a /analysis.
  //
  // saveDetectionJsonUrl era condicional (solo se llamaba "if
  // row.resultJsonUrl"), si por lo que sea esa fila no traía su propio
  // resultJsonUrl, la línea simplemente se saltaba y dejaba en
  // sessionStorage lo que hubiera quedado de la ÚLTIMA zona vista/generada
  // antes. Como saveMapUrl() sí es incondicional, el resultado era: mapUrl
  // se actualiza a la zona correcta, pero detectionJsonUrl queda pegado al
  // de otra zona, imagen bien, detecciones cruzadas. Ahora ambos casos son
  // explícitos: si hay URL se guarda, si no se limpia, nunca queda un valor
  // viejo sin tocar.
  //
  // row viene del último refreshZones() cacheado en el estado, puede estar
  // obsoleto: el auto-refresh automático (más abajo) solo corre mientras
  // haya alguna zona "en progreso", así que si el .json del backend todavía
  // no era visible en disco justo en el poll que hizo pasar esta zona a
  // "pendiente" (pasa con la carpeta del proyecto sincronizada por
  // OneDrive/WSL, el archivo puede existir un instante antes de que
  // os.path.exists() lo vea), esa fila queda pegada sin result_json_url
  // para siempre, sin otro refresh que la corrija. Por eso se re-consulta
  // /status fresco acá mismo antes de navegar, en vez de confiar ciegamente
  // en row, así "Ir a Análisis" nunca arrastra un dato incompleto viejo.
  const reviewPending = async (row: ZoneRow) => {
    if (!row.taskId) return;
    const fresh = await getTaskStatus(row.taskId);
    const resultUrl = fresh?.result_url ?? row.resultUrl;
    if (!resultUrl) return;
    // Tarea pendiente, nunca guardada -- sin esto, podía heredar el
    // currentAnalysisId de la última zona guardada vista antes en esta
    // misma pestaña, sobrescribiéndola por error en vez de ofrecer
    // guardar esta tarea como un análisis nuevo.
    clearCurrentAnalysisId();
    saveTaskId(row.taskId);
    saveMapUrl(resultUrl);
    const resultJsonUrl = fresh?.result_json_url ?? row.resultJsonUrl;
    if (resultJsonUrl) {
      saveDetectionJsonUrl(resultJsonUrl);
    } else {
      clearDetectionJsonUrl();
    }
    saveNoWasteDetected((fresh?.detection_count ?? row.detectionCount ?? 0) === 0);
    navigate({ to: "/analysis" });
  };

  const confirmDelete = async (alcance: "captura" | "zona" = "captura") => {
    if (!deleteTarget) return;
    // Cierra el diálogo de inmediato y deja la carga visible EN LA FILA
    // (deletingRowKey) en vez de mantener el diálogo abierto durante todo
    // el borrado, antes la fila desaparecía de golpe recién al terminar,
    // sin ningún indicio de que algo estaba pasando mientras tanto.
    const target = deleteTarget;
    setDeleteTarget(null);
    setDeletingRowKey(target.key);
    const deletedName = target.name;

    // "Toda la zona": se borran TODOS sus análisis, no solo el de la fila. El
    // botón decía "Eliminar zona" y borraba una captura, así que quien tenía
    // una zona de varios vuelos creía haberla eliminado cuando en realidad
    // solo había retrocedido una captura, y el resto quedaba escondido bajo
    // el filtro "Historial".
    if (alcance === "zona" && target.state === "done" && target.recordId) {
      const zonaId = savedAnalyses.find((a) => a.id === target.recordId)?.zoneId;
      const deLaZona = zonaId
        ? savedAnalyses.filter((a) => a.zoneId === zonaId)
        : savedAnalyses.filter((a) => a.id === target.recordId);

      // El que vacía la zona es el ÚLTIMO borrado, así que su respuesta es la
      // que dice si el lugar sobrevivió. Los anteriores siempre dejan análisis
      // atrás y por lo tanto nunca conservan nada.
      let zonaConservada = false;
      for (const analisis of deLaZona) {
        const resultado = await deleteAnalysis(analisis.id);
        zonaConservada = resultado.zonaConservada;
      }
      // Los archivos se borran por VERSIÓN, no por análisis: varios análisis
      // del mismo vuelo comparten mapa y modelos de elevación, y borrarlos una
      // vez por análisis dispararía la misma eliminación varias veces.
      const versiones = new Map<string, SavedAnalysisRecord>();
      for (const a of deLaZona) {
        versiones.set(a.sourceTaskId ?? `sin-tarea:${a.id}`, a);
      }
      for (const a of versiones.values()) {
        borrarArchivosDeVersion(a.mapUrl, a.sourceTaskId);
      }

      await refreshZones();

      setDeletingRowKey(null);
      // Un punto permanente, o una zona a la que alguien le completó la
      // dirección, sobrevive a sus vuelos: decir "zona eliminada" cuando el
      // punto sigue en la tabla sería mentir justo después de la acción que lo
      // dejó ahí.
      notify.success(
        zonaConservada ? "Vuelos eliminados" : "Zona eliminada",
        zonaConservada
          ? `Se eliminaron las ${deLaZona.length} captura(s) de "${deletedName}". El punto sigue registrado, ahora sin vuelo.`
          : `"${deletedName}" y sus ${deLaZona.length} captura(s) ya no aparecen en tu listado.`,
      );
      return;
    }

    // Una zona sin vuelo no tiene análisis ni archivos: se borra el documento
    // y listo. El backend igual se niega con 409 si resulta que sí los tiene,
    // que es la red de seguridad por si la vista quedó desactualizada.
    if (target.state === "no_flight" && target.zoneId) {
      try {
        await deleteZone(target.zoneId);
        notify.success("Punto eliminado", `"${deletedName}" ya no aparece en tu listado.`);
      } catch (e) {
        notify.error("No se pudo eliminar", (e as Error).message);
      }
      await refreshZones();
      setDeletingRowKey(null);
      return;
    }

    if (target.state === "done" && target.recordId) {
      const { zonaConservada } = await deleteAnalysis(target.recordId);

      // Los archivos del vuelo solo se van si NINGÚN análisis los sigue
      // necesitando. Otro análisis del mismo vuelo comparte mapa y modelos de
      // elevación, y borrarlos lo dejaría sin con qué volver a medirse.
      const quedanDeEsteVuelo = savedAnalyses.some(
        (a) =>
          a.id !== target.recordId &&
          target.taskId != null &&
          a.sourceTaskId === target.taskId,
      );
      if (!quedanDeEsteVuelo) {
        borrarArchivosDeVersion(target.mapUrl, target.taskId);
      }

      await refreshZones();

      setDeletingRowKey(null);
      notify.success(
        "Captura eliminada",
        zonaConservada
          ? `"${deletedName}" ya no aparece. El punto sigue registrado, ahora sin vuelo.`
          : `"${deletedName}" ya no aparece en tu listado.`,
      );
      return;
    }

    // Resto de estados: "en progreso" y "pendiente de análisis". Nunca
    // llegaron a ser un análisis guardado, así que no hay registro en
    // `analyses` que borrar, solo la tarea y lo que alcanzó a dejar en disco.
    if (target.taskId) {
      // "En progreso" también cancela el proceso en el backend, no solo
      // deja de trackearlo, si no, seguiría corriendo invisible.
      if (target.state === "in_progress") {
        await cancelTask(target.taskId);
      }

      // "Pendiente de revisión": el mapa y el JSON de detecciones ya se
      // generaron en el servidor aunque nunca se hayan guardado como
      // análisis. Para "en progreso" resultUrl es undefined (el mapa todavía
      // no existe) y borrarArchivosDeVersion solo elimina la tarea.
      borrarArchivosDeVersion(target.resultUrl, target.taskId);

      if (target.resultJsonUrl) {
        const jsonName = target.resultJsonUrl.split("/").pop();
        if (jsonName) deleteResultFile(jsonName);
      }
    }
    await refreshZones();
    setDeletingRowKey(null);
    notify.success("Zona eliminada", `"${deletedName}" ya no aparece en tu listado.`);
  };

  // "Zona nueva" debe partir en blanco, limpia cualquier resto de una
  // sesión de carga anterior (imágenes subidas, mapa generado, progreso)
  // antes de entrar a /carga, para que no se vea la generación previa.
  const goToCarga = (zonaDestino?: string) => {
    clearImageState();
    clearMapUrl();
    clearCurrentAnalysisId();
    deleteAllImages().catch(() => {});
    // ESTE es el punto donde la zona anterior deja de valer: empieza una carga
    // nueva. Va explícito porque clearImageState() ya no la borra, justamente
    // para que no se pierda en los otros lugares donde se limpia el estado de
    // la carga sin que la decisión de zona haya caducado.
    clearZonaDestino();
    if (zonaDestino) saveZonaDestino(zonaDestino);
    navigate({ to: "/carga" });
  };

  const inProgressCount = useMemo(
    () => zones.filter((z) => z.state === "in_progress").length,
    [zones],
  );

  const totals = useMemo(() => {
    // HDU7/AC3, un análisis histórico (reemplazado por uno más reciente
    // confirmado como la misma zona) no debe sumar acá, es justo el doble
    // conteo que el AC pide evitar ("usa el más reciente para el volumen
    // total comunal").
    return zones
      .filter((z) => z.state === "done" && !z.historical)
      .reduce(
        (acc, z) => {
          if (!z.summary) return acc;
          acc.volume += z.summary.totalVolumeM3;
          acc.weight += z.summary.totalWeightKg;
          acc.area += z.summary.totalAreaM2;
          return acc;
        },
        { volume: 0, weight: 0, area: 0 },
      );
  }, [zones]);

  const visibleRows = useMemo(() => {
    // HDU7/AC3, "historical" es el único filtro que muestra análisis
    // reemplazados; los otros 4 (incluido "all") los excluyen siempre, así
    // el listado principal nunca muestra una zona junto a la versión que
    // ya la reemplazó.
    const byState =
      stateFilter === "historical"
        ? zones.filter((r) => r.historical === true)
        : (stateFilter === "all" ? zones : zones.filter((r) => r.state === stateFilter)).filter(
            (r) => !r.historical,
          );
    // **El buscador busca TODO lo que la fila muestra**: el nombre de la zona
    // (la línea grande), el de la medición (la chica) y la dirección (su
    // columna). Antes filtraba solo por `name`, que es el de la MEDICIÓN, así
    // que escribir el nombre que la fila muestra en grande devolvía una tabla
    // vacía. Buscar algo distinto de lo que se ve no se puede explicar.
    const query = normalize(nameQuery.trim());
    const filtered =
      query === ""
        ? byState
        : byState.filter((r) =>
            [r.zoneName, r.name, r.address]
              .filter((campo): campo is string => Boolean(campo))
              .some((campo) => normalize(campo).includes(query)),
          );

    // Arriba va lo que PIDE ATENCIÓN: una generación en curso o un análisis
    // sin guardar. Eso no se ordena por columna porque no tiene cifras que
    // comparar, y bajarlo entre las demás lo esconde justo cuando hay trabajo
    // a medio terminar.
    const pinned = filtered.filter(
      (r) => r.state === "in_progress" || r.state === "pending_analysis",
    );

    // **Las zonas con vuelo y sin vuelo se ordenan JUNTAS.** Las sin vuelo
    // iban concatenadas al final sin pasar por el comparador, o sea el orden
    // de columna no las tocaba: con la unificación son el mismo objeto (un
    // lugar de la comuna) y partir la tabla en dos bloques contradecía eso.
    // Una zona sin medición entra con 0 en volumen, peso y área, que es lo que
    // la tabla muestra como "-", así que en orden descendente sigue quedando
    // al final por sí sola, pero ahora porque el orden lo dice.
    const resto = [...filtered.filter((r) => r.state === "done" || r.state === "no_flight")];

    resto.sort((a, b) => {
      let av = 0;
      let bv = 0;
      if (sortBy === "fecha") {
        av = new Date(a.savedAt).getTime();
        bv = new Date(b.savedAt).getTime();
      } else if (sortBy === "volumen") {
        av = a.summary?.totalVolumeM3 ?? 0;
        bv = b.summary?.totalVolumeM3 ?? 0;
      } else if (sortBy === "peso") {
        av = a.summary?.totalWeightKg ?? 0;
        bv = b.summary?.totalWeightKg ?? 0;
      } else {
        av = a.summary?.totalAreaM2 ?? 0;
        bv = b.summary?.totalAreaM2 ?? 0;
      }
      if (av !== bv) return sortDir === "asc" ? av - bv : bv - av;
      // Desempate por nombre, para que las zonas sin medición (todas en 0) no
      // queden en un orden que dependa de cómo vinieron de Mongo.
      return (a.zoneName ?? a.name).localeCompare(b.zoneName ?? b.name, "es");
    });

    return [...pinned, ...resto];
  }, [zones, stateFilter, nameQuery, sortBy, sortDir]);

  /** Las opciones del filtro con el conteo de filas que dejaría cada una.
   *
   *  Los conteos aplican las MISMAS exclusiones que `visibleRows`: los cinco
   *  estados nunca cuentan históricos y "Historial" cuenta solo esos. Si se
   *  contaran sin esa regla, el filtro prometería un número y mostraría otro.
   *  No se cuenta sobre la búsqueda a propósito: el conteo describe el estado
   *  del listado completo, no el cruce con lo que haya escrito en el buscador. */
  const opcionesDeEstado = useMemo(() => {
    const vigentes = zones.filter((z) => !z.historical);
    const porEstado = (estado: ZoneState) => vigentes.filter((z) => z.state === estado).length;
    return [
      { valor: "all" as const, etiqueta: "Todas", conteo: vigentes.length },
      // "Con análisis" y no "Terminadas": las opciones describen el ESTADO del
      // lugar y no qué se hizo con él, y tener una medición guardada es justo
      // lo que distingue a un lugar que puede entrar a una ruta.
      { valor: "done" as const, etiqueta: "Con análisis", conteo: porEstado("done") },
      { valor: "in_progress" as const, etiqueta: "En progreso", conteo: porEstado("in_progress") },
      {
        valor: "pending_analysis" as const,
        etiqueta: "Pendientes",
        conteo: porEstado("pending_analysis"),
      },
      // Los lugares registrados a los que todavía no se les voló el dron.
      { valor: "no_flight" as const, etiqueta: "Sin vuelo", conteo: porEstado("no_flight") },
      {
        valor: "historical" as const,
        etiqueta: "Historial",
        conteo: zones.filter((z) => z.historical === true).length,
      },
    ];
  }, [zones]);

  /** Cambia el filtro de estado y vuelve a la primera página.
   *
   *  Las dos cosas juntas: filtrar desde la página 3 a un estado con menos
   *  filas que eso dejaba la tabla vacía hasta que el recorte de página la
   *  corregía, o sea el filtro parecía no encontrar nada. */
  const cambiarFiltro = (filtro: "all" | ZoneState | "historical") => {
    setStateFilter(filtro);
    setPagina(0);
  };

  // Paginación. La página fuera de rango se corrige al calcular y no con un
  // efecto, que provocaría un render de más; mismo criterio que las tablas de
  // recursos y del itinerario.
  const paginas = Math.max(1, Math.ceil(visibleRows.length / FILAS_POR_PAGINA));
  const paginaActual = Math.min(pagina, paginas - 1);
  const pageRows = useMemo(
    () => visibleRows.slice(paginaActual * FILAS_POR_PAGINA, (paginaActual + 1) * FILAS_POR_PAGINA),
    [visibleRows, paginaActual],
  );

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Encabezado de página. Acá vivió el acceso a "Recursos disponibles",
          primero como columna fija y después como panel deslizante; ya no
          existe en ninguna de las dos formas. HDU6 tiene su propia página
          completa en /recursos, alcanzable desde el menú lateral, y este
          resumen era una tercera copia de la misma información: lo que esta
          vista tiene que mostrar es el listado de zonas. */}
      <div className="flex items-center justify-between border-b border-border/25 px-6 py-5">
        <div>
          {/* Rótulo sobre el título, equivalente de la .eyebrow del sitio. */}
          <p className="eyebrow">Listado de Zonas</p>
          <h2 className="font-rubik text-3xl font-semibold tracking-normal text-foreground md:text-4xl">
            Zonas Monitoreadas
          </h2>
        </div>
      </div>

      <main className="flex flex-1">

        {/* ── Contenido: KPIs + listado de zonas ── */}
        <section className="flex min-w-0 flex-1 flex-col p-6">

          {/* KPIs generales, el primer dato que la Municipalidad necesita leer al
              entrar, por eso usa el mismo tratamiento .panel que el resto del
              sistema en vez de quedar como una tira plana. */}
          <div className="panel mb-6 flex flex-wrap items-center divide-x divide-border/10 px-1 animate-in fade-in slide-in-from-top-2 duration-500">
            <Kpi
              icon={<ChartLineUp className="h-4 w-4" />}
              label="Zonas registradas"
              // HDU7/AC3, mismo criterio que "totals" más abajo: un análisis
              // histórico (reemplazado) ya no cuenta como zona vigente.
              value={String(zones.filter((z) => !z.historical).length)}
            />
            <Kpi icon={<Boxes className="h-4 w-4" />} label="Volumen total" value={`${entero(totals.volume)} m³`} />
            <Kpi icon={<Scale className="h-4 w-4" />} label="Peso total" value={`${entero(totals.weight)} kg`} />
            <Kpi icon={<Crosshair className="h-4 w-4" />} label="Área total" value={`${entero(totals.area)} m²`} />
            {inProgressCount > 0 && (
              <div className="flex flex-shrink-0 items-center gap-2 px-5 py-3.5">
                <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-primary" />
                <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-primary/80">
                  {inProgressCount} en vivo
                </span>
              </div>
            )}
          </div>

          {/* Tarjeta que contiene filtros + tabla, mismo tratamiento .bg-card
              que el resto del sistema, sin duplicar el shadow pesado de
              .panel (ya lo lleva la franja de KPIs arriba). */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card animate-in fade-in slide-in-from-top-2 duration-500 delay-100 fill-mode-both">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
            <div className="flex items-center gap-2.5 border-l-2 border-primary/50 pl-3">
              <Layers className="h-3.5 w-3.5 text-foreground/70" />
              <h3 className="text-sm font-semibold tracking-tight text-foreground">Listado de zonas</h3>
            </div>

            {/* Búsqueda por nombre de zona, centrada entre el título y los filtros */}
            <div className="flex min-w-[15rem] flex-1 justify-center">
              <div className="relative w-full max-w-md">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={nameQuery}
                  onChange={(e) => {
                    setNameQuery(e.target.value);
                    // Sin esto, escribir desde la página 3 deja la tabla
                    // vacía hasta que el recorte de página la corrige.
                    setPagina(0);
                  }}
                  placeholder="Buscar por nombre o dirección..."
                  className="h-9 w-full pl-9 text-sm"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* Filtro por estado, 5 botones, uno activo a la vez.
                  "Historial" (HDU7/AC3) es el único que muestra análisis
                  reemplazados; los otros 4 los excluyen siempre. */}
              {/* Seis opciones en un desplegable, no seis botones en una
                  píldora: a ese ancho la fila de chips competía con el
                  buscador y con los dos botones de informe, y era lo primero
                  que se partía en dos líneas al angostar la ventana.
                  Cada opción lleva su conteo, así que elegir el filtro ya
                  dice cuántas filas va a dejar. */}
              <FiltroDropdown
                etiqueta="Estado"
                valor={stateFilter}
                opciones={opcionesDeEstado}
                onCambio={cambiarFiltro}
              />
              {/* HDU9/AC4, sin ninguna zona guardada no hay informe posible:
                  el botón queda deshabilitado y el motivo aparece al pasar el
                  puntero por encima.

                  El tooltip NO puede colgar del botón. Un elemento con
                  `disabled` no emite eventos de puntero, así que ni el `title`
                  nativo ni el disparador de Radix llegan a activarse: el
                  mensaje existía pero era inalcanzable, que es justo lo que
                  pide el criterio. Por eso el disparador va en un <span> que
                  envuelve al botón y sí recibe el hover. */}
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={savedAnalyses.length === 0 ? 0 : -1}>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setReportOpen(true)}
                        disabled={savedAnalyses.length === 0}
                      >
                        <FileText className="mr-1.5 h-3.5 w-3.5" /> Generar informe
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {savedAnalyses.length === 0 && (
                    <TooltipContent side="bottom" className="max-w-xs text-left">
                      No hay análisis guardados todavía. Guarda al menos uno para poder generar un informe.
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
              {/* **"Agregar punto" y no "Agregar zona", y abre el formulario
                  del punto en vez de un menú de dos tarjetas.**

                  Las dos tarjetas eran "Zona nueva" (cargar imágenes sin
                  declarar lugar) y "Modificar zona existente" (elegir uno de
                  una lista). La primera es justo el camino que crea huérfanos,
                  y la segunda quedó cubierta por el botón "Generar mapa" de
                  cada fila, donde el lugar ya está a la vista con su dirección
                  y sus cifras en vez de ser un nombre en una lista.

                  Lo que queda es un solo gesto: se registra el lugar, y
                  después se le cuelga el vuelo si corresponde. */}
              <Button size="sm" onClick={() => setCrearPuntoAbierto(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" /> Agregar punto
              </Button>
            </div>
          </div>

          {loading ? (
            <div className="flex-1 overflow-y-auto px-5 pb-5" role="status" aria-live="polite">
              <span className="sr-only">Cargando zonas...</span>
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    {/* El esqueleto usa LOS MISMOS SortableHead que la tabla
                        cargada, no una copia escrita a mano. Mantener dos
                        versiones ya había derivado en encabezados distintos, y
                        cualquier diferencia de ancho hace que las columnas se
                        corran justo cuando terminan de cargar los datos.
                        Presionarlos mientras carga es inofensivo: fija el orden
                        y se aplica cuando llegan las filas. */}
                    <TableHead className="w-[7.5rem]"></TableHead>
                    <TableHead>Zona</TableHead>
                    {/* La direccion es como el trabajador reconoce el lugar
                        en la calle; el nombre es como lo llama el sistema. */}
                    <TableHead className="hidden lg:table-cell">Dirección</TableHead>
                    {/* Barrio y Tipo son los campos con que la municipalidad
                        agrupa y clasifica sus lugares. Antes solo se veían en
                        el Itinerario, así que un punto y una zona nacida de un
                        vuelo parecían dos cosas distintas según dónde se
                        miraran. */}
                    <TableHead className="hidden xl:table-cell">Barrio</TableHead>
                    <TableHead className="hidden xl:table-cell">Tipo</TableHead>
                    <SortableHead field="fecha" label="Fecha" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                    <SortableHead field="volumen" label="Volumen" unit="m³" className="w-[7rem]" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="center" />
                    <SortableHead field="peso" label="Peso" unit="kg" className="w-[7rem]" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="center" />
                    <SortableHead field="area" label="Área" unit="m²" className="w-[7rem]" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="center" />
                    <TableHead className="text-right"></TableHead>
                    <TableHead className="w-[2.75rem]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[0, 1, 2].map((i) => (
                    <TableRow key={i} className="hover:bg-transparent">
                      <TableCell><Skeleton className="h-16 w-24" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                      <TableCell className="hidden lg:table-cell"><Skeleton className="h-4 w-40" /></TableCell>
                      <TableCell className="hidden xl:table-cell"><Skeleton className="h-4 w-20" /></TableCell>
                      <TableCell className="hidden xl:table-cell"><Skeleton className="h-4 w-24" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                      <TableCell className="text-center"><Skeleton className="mx-auto h-4 w-14" /></TableCell>
                      <TableCell className="text-center"><Skeleton className="mx-auto h-4 w-14" /></TableCell>
                      <TableCell className="text-center"><Skeleton className="mx-auto h-4 w-14" /></TableCell>
                      <TableCell className="text-right"><Skeleton className="ml-auto h-8 w-24" /></TableCell>
                      <TableCell><Skeleton className="h-8 w-8" /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : visibleRows.length > 0 ? (
            // `pb-2` y no `pb-5`: la barra de paginación ya aporta su propio
            // espacio, y con los dos quedaba un hueco doble antes del pie.
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2 animate-in fade-in duration-300">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableHead className="w-[7.5rem]"></TableHead>
                    <TableHead>Zona</TableHead>
                    <TableHead className="hidden lg:table-cell">Dirección</TableHead>
                    {/* Barrio y Tipo son los campos con que la municipalidad
                        agrupa y clasifica sus lugares. Antes solo se veían en
                        el Itinerario, así que un punto y una zona nacida de un
                        vuelo parecían dos cosas distintas según dónde se
                        miraran. */}
                    <TableHead className="hidden xl:table-cell">Barrio</TableHead>
                    <TableHead className="hidden xl:table-cell">Tipo</TableHead>
                    <SortableHead field="fecha" label="Fecha" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                    <SortableHead field="volumen" label="Volumen" unit="m³" className="w-[7rem]" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="center" />
                    <SortableHead field="peso" label="Peso" unit="kg" className="w-[7rem]" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="center" />
                    <SortableHead field="area" label="Área" unit="m²" className="w-[7rem]" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="center" />
                    <TableHead className="text-right"></TableHead>
                    <TableHead className="w-[2.75rem]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((z) => {
                    const isDeleting = deletingRowKey === z.key;
                    return (
                    <TableRow
                      key={z.key}
                      className={`animate-in fade-in slide-in-from-top-1 duration-300 fill-mode-both hover:bg-card/60 transition-opacity ${isDeleting ? "pointer-events-none opacity-40" : ""}`}
                    >
                      <TableCell>
                        {z.mapUrl ? (
                          // detect-frame-sm: variante chica de las esquinas, la
                          // de 26px se comería una miniatura de 96x64.
                          <div className="detect-frame detect-frame-sm h-16 w-24 overflow-hidden rounded-md bg-muted">
                            <span className="detect-corners" aria-hidden="true" />
                            <img
                              src={z.thumbnailUrl ?? z.mapUrl}
                              alt={`Mapa de ${z.name}`}
                              className="h-full w-full object-cover"
                            />
                          </div>
                        ) : z.state === "in_progress" ? (
                          // Proceso activo en el backend, el barrido de .scan-line
                          // conecta la fila con la identidad de detección aérea del
                          // resto de la página, y el ícono deja inequívoco que está
                          // cargando (el barrido solo no era suficientemente claro).
                          <div className="scan-line relative flex h-16 w-24 items-center justify-center overflow-hidden rounded-md border border-dashed border-primary/30 bg-background/30">
                            <Loader2 className="h-4 w-4 animate-spin text-primary/70" />
                          </div>
                        ) : (
                          <div className="flex h-16 w-24 items-center justify-center rounded-md border border-dashed border-border/40 bg-background/30">
                            <ArrowRightCircle className="h-4 w-4 text-warning/70" />
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="font-medium">
                        {/* El nombre de la ZONA arriba y el de la versión
                            debajo. Una fila es un análisis, pero lo que se lee
                            en esta columna es "qué terreno es", y mostrando solo
                            el nombre del análisis la tabla decía "Medición
                            02-06-2026" donde el trabajador busca "Avenida Las
                            Industrias": la zona quedaba nombrada por su primera
                            medición y nada en pantalla distinguía las dos cosas.

                            Cae al nombre del análisis cuando no hay zona: las
                            tareas en curso todavía no tienen una, y los
                            análisis anteriores a la migración de zonas tampoco. */}
                        {(() => {
                          // Un punto permanente ES la zona, no tiene análisis
                          // del que sacarla, y su lápiz abre la EDICIÓN
                          // completa (dirección, barrio, tipo, frecuencia,
                          // foto) y no solo el renombrado: renombrar es lo
                          // único que se puede hacer sobre una zona nacida de
                          // un vuelo, pero acá hay un formulario detrás.
                          if (z.state === "no_flight" && z.zoneId) {
                            const permanente = zoneRecords.find((r) => r.id === z.zoneId);
                            return (
                              <span className="inline-flex items-center gap-1.5">
                                {z.name}
                                {permanente && (
                                  <button
                                    type="button"
                                    onClick={() => setEditarPunto(permanente)}
                                    title="Editar el punto"
                                    aria-label={`Editar el punto ${z.name}`}
                                    className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </button>
                                )}
                              </span>
                            );
                          }
                          const zona = zoneOf(z.recordId);
                          if (!zona) return z.name;
                          return (
                            <>
                              <span className="inline-flex items-center gap-1.5">
                                {zona.name}
                                <button
                                  type="button"
                                  onClick={() => setEditarPunto(zona)}
                                  title="Editar la zona"
                                  aria-label={`Editar la zona ${zona.name}`}
                                  className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                              </span>
                              {/* El nombre de la versión se renombra desde su
                                  propia vista, donde además se ve de qué captura
                                  se trata. Acá solo se nombra. */}
                              {z.name !== zona.name && (
                                <p className="mt-0.5 text-[0.625rem] font-normal text-muted-foreground">
                                  {z.name}
                                </p>
                              )}
                            </>
                          );
                        })()}
                        {z.state !== "done" && (
                          <span
                            className={`ml-2 rounded px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide ${
                              z.state === "in_progress"
                                ? "bg-primary/15 text-primary"
                                : z.state === "no_flight"
                                  ? "bg-muted text-muted-foreground"
                                  : "bg-warning/15 text-warning"
                            }`}
                          >
                            {z.state === "in_progress"
                              ? "En progreso"
                              : z.state === "no_flight"
                                ? "Sin vuelo"
                                : "Pendiente"}
                          </span>
                        )}
                        {z.historical && (
                          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-muted-foreground">
                            Histórico
                          </span>
                        )}
                        {/* HDU7/AC3, solo tiene sentido bajo el filtro "Historial", los
                            demás filtros ya excluyen las filas históricas. */}
                        {z.historical && z.supersededByName && (
                          <p className="mt-0.5 text-[0.625rem] font-normal text-muted-foreground">
                            Reemplazado por: {z.supersededByName}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="hidden max-w-[16rem] lg:table-cell">
                        {z.address ? (
                          <span className="line-clamp-2 text-xs text-muted-foreground">
                            {z.address}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground/60">-</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden xl:table-cell">
                        <span className="text-xs text-muted-foreground">
                          {z.barrio || <span className="text-muted-foreground/60">-</span>}
                        </span>
                      </TableCell>
                      <TableCell className="hidden xl:table-cell">
                        <span className="text-xs text-muted-foreground">
                          {z.tipo || <span className="text-muted-foreground/60">-</span>}
                        </span>
                      </TableCell>
                      {/* Fecha arriba y hora debajo: ordenar por fecha con
                          varias zonas del mismo día no decía cuál fue antes. */}
                      <TableCell className="text-muted-foreground">
                        <span className="block text-xs">
                          {new Date(z.savedAt).toLocaleDateString("es-CL")}
                        </span>
                        <span className="mono block text-[0.625rem] text-muted-foreground/70">
                          {new Date(z.savedAt).toLocaleTimeString("es-CL", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </TableCell>
                      {/* Solo la cifra: la unidad la dice el encabezado de la
                          columna. Redondeadas al entero y con miles separados
                          por punto: acá se barren filas comparando órdenes de
                          magnitud, y los decimales son ruido (el detalle fino
                          está en la vista de análisis).

                          El guion de "sin dato" va CENTRADO y no alineado a la
                          derecha como las cifras: pegado al borde derecho
                          parecía un número cortado. */}
                      <TableCell className="text-center mono tabular-nums">
                        {z.summary ? entero(z.summary.totalVolumeM3) : <SinDato />}
                      </TableCell>
                      <TableCell className="text-center mono tabular-nums">
                        {z.summary ? entero(z.summary.totalWeightKg) : <SinDato />}
                      </TableCell>
                      <TableCell className="text-center mono tabular-nums">
                        {z.summary ? entero(z.summary.totalAreaM2) : <SinDato />}
                      </TableCell>
                      <TableCell className="text-right">
                        {z.state === "done" && (
                          <div className="flex items-center justify-end gap-2">
                            {/* HDU10, el botón aparece en toda zona guardada,
                                también con una sola captura. Antes se ocultaba
                                en ese caso, por parecer que no había nada que
                                mostrar, pero eso dejaba el AC3 de la historia
                                ("una zona sin versiones anteriores debe indicar
                                que no hay con qué comparar") inalcanzable desde
                                la interfaz: el diálogo sabía dar ese mensaje y
                                nunca se llegaba a él. */}
                            {(() => {
                              const zona = zoneOf(z.recordId);
                              if (!zona) return null;
                              return (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => setEvolutionZone(zona)}
                                  title="Ver cómo cambió el volumen de esta zona"
                                >
                                  <ChartLineUp className="mr-1.5 h-3.5 w-3.5" /> Evolución
                                </Button>
                              );
                            })()}
                            {/* Volver a volar un lugar ya medido. Reemplaza a
                                "Modificar zona existente", que vivía en el
                                popup de "Agregar zona" y obligaba a reconocer
                                el lugar por su nombre en una lista; acá está en
                                su propia fila, con su dirección y sus cifras a
                                la vista.
                                Con fondo y texto, igual que "Evolución" y "Ver
                                Análisis": estuvo como ícono suelto sin fondo y
                                era imperceptible al lado de ellos, o sea la
                                acción existía y no se veía. */}
                            {z.zoneId && (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => goToCarga(z.zoneId)}
                                title="Subir un set de imágenes nuevo y generar otro mapa de este punto"
                              >
                                <Plus className="mr-1.5 h-3.5 w-3.5" /> Nuevo vuelo
                              </Button>
                            )}
                            <Button size="sm" onClick={() => openZone(z.recordId!)}>
                              <Eye className="mr-1.5 h-3.5 w-3.5" /> Ver Análisis
                            </Button>
                          </div>
                        )}
                        {z.state === "in_progress" && (
                          <Button size="sm" variant="secondary" className={ACCION_FILA} onClick={() => resumeInCarga(z)}>
                            <ArrowRightCircle className="mr-1.5 h-3.5 w-3.5" /> Ir a Carga
                          </Button>
                        )}
                        {z.state === "pending_analysis" && (
                          <Button size="sm" variant="secondary" className={ACCION_FILA} onClick={() => reviewPending(z)}>
                            <ArrowRightCircle className="mr-1.5 h-3.5 w-3.5" /> Ir a Análisis
                          </Button>
                        )}
                        {/* El lugar existe antes del vuelo, así que se le puede
                            volar el dron desde su propia fila. El `zoneId`
                            viaja a /carga y de ahí al guardado del análisis, de
                            modo que la medición queda colgada de ESTE punto en
                            vez de crear un lugar nuevo que después habría que
                            reconocer como duplicado.

                            Antes, la única forma de declarar la zona era el
                            popup de "Agregar zona", o sea había que saber que
                            el punto ya existía y buscarlo en una lista. */}
                        {z.state === "no_flight" && z.zoneId && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className={ACCION_FILA}
                            onClick={() => goToCarga(z.zoneId)}
                            title="Subir imágenes y generar el mapa unificado de este punto"
                          >
                            <ArrowRightCircle className="mr-1.5 h-3.5 w-3.5" /> Generar mapa
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>
                        {isDeleting ? (
                          <div className="flex h-8 w-8 items-center justify-center" title="Eliminando...">
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-destructive/70" />
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                            onClick={() => setDeleteTarget(z)}
                            title="Eliminar zona"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center animate-in fade-in duration-300">
              <FolderOpen className="h-8 w-8 text-muted-foreground/30" />
              <p className="text-sm font-medium text-foreground">
                {zones.length === 0 ? "No hay zonas guardadas todavía" : "Ninguna zona coincide con el filtro"}
              </p>
              <p className="text-xs text-muted-foreground">
                {zones.length === 0
                  ? 'Presiona "Agregar punto" para registrar tu primer lugar.'
                  : "Ajusta el filtro para ver más resultados."}
              </p>
            </div>
          )}

          {/* **La barra va FUERA del contenedor que hace scroll**, así
              queda pegada al pie de la tarjeta tenga la página 2 filas o
              10. Estaba dentro, justo después de la última fila, así que
              con pocas filas flotaba a media tarjeta y con muchas había que
              desplazarse para encontrarla.
              Se dibuja siempre que haya filas, aunque sea una sola página:
              apareciendo y desapareciendo movería la tabla al filtrar. */}
          {!loading && visibleRows.length > 0 && (
            <div className="flex flex-shrink-0 items-center justify-between border-t border-border px-5 py-3">
                <span className="text-[0.625rem] text-muted-foreground">
                  {visibleRows.length} zona{visibleRows.length === 1 ? "" : "s"}
                  {(nameQuery.trim() !== "" || stateFilter !== "all") && ` de ${zones.length}`}
                </span>
                <div className="flex items-center gap-2">
                  <span className="mono text-[0.625rem] tabular-nums text-muted-foreground">
                    {paginaActual + 1} / {paginas}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-7 p-0"
                    disabled={paginaActual === 0}
                    onClick={() => setPagina(paginaActual - 1)}
                    aria-label="Página anterior"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-7 p-0"
                    disabled={paginaActual >= paginas - 1}
                    onClick={() => setPagina(paginaActual + 1)}
                    aria-label="Página siguiente"
                  >
                    <ArrowLeft className="h-3.5 w-3.5 rotate-180" />
                  </Button>
                </div>
              </div>
          )}
          </div>
        </section>
      </main>

      {/* ── HDU9, selección de zonas para el informe ── */}
      {/* El listado incluye TODAS las versiones de cada zona, incluidas las
          reemplazadas: sin ellas el criterio de comparar una versión con la
          que la sucedió sería inalcanzable, porque los filtros de la tabla
          las ocultan. */}
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Generar informe de volumen</DialogTitle>
            <DialogDescription>
              Elige las zonas a incluir. El informe detalla el volumen total, el desglose por
              tipo de residuo y, cuando una zona tiene más de una captura, cómo cambió entre ellas.
            </DialogDescription>
          </DialogHeader>

          {/* Barra de selección: cuántas van marcadas y el atajo para marcar o
              desmarcar todas. Con varias zonas guardadas, armar un informe
              completo obligaba a hacer click una por una. */}
          {zoneRecords.length > 0 && (
            <div className="flex items-center justify-between gap-2 border-y border-border/60 py-2">
              <span className="text-xs text-muted-foreground">
                {reportZoneIds.size === 0
                  ? "Ninguna zona seleccionada"
                  : `${reportZoneIds.size} de ${zoneRecords.length} seleccionadas`}
              </span>
              <button
                type="button"
                onClick={() =>
                  setReportZoneIds((prev) =>
                    prev.size === zoneRecords.length
                      ? new Set()
                      : new Set(zoneRecords.map((z) => z.id)),
                  )
                }
                className="cursor-pointer text-xs text-primary transition-colors hover:underline"
              >
                {reportZoneIds.size === zoneRecords.length ? "Quitar todas" : "Seleccionar todas"}
              </button>
            </div>
          )}

          <ul className="max-h-[21.25rem] space-y-1.5 overflow-y-auto pr-1">
            {zoneRecords.map((z) => {
              const deLaZona = savedAnalyses.filter((a) => a.zoneId === z.id);
              const versiones = new Set(deLaZona.map((a) => a.sourceTaskId ?? a.id)).size;
              const marcada = reportZoneIds.has(z.id);
              // La medición más reciente de la zona: es la que da la miniatura
              // y la cifra que se muestra en la fila.
              const ultima = deLaZona[deLaZona.length - 1];
              const volumen = deLaZona.reduce((s, a) => s + zoneTotals(a).volumeM3, 0);
              return (
                <li key={z.id}>
                  <button
                    type="button"
                    onClick={() =>
                      setReportZoneIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(z.id)) next.delete(z.id);
                        else next.add(z.id);
                        return next;
                      })
                    }
                    className={`flex w-full cursor-pointer items-center gap-3 rounded-lg border p-2.5 text-left transition-all duration-200 ${
                      marcada
                        ? "border-primary bg-primary/5"
                        : "border-border/60 hover:border-border hover:bg-muted/40"
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-colors ${
                        marcada ? "border-primary bg-primary text-primary-foreground" : "border-border"
                      }`}
                    >
                      {marcada && <span className="text-[0.58rem] leading-none">✓</span>}
                    </span>

                    {/* La miniatura del mapa, igual que en la tabla de zonas:
                        el nombre de una zona no dice mucho por sí solo, y al
                        elegir qué va en un informe conviene ver cuál es. */}
                    {ultima && (
                      <span className="detect-frame detect-frame-sm h-11 w-14 flex-shrink-0 overflow-hidden rounded">
                        <span className="detect-corners" aria-hidden="true" />
                        <img
                          src={ultima.thumbnailUrl ?? ultima.mapUrl}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      </span>
                    )}

                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {z.name}
                      </span>
                      <span className="block text-[0.6875rem] text-muted-foreground">
                        <span className="mono tabular-nums">{versiones}</span>{" "}
                        {versiones === 1 ? "captura" : "capturas"} ·{" "}
                        <span className="mono tabular-nums">{deLaZona.length}</span>{" "}
                        {deLaZona.length === 1 ? "análisis" : "análisis"}
                      </span>
                    </span>

                    <span className="mono flex-shrink-0 text-xs font-semibold tabular-nums text-foreground">
                      {volumen.toFixed(2)} m³
                    </span>
                  </button>
                </li>
              );
            })}
            {zoneRecords.length === 0 && (
              <li className="flex flex-col items-center gap-2 py-8 text-center">
                <FileText className="h-7 w-7 text-muted-foreground/40" />
                <p className="text-sm font-medium text-foreground">No hay zonas guardadas</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Guarda el análisis de una zona y aparecerá acá para incluirla en un informe.
                </p>
              </li>
            )}
          </ul>

          {/* Qué va a salir en el documento, antes de generarlo. */}
          {reportZoneIds.size > 0 && (
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
              <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
                El informe incluirá
              </p>
              <div className="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  <span className="mono font-semibold tabular-nums text-foreground">
                    {reportZoneIds.size}
                  </span>{" "}
                  {reportZoneIds.size === 1 ? "zona" : "zonas"}
                </span>
                <span>
                  <span className="mono font-semibold tabular-nums text-foreground">
                    {savedAnalyses.filter((a) => a.zoneId && reportZoneIds.has(a.zoneId)).length}
                  </span>{" "}
                  análisis
                </span>
                <span>
                  <span className="mono font-semibold tabular-nums text-foreground">
                    {savedAnalyses
                      .filter((a) => a.zoneId && reportZoneIds.has(a.zoneId))
                      .reduce((s, a) => s + zoneTotals(a).volumeM3, 0)
                      .toFixed(2)}{" "}
                    m³
                  </span>{" "}
                  en total
                </span>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReportOpen(false)}>Cancelar</Button>
            {/* Ya no descarga directo: abre la misma vista previa que la vista
                de Análisis, para revisar el documento antes de guardarlo. */}
            <Button
              disabled={reportZoneIds.size === 0}
              onClick={() => {
                setReportSelection(
                  zoneRecords
                    .filter((z) => reportZoneIds.has(z.id))
                    .map((zone) => ({
                      zone,
                      analyses: savedAnalyses.filter((a) => a.zoneId === zone.id),
                    }))
                    .filter((s) => s.analyses.length > 0),
                );
                setReportOpen(false);
                setPreviewOpen(true);
              }}
            >
              <FileText className="mr-2 h-4 w-4" /> Ver informe
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ReportPreview
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        selections={reportSelection}
      />

      {/* Renombrar la zona desde el listado. El nombre de cada versión se
          cambia en la vista de análisis, donde se ve de qué captura se trata;
          acá lo que se compara entre filas es el terreno. */}
      {/* HDU14: la edición completa de un punto permanente, el mismo
          formulario que usa la vista de itinerario. Compartirlo y no escribir
          una segunda copia es lo que impide que las dos pantallas pidan campos
          distintos para lo mismo. */}
      {/* El mismo formulario sirve para crear y para editar: `punto === null`
          es lo que el diálogo usa para distinguirlos. */}
      <PuntoPermanenteDialog
        open={editarPunto !== null || crearPuntoAbierto}
        onOpenChange={(abierto) => {
          if (!abierto) {
            setEditarPunto(null);
            setCrearPuntoAbierto(false);
          }
        }}
        punto={editarPunto}
        onGuardado={(zona) => {
          void refreshZones();
          void listZones().then(setZoneRecords).catch(() => {});
          // Solo al CREAR se ofrece seguir con el vuelo. Al editar, el
          // trabajador vino a corregir un dato y no a volar nada.
          if (crearPuntoAbierto) {
            setCrearPuntoAbierto(false);
            setPuntoRecienCreado(zona);
          }
        }}
      />

      {/* El paso opcional que encadena el alta con la carga. Dos salidas y
          ninguna destructiva: volar ahora, o dejar el punto registrado y
          seguir. "Más tarde" va primero en el orden de lectura porque es el
          caso de los 54 puntos de la planilla: se registran todos y se vuelan
          de a uno. */}
      <Dialog
        open={puntoRecienCreado !== null}
        onOpenChange={(open) => !open && setPuntoRecienCreado(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Punto creado</DialogTitle>
            <DialogDescription>
              {puntoRecienCreado?.name} quedó registrado. ¿Quieres cargar ahora el set de imágenes
              para generar su mapa unificado?
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => setPuntoRecienCreado(null)}>
              Más tarde
            </Button>
            <Button
              className="btn-cta"
              onClick={() => {
                const destino = puntoRecienCreado;
                setPuntoRecienCreado(null);
                if (destino) goToCarga(destino.id);
              }}
            >
              <ArrowRightCircle className="mr-1.5 h-3.5 w-3.5" /> Cargar imágenes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── HDU10, evolución de una zona ── */}
      <Dialog open={evolutionZone !== null} onOpenChange={(open) => !open && setEvolutionZone(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Evolución de {evolutionZone?.name}</DialogTitle>
            <DialogDescription>
              Cómo cambió el volumen de esta zona entre sus distintas capturas.
            </DialogDescription>
          </DialogHeader>
          {evolutionZone && (
            <Suspense
              fallback={
                <div className="flex h-[13rem] items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <ZoneEvolution
                zone={evolutionZone}
                analyses={savedAnalyses}
                onOpenAnalysis={(id) => {
                  setPendingOpenId(id);
                  navigate({ to: "/analysis" });
                }}
              />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>

      {/* Confirmación de eliminar.
          Con una zona de varias capturas hay DOS acciones distintas, y antes
          el diálogo ofrecía una sola diciendo "Eliminar zona ... y todos sus
          datos guardados" mientras borraba una única captura. Quien tenía dos
          vuelos creía haber eliminado la zona y lo que había hecho era
          retroceder a la captura anterior, con el resto escondido bajo el
          filtro "Historial". */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {capturasDelObjetivo.length > 1 ? "Eliminar de esta zona" : "Eliminar zona"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTargetDisplay?.state !== "done"
                ? deleteTargetDisplay?.state === "in_progress"
                  ? "Esto cancela la generación en curso en el servidor y deja de mostrarla en tu listado."
                  : "Esto deja de mostrar este análisis pendiente en tu listado. El mapa generado sigue en el servidor, pero ya no se te va a ofrecer para revisarlo."
                : capturasDelObjetivo.length > 1
                  ? `Esta zona tiene ${capturasDelObjetivo.length} capturas guardadas. Puedes eliminar solo la que seleccionaste, y la anterior vuelve a ser la vigente, o la zona completa con todo su historial.`
                  : `Esto elimina permanentemente "${deleteTargetDisplay?.name}" y todos sus datos guardados.`}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* Qué capturas hay en juego, para no borrar a ciegas. */}
          {capturasDelObjetivo.length > 1 && (
            <ul className="space-y-1 rounded-lg border border-border/60 bg-muted/30 p-2">
              {capturasDelObjetivo.map((a) => {
                const esLaSeleccionada = a.id === deleteTargetDisplay?.recordId;
                return (
                  <li key={a.id} className="flex items-center gap-2 text-xs">
                    <span
                      className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                        esLaSeleccionada ? "bg-primary" : "bg-muted-foreground/40"
                      }`}
                    />
                    <span
                      className={`min-w-0 flex-1 truncate ${
                        esLaSeleccionada ? "font-semibold text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {a.name}
                    </span>
                    <span className="flex-shrink-0 text-[0.6875rem] text-muted-foreground">
                      {a.historical ? "historial" : "vigente"}
                    </span>
                    <span className="mono flex-shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground">
                      {zoneTotals(a).volumeM3} m³
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>Cancelar</AlertDialogCancel>
            {capturasDelObjetivo.length > 1 ? (
              <>
                <AlertDialogAction onClick={() => confirmDelete("captura")}>
                  Solo esta captura
                </AlertDialogAction>
                <AlertDialogAction onClick={() => confirmDelete("zona")}>
                  Toda la zona ({capturasDelObjetivo.length})
                </AlertDialogAction>
              </>
            ) : (
              <AlertDialogAction onClick={() => confirmDelete("captura")}>Eliminar</AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Kpi({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex flex-1 items-center gap-3 px-5 py-4">
      <span className="text-foreground/70 flex-shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-[0.625rem] text-muted-foreground leading-none mb-1.5">{label}</p>
        <p className="mono text-xl font-bold tabular-nums leading-none md:text-2xl">{value}</p>
      </div>
    </div>
  );
}


type SortField = "fecha" | "volumen" | "peso" | "area";

