// =============================================================================
// CONDORFINDER — VISTA PRINCIPAL
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

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { notify } from "@/lib/notify";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  ArrowRightCircle,
  Boxes,
  ChartLineUp,
  Crosshair,
  Eye,
  FolderOpen,
  Layers,
  Loader2,
  MapPin,
  Plus,
  Scale,
  Search,
  Trash2,
} from "@/components/icons/Icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ResourcesSummaryPanel } from "@/components/ResourcesSummaryPanel";
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
  deleteAnalysis,
  setPendingOpenId,
  type SavedAnalysisRecord,
  type AnalysisSummary,
} from "@/lib/analysisStore";
import { listResourcePoints, type ResourcePoint } from "@/lib/resources";
import {
  listPendingTasks,
  getTaskStatus,
  cancelTask,
  deleteAllImages,
  deleteResultFile,
  deleteFinalsFile,
  listTaskImages,
  getTaskImageUrl,
  deleteTaskImages,
  deleteTask,
  type PendingTask,
} from "@/lib/unify";
import {
  clearImageState,
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
import { clearMapUrl, saveMapUrl } from "@/lib/mapState";
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
      { title: "CondorFinder — Zonas monitoreadas" },
      {
        name: "description",
        content: "Panorama de las zonas con basurales detectados y analizados por CondorFinder.",
      },
    ],
  }),
  component: MainPage,
});

// ── modelo de fila combinado (guardadas + trackeadas) ──────────────────────

type ZoneState = "done" | "in_progress" | "pending_analysis";

interface ZoneRow {
  state: ZoneState;
  key: string;
  name: string;
  savedAt: string;
  mapUrl: string | null;
  /** Miniatura liviana para la tarjeta — preferida sobre mapUrl (varios MB)
   *  cuando existe; ausente en análisis guardados antes de este campo. */
  thumbnailUrl?: string | null;
  summary: AnalysisSummary | null;
  recordId?: string;
  taskId?: string;
  backendStage?: string;
  resultUrl?: string;
  resultJsonUrl?: string;
  detectionCount?: number;
  /** HDU7/AC3 — true si este análisis quedó vinculado como versión anterior
   *  de uno más reciente (confirmado como la misma zona). Se oculta de los
   *  filtros normales, solo visible bajo el filtro "Historial". */
  historical?: boolean;
  /** HDU7/AC3 — nombre del análisis que lo reemplazó, resuelto cruzando
   *  contra las demás filas ya cargadas (ver loadZoneRows) — no hace falta
   *  pedirle nada extra al backend para esto. */
  supersededByName?: string;
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
 * (GET /tasks/pending, también Mongo) — reemplaza el registro local en
 * taskRegistry.ts. Ya no hay ningún estado del lado del navegador que
 * pueda desincronizarse: cualquier navegador/dispositivo ve exactamente
 * las mismas tareas, y una falla de red al consultar el backend solo
 * significa "reintentar en el próximo refresh", no "perder la referencia
 * para siempre" (esa era la clase de bug que causaba el reinicio de
 * uvicorn en el momento equivocado antes de esta migración).
 */
async function loadZoneRows(): Promise<ZoneRow[]> {
  // Ambas listas pueden fallar (sesión perdida, red caída) — se degradan en
  // silencio en vez de romper el resto del listado, mismo criterio que ya
  // usa este archivo para listResourcePoints() (.catch(() => {})).
  let doneRows: ZoneRow[] = [];
  try {
    const records = await listAnalyses();
    // HDU7/AC3 — resuelve supersededByName cruzando contra las demás filas
    // ya traídas en esta misma llamada, sin pedirle nada extra al backend.
    const nameById = new Map(records.map((r) => [r.id, r.name]));
    doneRows = records.map((r) => ({
      ...fromRecord(r),
      supersededByName: r.supersededBy ? nameById.get(r.supersededBy) : undefined,
    }));
  } catch {
    // ver comentario de arriba
  }

  let pending: PendingTask[] = [];
  try {
    pending = await listPendingTasks();
  } catch {
    // ver comentario de arriba
  }

  const trackedRows: ZoneRow[] = [];
  for (const t of pending) {
    // El backend la incluye para que se pueda descubrir y limpiar acá —
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
        // completo terminó, solo falta guardarlo/analizarlo) — antes se
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

  // En progreso y pendientes de análisis van primero (necesitan atención).
  return [...inProgress, ...pendingAnalysis, ...doneSorted];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Normaliza para comparar sin distinguir tildes/diacríticos — "a" debe
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
  const [addZoneOpen, setAddZoneOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ZoneRow | null>(null);
  // Retiene el último target no-nulo — deleteTarget se pone en null para
  // CERRAR el diálogo (dispara la animación de salida), pero si el texto de
  // la descripción también pasa a depender de null en ese instante, se ve
  // un flash con el mensaje genérico durante los ~200ms de la animación.
  // Este ref/estado mantiene el texto correcto mientras se cierra.
  const [deleteTargetDisplay, setDeleteTargetDisplay] = useState<ZoneRow | null>(null);
  useEffect(() => {
    if (deleteTarget) setDeleteTargetDisplay(deleteTarget);
  }, [deleteTarget]);

  // Filtro por estado — 4 botones al nivel de "Agregar zona" (Todas incluida).
  // "historical" (HDU7/AC3) es un quinto filtro aparte, no un ZoneState más
  // — ver filteredZones más abajo: los otros 4 SIEMPRE excluyen históricos,
  // "historical" muestra SOLO históricos.
  const [stateFilter, setStateFilter] = useState<"all" | ZoneState | "historical">("all");
  // Búsqueda por nombre de zona — se combina con el filtro de estado.
  const [nameQuery, setNameQuery] = useState("");

  // Orden estilo Excel: click en el encabezado de columna.
  // Solo aplica a las zonas terminadas — en progreso/pendientes siempre van primero.
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

  // Panel "Recursos disponibles" (HDU6) — totales reales sobre los puntos
  // de origen guardados, no los placeholders fijos que había antes.
  const [resourcePoints, setResourcePoints] = useState<ResourcePoint[]>([]);
  useEffect(() => {
    listResourcePoints()
      .then(setResourcePoints)
      .catch(() => {});
  }, []);
  // Auto-refresh: mientras haya alguna zona "en progreso", vuelve a consultar
  // su estado cada 5s (mismo intervalo que usa el polling en vivo de
  // carga.tsx) para que pase sola a "pendiente de análisis" sin necesitar F5.
  useEffect(() => {
    if (!zones.some((z) => z.state === "in_progress")) return;
    const interval = setInterval(() => { refreshZones(); }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones]);

  // AC3 — vuelve a resolver el listado de zonas y lo muestra.
  const handleOpenAnalyses = () => {
    refreshZones(true);
  };

  // AC4 — abre una zona terminada en /analysis
  const openZone = (recordId: string) => {
    setPendingOpenId(recordId);
    navigate({ to: "/analysis" });
  };

  // Retoma una generación en curso — vuelve a donde se presionó
  // "Generar mapa unificado" originalmente.
  //
  // clearImageState() primero es clave: si no se limpia, cualquier resto de
  // OTRA tarea (items, resultUrl, detectionJsonUrl) que haya quedado en
  // sessionStorage podía mezclarse con la tarea que se está por retomar —
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
  // row.resultJsonUrl") — si por lo que sea esa fila no traía su propio
  // resultJsonUrl, la línea simplemente se saltaba y dejaba en
  // sessionStorage lo que hubiera quedado de la ÚLTIMA zona vista/generada
  // antes. Como saveMapUrl() sí es incondicional, el resultado era: mapUrl
  // se actualiza a la zona correcta, pero detectionJsonUrl queda pegado al
  // de otra zona — imagen bien, detecciones cruzadas. Ahora ambos casos son
  // explícitos: si hay URL se guarda, si no se limpia, nunca queda un valor
  // viejo sin tocar.
  //
  // row viene del último refreshZones() cacheado en el estado — puede estar
  // obsoleto: el auto-refresh automático (más abajo) solo corre mientras
  // haya alguna zona "en progreso", así que si el .json del backend todavía
  // no era visible en disco justo en el poll que hizo pasar esta zona a
  // "pendiente" (pasa con la carpeta del proyecto sincronizada por
  // OneDrive/WSL — el archivo puede existir un instante antes de que
  // os.path.exists() lo vea), esa fila queda pegada sin result_json_url
  // para siempre, sin otro refresh que la corrija. Por eso se re-consulta
  // /status fresco acá mismo antes de navegar, en vez de confiar ciegamente
  // en row — así "Ir a Análisis" nunca arrastra un dato incompleto viejo.
  const reviewPending = async (row: ZoneRow) => {
    if (!row.taskId) return;
    const fresh = await getTaskStatus(row.taskId);
    const resultUrl = fresh?.result_url ?? row.resultUrl;
    if (!resultUrl) return;
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

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    if (deleteTarget.state === "done" && deleteTarget.recordId) {
      await deleteAnalysis(deleteTarget.recordId);

      // Borra también los archivos en el servidor (imagen + json) — si no,
      // quedan huérfanos ocupando espacio aunque la zona ya no aparezca.
      const filename = deleteTarget.mapUrl?.split("/").pop();
      if (filename) {
        deleteResultFile(filename);
        const jsonName = filename.replace(/\.png$/i, ".json");
        if (jsonName !== filename) deleteResultFile(jsonName);
        // El .tif del ortomosaico vive en joining/finals/, no en
        // detecting/output/ — sin este borrado quedaba huérfano ahí para
        // siempre (varios MB por zona) aunque el resto se limpiara bien.
        const tifName = filename.replace(/\.png$/i, ".tif");
        if (tifName !== filename) deleteFinalsFile(tifName);
      }
      // También el snapshot de imágenes originales de la tarea, y el
      // documento de la tarea en sí (colección `tasks`) — si se guardó con
      // una versión que ya trackeaba sourceTaskId. Sin borrar el documento,
      // quedaba huérfano en Mongo para siempre (ya no se pierde solo con
      // reiniciar uvicorn, a diferencia de cuando `tasks` vivía en memoria).
      if (deleteTarget.taskId) {
        deleteTaskImages(deleteTarget.taskId);
        deleteTask(deleteTarget.taskId);
      }
    } else if (deleteTarget.taskId) {
      // "En progreso" también cancela el proceso en el backend, no solo
      // deja de trackearlo — si no, seguiría corriendo invisible.
      if (deleteTarget.state === "in_progress") {
        await cancelTask(deleteTarget.taskId);
      }
      deleteTaskImages(deleteTarget.taskId);
      deleteTask(deleteTarget.taskId);

      // "Pendiente de revisión": el mapa y el JSON de detecciones ya se
      // generaron en el servidor (detecting/output/) aunque nunca se hayan
      // guardado como análisis — sin este cleanup quedaban huérfanos ahí
      // para siempre, ya que nunca llegaron a tener un registro guardado
      // desde el cual borrarlos. Para "en progreso" estos campos son
      // undefined (el mapa todavía no existe), así que no hace nada.
      if (deleteTarget.resultUrl) {
        const filename = deleteTarget.resultUrl.split("/").pop();
        if (filename) {
          deleteResultFile(filename);
          const tifName = filename.replace(/\.png$/i, ".tif");
          if (tifName !== filename) deleteFinalsFile(tifName);
        }
      }
      if (deleteTarget.resultJsonUrl) {
        const jsonName = deleteTarget.resultJsonUrl.split("/").pop();
        if (jsonName) deleteResultFile(jsonName);
      }
    }
    setDeleteTarget(null);
    refreshZones();
  };

  // "Zona nueva" debe partir en blanco — limpia cualquier resto de una
  // sesión de carga anterior (imágenes subidas, mapa generado, progreso)
  // antes de entrar a /carga, para que no se vea la generación previa.
  const goToCarga = () => {
    clearImageState();
    clearMapUrl();
    deleteAllImages().catch(() => {});
    setAddZoneOpen(false);
    navigate({ to: "/carga" });
  };

  const inProgressCount = useMemo(
    () => zones.filter((z) => z.state === "in_progress").length,
    [zones],
  );

  const totals = useMemo(() => {
    // HDU7/AC3 — un análisis histórico (reemplazado por uno más reciente
    // confirmado como la misma zona) no debe sumar acá — es justo el doble
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
    // HDU7/AC3 — "historical" es el único filtro que muestra análisis
    // reemplazados; los otros 4 (incluido "all") los excluyen siempre, así
    // el listado principal nunca muestra una zona junto a la versión que
    // ya la reemplazó.
    const byState =
      stateFilter === "historical"
        ? zones.filter((r) => r.historical === true)
        : (stateFilter === "all" ? zones : zones.filter((r) => r.state === stateFilter)).filter(
            (r) => !r.historical,
          );
    const query = normalize(nameQuery.trim());
    const filtered = query === "" ? byState : byState.filter((r) => normalize(r.name).includes(query));

    const pinned = filtered.filter((r) => r.state !== "done");
    const doneOnly = [...filtered.filter((r) => r.state === "done")];

    doneOnly.sort((a, b) => {
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
      return sortDir === "asc" ? av - bv : bv - av;
    });

    return [...pinned, ...doneOnly];
  }, [zones, stateFilter, nameQuery, sortBy, sortDir]);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Encabezado de página */}
      <div className="border-b border-border/25 px-6 py-5">
        <h2 className="font-rubik text-3xl font-semibold tracking-normal text-foreground md:text-4xl">
          Zonas monitoreadas
        </h2>
      </div>

      <main className="flex flex-1">

        {/* ── Sidebar de HDU6 (recursos disponibles) ── */}
        <aside className="flex w-[400px] flex-shrink-0 flex-col border-r border-border/25 p-6 animate-in fade-in slide-in-from-left-2 duration-500">
          <ResourcesSummaryPanel points={resourcePoints} />

          <Link to="/recursos" className="pt-5">
            <Button size="lg" className="btn-cta w-full">
              <MapPin className="mr-2 h-4 w-4" /> Definir punto
            </Button>
          </Link>
        </aside>

        {/* ── Contenido: KPIs + listado de zonas ── */}
        <section className="flex min-w-0 flex-1 flex-col p-6">

          {/* KPIs generales — el primer dato que la Municipalidad necesita leer al
              entrar, por eso usa el mismo tratamiento .panel que el resto del
              sistema en vez de quedar como una tira plana. */}
          <div className="panel mb-6 flex flex-wrap items-center divide-x divide-border/10 px-1 animate-in fade-in slide-in-from-top-2 duration-500">
            <Kpi
              icon={<ChartLineUp className="h-4 w-4" />}
              label="Zonas registradas"
              // HDU7/AC3 — mismo criterio que "totals" más abajo: un análisis
              // histórico (reemplazado) ya no cuenta como zona vigente.
              value={String(zones.filter((z) => !z.historical).length)}
            />
            <Kpi icon={<Boxes className="h-4 w-4" />} label="Volumen total" value={`${round(totals.volume)} m³`} />
            <Kpi icon={<Scale className="h-4 w-4" />} label="Peso total" value={`${Math.round(totals.weight)} kg`} />
            <Kpi icon={<Crosshair className="h-4 w-4" />} label="Área total" value={`${round(totals.area)} m²`} />
            {inProgressCount > 0 && (
              <div className="flex flex-shrink-0 items-center gap-2 px-5 py-3.5">
                <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-primary" />
                <span className="text-[11px] font-medium uppercase tracking-wide text-primary/80">
                  {inProgressCount} en vivo
                </span>
              </div>
            )}
          </div>

          {/* Tarjeta que contiene filtros + tabla — mismo tratamiento .bg-card
              que el resto del sistema, sin duplicar el shadow pesado de
              .panel (ya lo lleva la franja de KPIs arriba). */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card animate-in fade-in slide-in-from-top-2 duration-500 delay-100 fill-mode-both">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
            <div className="flex items-center gap-2.5 border-l-2 border-primary/50 pl-3">
              <Layers className="h-3.5 w-3.5 text-primary/75" />
              <h3 className="text-sm font-semibold tracking-tight text-foreground">Listado de zonas</h3>
            </div>

            {/* Búsqueda por nombre de zona — centrada entre el título y los filtros */}
            <div className="flex min-w-[240px] flex-1 justify-center">
              <div className="relative w-full max-w-md">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={nameQuery}
                  onChange={(e) => setNameQuery(e.target.value)}
                  placeholder="Buscar zona por nombre..."
                  className="h-9 w-full pl-9 text-sm"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* Filtro por estado — 5 botones, uno activo a la vez.
                  "Historial" (HDU7/AC3) es el único que muestra análisis
                  reemplazados; los otros 4 los excluyen siempre. */}
              <div className="flex items-center gap-1 rounded-full border border-border p-1">
                <FilterChip active={stateFilter === "all"} onClick={() => setStateFilter("all")}>Todas</FilterChip>
                <FilterChip active={stateFilter === "done"} onClick={() => setStateFilter("done")}>Terminadas</FilterChip>
                <FilterChip active={stateFilter === "in_progress"} onClick={() => setStateFilter("in_progress")}>En progreso</FilterChip>
                <FilterChip active={stateFilter === "pending_analysis"} onClick={() => setStateFilter("pending_analysis")}>Pendientes</FilterChip>
                <FilterChip active={stateFilter === "historical"} onClick={() => setStateFilter("historical")}>Historial</FilterChip>
              </div>
              <Button size="sm" onClick={() => setAddZoneOpen(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" /> Agregar zona
              </Button>
              <Button size="sm" variant="secondary" onClick={handleOpenAnalyses}>
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" /> Abrir análisis
              </Button>
            </div>
          </div>

          {loading ? (
            <div className="flex-1 overflow-y-auto px-5 pb-5" role="status" aria-live="polite">
              <span className="sr-only">Cargando zonas...</span>
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableHead className="w-[120px]"></TableHead>
                    <TableHead>Zona</TableHead>
                    <TableHead>Fecha</TableHead>
                    <TableHead className="text-right">Volumen</TableHead>
                    <TableHead className="text-right">Peso</TableHead>
                    <TableHead className="text-right">Área</TableHead>
                    <TableHead className="text-right"></TableHead>
                    <TableHead className="w-[44px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[0, 1, 2].map((i) => (
                    <TableRow key={i} className="hover:bg-transparent">
                      <TableCell><Skeleton className="h-16 w-24" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                      <TableCell className="text-right"><Skeleton className="ml-auto h-4 w-14" /></TableCell>
                      <TableCell className="text-right"><Skeleton className="ml-auto h-4 w-14" /></TableCell>
                      <TableCell className="text-right"><Skeleton className="ml-auto h-4 w-14" /></TableCell>
                      <TableCell className="text-right"><Skeleton className="ml-auto h-8 w-24" /></TableCell>
                      <TableCell><Skeleton className="h-8 w-8" /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : visibleRows.length > 0 ? (
            <div className="flex-1 overflow-y-auto px-5 pb-5 animate-in fade-in duration-300">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableHead className="w-[120px]"></TableHead>
                    <TableHead>Zona</TableHead>
                    <SortableHead field="fecha" label="Fecha" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                    <SortableHead field="volumen" label="Volumen" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="right" />
                    <SortableHead field="peso" label="Peso" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="right" />
                    <SortableHead field="area" label="Área" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="right" />
                    <TableHead className="text-right"></TableHead>
                    <TableHead className="w-[44px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRows.map((z) => (
                    <TableRow
                      key={z.key}
                      className="animate-in fade-in slide-in-from-top-1 duration-300 fill-mode-both hover:bg-card/60"
                    >
                      <TableCell>
                        {z.mapUrl ? (
                          <div className="h-16 w-24 overflow-hidden rounded-md bg-muted">
                            <img
                              src={z.thumbnailUrl ?? z.mapUrl}
                              alt={`Mapa de ${z.name}`}
                              className="h-full w-full object-cover"
                            />
                          </div>
                        ) : z.state === "in_progress" ? (
                          // Proceso activo en el backend — el barrido de .scan-line
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
                        {z.name}
                        {z.state !== "done" && (
                          <span
                            className={`ml-2 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                              z.state === "in_progress"
                                ? "bg-primary/15 text-primary"
                                : "bg-warning/15 text-warning"
                            }`}
                          >
                            {z.state === "in_progress" ? "En progreso" : "Pendiente"}
                          </span>
                        )}
                        {z.historical && (
                          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Histórico
                          </span>
                        )}
                        {/* HDU7/AC3 — solo tiene sentido bajo el filtro "Historial", los
                            demás filtros ya excluyen las filas históricas. */}
                        {z.historical && z.supersededByName && (
                          <p className="mt-0.5 text-[10px] font-normal text-muted-foreground">
                            Reemplazado por: {z.supersededByName}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(z.savedAt).toLocaleDateString("es-CL")}
                      </TableCell>
                      <TableCell className="text-right mono">
                        {z.summary ? `${z.summary.totalVolumeM3} m³` : "—"}
                      </TableCell>
                      <TableCell className="text-right mono">
                        {z.summary ? `${z.summary.totalWeightKg} kg` : "—"}
                      </TableCell>
                      <TableCell className="text-right mono">
                        {z.summary ? `${z.summary.totalAreaM2} m²` : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {z.state === "done" && (
                          <Button size="sm" onClick={() => openZone(z.recordId!)}>
                            <Eye className="mr-1.5 h-3.5 w-3.5" /> Ver Análisis
                          </Button>
                        )}
                        {z.state === "in_progress" && (
                          <Button size="sm" variant="secondary" onClick={() => resumeInCarga(z)}>
                            <ArrowRightCircle className="mr-1.5 h-3.5 w-3.5" /> Ir a Carga
                          </Button>
                        )}
                        {z.state === "pending_analysis" && (
                          <Button size="sm" variant="secondary" onClick={() => reviewPending(z)}>
                            <ArrowRightCircle className="mr-1.5 h-3.5 w-3.5" /> Ir a Análisis
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                          onClick={() => setDeleteTarget(z)}
                          title="Eliminar zona"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
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
                  ? 'Presiona "Agregar zona" para analizar tu primer basural.'
                  : "Ajusta el filtro para ver más resultados."}
              </p>
            </div>
          )}
          </div>
        </section>
      </main>

      {/* Popup de "Agregar zona": nueva zona vs. modificar una existente */}
      <Dialog open={addZoneOpen} onOpenChange={setAddZoneOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Agregar zona</DialogTitle>
            <DialogDescription>
              ¿Quieres analizar una zona nueva o modificar una zona ya generada?
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={goToCarga}
              className="group flex cursor-pointer flex-col items-center gap-3 rounded-xl border border-border bg-card p-6 text-center transition-[transform,box-shadow,border-color,background-color] duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:bg-primary/5 hover:shadow-md"
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
                <Plus className="h-7 w-7" />
              </span>
              <span className="text-sm font-semibold text-foreground">Zona nueva</span>
              <span className="text-xs text-muted-foreground">
                Carga imágenes y genera un mapa unificado desde cero.
              </span>
            </button>

            <div
              title="Próximamente"
              className="flex cursor-not-allowed flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center opacity-60"
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <ChartLineUp className="h-7 w-7" />
              </span>
              <span className="text-sm font-semibold text-foreground">Modificar zona existente</span>
              <span className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-warning/15 text-warning">
                Próximamente
              </span>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmación de eliminar zona */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar zona</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTargetDisplay?.state === "done"
                ? `Esto elimina permanentemente "${deleteTargetDisplay?.name}" y todos sus datos guardados.`
                : deleteTargetDisplay?.state === "in_progress"
                ? "Esto cancela la generación en curso en el servidor y deja de mostrarla en tu listado."
                : "Esto deja de mostrar este análisis pendiente en tu listado. El mapa generado sigue en el servidor, pero ya no se te va a ofrecer para revisarlo."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Eliminar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Kpi({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex flex-1 items-center gap-3 px-5 py-4">
      <span className="text-primary/60 flex-shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] text-muted-foreground leading-none mb-1.5">{label}</p>
        <p className="mono text-xl font-bold tabular-nums leading-none md:text-2xl">{value}</p>
      </div>
    </div>
  );
}

/** Botón del grupo de filtro por estado ("Todas | Terminadas | En progreso | Pendientes"). */
function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

type SortField = "fecha" | "volumen" | "peso" | "area";

/** Encabezado de columna clickeable para ordenar (estilo Excel), con flecha
 *  indicando el campo y dirección de orden activos. */
function SortableHead({
  field,
  label,
  sortBy,
  sortDir,
  onSort,
  align,
}: {
  field: SortField;
  label: string;
  sortBy: SortField;
  sortDir: "asc" | "desc";
  onSort: (field: SortField) => void;
  align?: "right";
}) {
  const active = sortBy === field;
  return (
    <TableHead
      className={`cursor-pointer select-none hover:text-foreground ${align === "right" ? "text-right" : ""}`}
      onClick={() => onSort(field)}
    >
      <span className={`inline-flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}>
        {label}
        {active && (sortDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
      </span>
    </TableHead>
  );
}
