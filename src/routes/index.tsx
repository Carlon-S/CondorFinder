// =============================================================================
// CONDORFINDER — PÁGINA PRINCIPAL (HDU1: Unificación de imágenes)
// Archivo: src/routes/index.tsx
//
// Componente principal del sistema. Implementa el frontend completo de la
// Historia de Usuario HDU1: permite al trabajador municipal cargar imágenes
// JPG capturadas con drone, validarlas y generar un mapa unificado de la zona.
//
// Criterios de aceptación cubiertos (frontend):
//   1. Verificación de formato JPG al cargar archivos
//   2. Validación de cantidad mínima (16 imágenes) y solapamiento (≥ 60%)
//   3. Generación y visualización del mapa unificado
//
// Nota: El procesamiento real (algoritmo de unificación, cálculo de solapamiento)
// es responsabilidad del backend. Actualmente se utiliza una respuesta simulada
// definida en src/lib/unify.ts.
// =============================================================================

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Upload,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Map as MapIcon,
  Download,
  RotateCcw,
  Trash2,
  Loader2,
  FileWarning,
  Sun,
  Moon,
  Layers,
  Info,
  ListChecks,
  ImageIcon,
  Clock,
  FileCheck,
  Percent,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { unifyImages } from "@/lib/unify";
import unifiedMapPreview from "@/assets/unified-map-preview.webp";
import unifiedMapTechnicalDownload from "@/assets/unified-map-simulation.png";

// Registro de la ruta raíz "/" en TanStack Router.
// "head" define los metadatos HTML de la página (título, descripción, OG tags).
export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "CondorFinder — Unificación de imágenes" },
      {
        name: "description",
        content:
          "Dashboard GIS municipal para unificar imágenes aéreas JPG capturadas con drone y generar un mapa unificado de la zona.",
      },
      { property: "og:title", content: "CondorFinder — Unificación de imágenes" },
      {
        property: "og:description",
        content:
          "Plataforma municipal para unificar imágenes aéreas de drones y planificar la gestión ambiental.",
      },
    ],
  }),
  component: Page,
});

// =============================================================================
// CONSTANTES DEL SISTEMA
// Centralizadas aquí para facilitar ajustes sin buscar valores hardcodeados.
// =============================================================================

/** Cantidad mínima de imágenes JPG requeridas para iniciar el procesamiento */
const MIN_IMAGES = 16;

/** Porcentaje mínimo de solapamiento entre imágenes para generar el mapa */
const MIN_OVERLAP = 60;


// =============================================================================
// TIPOS E INTERFACES
// =============================================================================

/** Estado de validación de cada imagen cargada por el usuario */
type ItemStatus = "valid" | "invalid";

/**
 * Representa un archivo de imagen en el sistema.
 * @property id      - Identificador único generado al cargar el archivo
 * @property file    - Objeto File original del sistema operativo (enviado al backend)
 * @property status  - "valid" si es JPG, "invalid" si no lo es
 * @property reason  - Razón del rechazo (solo presente si status === "invalid")
 * @property preview - URL del thumbnail generado para mostrar en la UI.
 *                     Inicialmente es un blob: URL, luego se reemplaza por
 *                     un data: URL (thumbnail optimizado vía canvas).
 */
interface FileItem {
  id: string;
  file: File;
  status: ItemStatus;
  reason?: string;
  preview: string;
}

/**
 * Fases del proceso de generación del mapa.
 * El sistema avanza secuencialmente por estas fases al presionar "Generar mapa".
 * - idle               → estado inicial, sin procesamiento activo
 * - validating_format  → verificando que los archivos sean JPG
 * - checking_count     → verificando que haya al menos MIN_IMAGES imágenes
 * - analyzing_overlap  → calculando solapamiento entre imágenes (backend)
 * - generating_map     → generando el mapa unificado (backend)
 * - done               → proceso completado exitosamente
 * - error              → proceso detenido por un error
 */
type Phase =
  | "idle"
  | "validating_format"
  | "checking_count"
  | "analyzing_overlap"
  | "generating_map"
  | "done"
  | "error";

/**
 * Estado de cada indicador en el panel de Revisión técnica.
 * - pending  → aún no evaluado
 * - ok       → condición cumplida
 * - warn     → condición parcialmente cumplida (ej: pocas imágenes)
 * - error    → condición fallida
 * - running  → evaluación en curso
 */
type TriState = "pending" | "ok" | "warn" | "error" | "running";


// =============================================================================
// FUNCIONES UTILITARIAS
// =============================================================================

/**
 * Determina si un archivo es una imagen JPG válida.
 * Valida tanto la extensión del nombre como el MIME type reportado por el SO.
 * Se aceptan MIME types vacíos para compatibilidad con sistemas operativos
 * que no asignan tipo automáticamente (en esos casos la extensión es suficiente).
 *
 * @param file - Objeto File a validar
 * @returns true si el archivo es JPG/JPEG válido
 */
function isJpg(file: File): boolean {
  const nameOk = /\.(jpe?g)$/i.test(file.name);
  const typeOk =
    file.type === "image/jpeg" ||
    file.type === "image/jpg" ||
    file.type === "image/pjpeg" ||
    file.type === "";
  return nameOk && typeOk;
}

/**
 * Formatea un tamaño en bytes a una representación legible (B, KB, MB).
 *
 * @param bytes - Tamaño en bytes
 * @returns String formateado, ej: "2.45 MB"
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}


// =============================================================================
// COMPONENTE PRINCIPAL
// =============================================================================

/**
 * Página principal de CondorFinder.
 * Gestiona todo el estado del sistema y renderiza el layout completo en 4 filas:
 *   Fila 1: Instrucciones de uso
 *   Fila 2: Carga de imágenes | Imágenes adjuntas
 *   Fila 3: Botón de generación + tooltip de estado
 *   Fila 4: Revisión técnica | Mapa unificado
 */
function Page() {

  // ---------------------------------------------------------------------------
  // ESTADO DEL COMPONENTE
  // ---------------------------------------------------------------------------

  /** Lista de archivos cargados por el usuario (válidos e inválidos) */
  const [items, setItems] = useState<FileItem[]>([]);

  /** Indica si el usuario está arrastrando archivos sobre la zona de drop */
  const [dragOver, setDragOver] = useState(false);

  /** Fase actual del proceso de generación del mapa */
  const [phase, setPhase] = useState<Phase>("idle");

  /** Porcentaje de progreso del proceso (0-100) */
  const [progress, setProgress] = useState(0);

  /** Porcentaje de solapamiento calculado por el backend (null si aún no se calculó) */
  const [overlap, setOverlap] = useState<number | null>(null);

  /** URL del preview web del mapa generado (WEBP en simulacion, backend en produccion) */
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  /** URL de descarga tecnica del mapa generado (TIF/PNG segun backend; PNG en simulacion) */
  const [technicalDownloadUrl, setTechnicalDownloadUrl] = useState<string | null>(null);

  /** Formato de descarga tecnica mostrado al usuario */
  const [technicalDownloadFormat, setTechnicalDownloadFormat] = useState<"TIF" | "PNG" | "WEBP">("PNG");

  /** Mensaje de error detallado para mostrar al usuario cuando el proceso falla */
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  /**
   * Activa la simulación de error de solapamiento insuficiente (42%).
   * Solo para desarrollo/testing. Debe eliminarse en producción.
   */
  const [simulateLow, setSimulateLow] = useState(false);

  /** Referencia al input de tipo file (oculto), activado por el botón de carga */
  const inputRef = useRef<HTMLInputElement>(null);

  // ---------------------------------------------------------------------------
  // LIMPIEZA DE MEMORIA AL DESMONTAR
  // Libera todos los blob: URLs activos para evitar memory leaks.
  // Los data: URLs (thumbnails) se liberan automáticamente con el estado de React.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      items.forEach((i) => URL.revokeObjectURL(i.preview));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // VALORES DERIVADOS DEL ESTADO
  // ---------------------------------------------------------------------------

  /** Cantidad de archivos JPG válidos */
  const validCount = items.filter((i) => i.status === "valid").length;

  /** Cantidad de archivos rechazados (no JPG) */
  const invalidCount = items.filter((i) => i.status === "invalid").length;

  /** true si hay al menos un archivo rechazado */
  const hasInvalid = invalidCount > 0;

  /** true si hay al menos MIN_IMAGES archivos JPG válidos */
  const enoughImages = validCount >= MIN_IMAGES;

  /** true si el sistema está ejecutando alguna fase del proceso */
  const processing = phase !== "idle" && phase !== "done" && phase !== "error";

  /**
   * true si el botón "Generar mapa" debe estar habilitado.
   * Requiere: al menos un archivo, ninguno inválido, cantidad suficiente y no procesando.
   */
  const canGenerate = items.length > 0 && !hasInvalid && enoughImages && !processing;

  // ---------------------------------------------------------------------------
  // ESTADOS DE LA REVISIÓN TÉCNICA
  // ---------------------------------------------------------------------------

  /** Estado del check "Formato JPG" */
  const formatState: TriState = hasInvalid ? "error" : items.length > 0 ? "ok" : "pending";

  /** Estado del check "Cantidad mínima" */
  const countState: TriState = items.length === 0 ? "pending" : enoughImages ? "ok" : "warn";

  /** Estado del check "Solapamiento >= 60%" */
  const overlapState: TriState =
    phase === "analyzing_overlap"
      ? "running"
      : overlap == null
        ? "pending"
        : overlap >= MIN_OVERLAP
          ? "ok"
          : "error";

  /** Estado del check "Generación de mapa" */
  const mapState: TriState =
    phase === "generating_map"
      ? "running"
      : phase === "done"
        ? "ok"
        : phase === "error"
          ? "error"
          : "pending";

  // ---------------------------------------------------------------------------
  // MANEJO DE ARCHIVOS
  // ---------------------------------------------------------------------------

  /**
   * Agrega archivos al sistema con estrategia de dos pasos para optimizar rendimiento:
   *
   * Paso 1 (inmediato): Agrega la imagen con su blob: URL original para que
   *   aparezca instantáneamente en la UI.
   *
   * Paso 2 (segundo plano): Genera thumbnail redimensionado (max 300px) via Canvas
   *   y reemplaza el blob: URL por data: URL comprimido (~15-30KB vs ~20MB originales).
   *   Esto hace el scroll vertical fluido con muchas imágenes.
   *
   * El objeto File original se conserva para enviarlo al backend.
   */
  const addFiles = useCallback((files: FileList | File[]) => {
    Array.from(files).forEach((file) => {
      const ok = isJpg(file);
      const id = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`;
      const blobUrl = URL.createObjectURL(file);

      // Paso 1: mostrar inmediatamente con blob URL
      setItems((prev) => [
        ...prev,
        {
          id,
          file,
          status: ok ? "valid" : "invalid",
          reason: ok ? undefined : "Solo se aceptan archivos JPG o JPEG.",
          preview: blobUrl,
        },
      ]);

      if (!ok) return;

      // Paso 2: generar thumbnail optimizado en segundo plano
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const MAX = 300;
        const ratio = Math.min(MAX / img.width, MAX / img.height);
        canvas.width = img.width * ratio;
        canvas.height = img.height * ratio;
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
        const thumbnail = canvas.toDataURL("image/jpeg", 0.7);
        URL.revokeObjectURL(blobUrl);
        setItems((prev) =>
          prev.map((item) => item.id === id ? { ...item, preview: thumbnail } : item)
        );
      };
      img.src = blobUrl;
    });
  }, []);

  /** Elimina un archivo individual y libera su memoria */
  const removeItem = (id: string) => {
    setItems((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target) URL.revokeObjectURL(target.preview);
      return prev.filter((i) => i.id !== id);
    });
  };

  /** Reinicia el proceso sin borrar las imágenes cargadas */
  const resetProcess = () => {
    setPhase("idle");
    setProgress(0);
    setOverlap(null);
    setResultUrl(null);
    setTechnicalDownloadUrl(null);
    setTechnicalDownloadFormat("PNG");
    setErrorMsg(null);
  };

  /** Elimina todas las imágenes y reinicia el proceso */
  const clearAll = () => {
    items.forEach((i) => URL.revokeObjectURL(i.preview));
    setItems([]);
    resetProcess();
  };

  /** Elimina solo los archivos rechazados, conservando los JPG válidos */
  const clearInvalid = () => {
    items.filter((i) => i.status === "invalid").forEach((i) => URL.revokeObjectURL(i.preview));
    setItems((prev) => prev.filter((i) => i.status === "valid"));
  };

  /** Maneja el evento drop de drag & drop */
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  };

  // ---------------------------------------------------------------------------
  // PROCESO DE GENERACIÓN DEL MAPA
  // ---------------------------------------------------------------------------

  /**
   * Ejecuta el proceso secuencial de generación del mapa.
   * Las fases de formato y cantidad son validadas en el frontend.
   * Las fases de solapamiento y generación dependen del backend (unify.ts).
   */
  const generate = async () => {
    if (!canGenerate) return;
    resetProcess();
    const validFiles = items.filter((i) => i.status === "valid").map((i) => i.file);

    setPhase("validating_format"); setProgress(10); await sleep(400);
    setPhase("checking_count"); setProgress(25); await sleep(400);
    setPhase("analyzing_overlap"); setProgress(55); await sleep(1400);

    try {
      const res = await unifyImages(validFiles, { forceLowOverlap: simulateLow });
      if (res.status === "error") {
        setOverlap(res.overlap ?? 0);
        setPhase("error");
        setProgress(100);
        if (res.reason === "overlap_too_low") {
          setErrorMsg(
            `Las imagenes no se solapan lo suficiente entre si (${res.overlap}% de superposicion, minimo requerido: 60%). ` +
            "Esto significa que hay zonas del terreno sin cobertura entre una foto y la siguiente. " +
            "Para solucionarlo, sube mas imagenes de la misma zona asegurandote de que cada foto comparta al menos un 60% de area con las fotos adyacentes.",
          );
        } else {
          setErrorMsg(res.message || "No se pudo generar el mapa. Intenta nuevamente.");
        }
        return;
      }
      setOverlap(res.overlap);
      setPhase("generating_map"); setProgress(85); await sleep(900);
      setResultUrl(res.mapUrl || unifiedMapPreview);
      setTechnicalDownloadUrl(res.technicalDownloadUrl || unifiedMapTechnicalDownload);
      setTechnicalDownloadFormat(res.technicalDownloadFormat || "PNG");
      setProgress(100); setPhase("done");
    } catch {
      setPhase("error");
      setErrorMsg("No se pudo generar el mapa. Intenta nuevamente.");
    }
  };

  /** Etiquetas descriptivas para cada fase del proceso */
  const phaseLabel: Record<Phase, string> = {
    idle: "Listo para procesar",
    validating_format: "Validando formato JPG...",
    checking_count: "Revisando cantidad de imagenes...",
    analyzing_overlap: "Analizando superposicion entre imagenes...",
    generating_map: "Generando mapa unificado...",
    done: "Mapa generado exitosamente",
    error: "Proceso detenido por error",
  };

  /**
   * Estado del tooltip del boton principal.
   * Determina color y mensaje segun la condicion actual del sistema.
   * Colores: empty (gris), warning (amarillo), destructive (rojo), success (verde).
   */
  const tooltipState = useMemo(() => {
    if (phase === "error" && errorMsg) return { color: "destructive", message: errorMsg };
    if (items.length === 0) return { color: "empty", message: `No hay imagenes cargadas. Arrastra o selecciona al menos ${MIN_IMAGES} imagenes JPG.` };
    if (hasInvalid) return { color: "destructive", message: `Hay ${invalidCount} archivo(s) que no son JPG o JPEG. Eliminatlos para continuar.` };
    if (!enoughImages) return { color: "warning", message: `Se necesitan al menos ${MIN_IMAGES} imagenes JPG para iniciar el procesamiento. Tienes ${validCount}.` };
    return { color: "success", message: "Todas las condiciones cumplidas. Puedes generar el mapa unificado." };
  }, [items.length, hasInvalid, invalidCount, enoughImages, validCount, phase, errorMsg]);

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-background text-foreground gis-grid gis-radial">

      {/* HEADER: barra de navegacion fija con logotipo y enlaces de ancla */}
      <header className="sticky top-0 z-30 border-b border-white bg-[#151414] text-white shadow-lg">
        <div className="mx-auto flex h-20 max-w-[1400px] items-center justify-between px-6">
          <h1 className="text-3xl font-shrikhand tracking-tight text-white md:text-4xl">CondorFinder</h1>
          <nav className="ml-auto hidden items-center gap-8 text-sm font-medium md:flex">
            <a href="#carga" className="text-white transition-colors hover:text-white/80">Carga</a>
            <a href="#mapa" className="text-white transition-colors hover:text-white/80">Mapa</a>
            <a href="#revision" className="text-white transition-colors hover:text-white/80">Revision</a>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-6 py-6 space-y-4">
        <h2 className="font-Futura text-3xl tracking-tight text-foreground md:text-4xl">
          Unificacion de imagenes aereas
        </h2>

        {/* FILA 1: Instrucciones de uso en 4 pasos */}
        <section className="panel p-5">
          <PanelHeader icon={<Info className="h-3.5 w-3.5" />} title="Instrucciones" />
          <ol className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <GuideStep number="1" title="Selecciona la zona" text="Usa imagenes tomadas en un mismo sector para que el mapa final sea coherente y continuo." />
            <GuideStep number="2" title="Carga archivos JPG" text="Arrastra las fotografias o seleccionalas desde tu equipo. Solo se aceptan archivos en formato JPG o JPEG." />
            <GuideStep number="3" title="Verifica los requisitos" text={`Necesitas al menos ${MIN_IMAGES} imagenes JPG validas. Cada foto debe compartir al menos un 60% de area con las fotos vecinas (solapamiento).`} />
            <GuideStep number="4" title="Genera el mapa" text='Cuando todo este aprobado, presiona el boton para iniciar el procesamiento y obtener el mapa unificado de la zona.' />
          </ol>
        </section>

        {/* FILA 2: Carga de imagenes (izquierda) | Imagenes adjuntas (derecha) */}
        <div id="carga" className="grid gap-4 lg:grid-cols-[2fr_3fr]">

          {/* Panel izquierdo: zona drag & drop */}
          <section className="panel p-5 flex flex-col gap-4 min-h-[420px]">
            <PanelHeader icon={<Upload className="h-3.5 w-3.5" />} title="Carga de imagenes" />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`group relative flex w-full flex-col items-center justify-center rounded-md border border-dashed px-6 py-10 text-center transition-all h-[340px] overflow-hidden ${
                dragOver ? "border-primary bg-primary/10" : "border-border bg-background/40 hover:border-primary/60 hover:bg-primary/5"
              }`}
            >
              <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/30">
                <Upload className="h-7 w-7" />
              </div>
              <p className="mt-4 text-sm font-semibold">Arrastra imagenes JPG aqui</p>
              <p className="mt-1 text-xs text-muted-foreground">o haz clic para seleccionar desde tu equipo</p>
              <p className="mono mt-3 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Solo JPG · JPEG · Minimo {MIN_IMAGES} imagenes
              </p>
              <input ref={inputRef} type="file" accept="image/jpeg,.jpg,.jpeg" multiple className="hidden"
                onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
              />
            </button>
          </section>

          {/* Panel derecho: grid de thumbnails con scroll vertical */}
          <section className="panel p-5 flex flex-col gap-3 h-[420px]">
            <div className="flex items-center justify-between">
              <PanelHeader icon={<ImageIcon className="h-3.5 w-3.5" />} title="Imagenes adjuntas" />
              <div className="flex items-center gap-3">
                <p className="mono text-[10px] text-muted-foreground">{validCount} JPG · {invalidCount} rechazadas</p>
                {invalidCount > 0 && (
                  <Button variant="ghost" size="sm" onClick={clearInvalid} disabled={processing}
                    className="h-7 px-2 text-xs hover:bg-destructive/15 hover:text-destructive">
                    <Trash2 className="mr-1 h-3 w-3" /> Eliminar imagenes no JPG/JPEG
                  </Button>
                )}
                {items.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={clearAll} disabled={processing}
                    className="h-7 px-2 text-xs hover:bg-destructive/15 hover:text-destructive">
                    <Trash2 className="mr-1 h-3 w-3" /> Limpiar todas las imagenes
                  </Button>
                )}
              </div>
            </div>

            {/* Grid 3 columnas con scroll vertical optimizado para rendimiento */}
            {items.length > 0 ? (
              <ul className="flex flex-wrap items-start gap-2 h-[340px] overflow-y-auto overflow-x-hidden pb-1 pr-1 will-change-scroll" style={{ contain: "strict" }}>
                {items.map((it) => (
                  <li key={it.id}
                    className={`w-[calc(33.333%-6px)] flex-shrink-0 overflow-hidden rounded-md border bg-background/40 transform-gpu ${
                      it.status === "invalid" ? "border-destructive/40" : "border-border"
                    }`}
                  >
                    <div className="relative h-28 w-full overflow-hidden bg-muted">
                      <img src={it.preview} alt={it.file.name} className="h-full w-full object-cover" decoding="async" />
                      <button type="button" aria-label="Eliminar" onClick={() => removeItem(it.id)} disabled={processing}
                        className="absolute right-1.5 top-1.5 rounded bg-background/85 p-1 text-muted-foreground shadow-sm backdrop-blur transition hover:bg-destructive/15 hover:text-destructive">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="min-w-0 p-2">
                      <p className="truncate text-[10px] font-medium" title={it.file.name}>{it.file.name}</p>
                      <p className="mono text-[9px] text-muted-foreground leading-tight">{formatSize(it.file.size)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex h-[340px] items-center justify-center rounded-md border border-dashed border-border bg-background/30 text-center text-xs text-muted-foreground">
                Las imagenes seleccionadas apareceran aqui.
              </div>
            )}

            {/* Checkbox de simulacion de error (solo desarrollo) */}
            <div className="flex justify-end mt-auto">
              <label className="flex items-center gap-2 rounded border border-border bg-background/40 px-2 py-1.5 text-[11px] text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={simulateLow} onChange={(e) => setSimulateLow(e.target.checked)} disabled={processing} className="h-3 w-3 accent-[var(--primary)]" />
                Simular error de superposicion (42%)
              </label>
            </div>
          </section>
        </div>

        {/* FILA 3: Boton centrado + tooltip de estado */}
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-3">
            <Button onClick={generate} disabled={!canGenerate} className="w-full max-w-sm" size="lg">
              {processing ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generando...</>)
              : phase === "done" || phase === "error" ? (<><RotateCcw className="mr-2 h-4 w-4" /> Reprocesar mapa</>)
              : (<><MapIcon className="mr-2 h-4 w-4" /> Generar mapa unificado</>)}
            </Button>

            {/* Tooltip dinamico: varia color y mensaje segun estado del sistema */}
            <div className="group relative flex items-center">
              <div className={`flex h-7 w-7 items-center justify-center rounded-full cursor-help transition-colors ${
                tooltipState.color === "empty" ? "bg-[#1e1e1e] text-white hover:bg-[#1e1e1e]/90"
                : tooltipState.color === "warning" ? "bg-warning text-warning-foreground hover:bg-warning/90"
                : tooltipState.color === "destructive" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "bg-success text-black hover:bg-success/90"
              }`}>
                <AlertTriangle className="h-4 w-4" />
              </div>
              <div className={`absolute left-full top-1/2 ml-2 -translate-y-1/2 w-64 min-w-[200px] transition-all ${
                tooltipState.color === "warning" ? "opacity-100 scale-100 pointer-events-auto"
                : "scale-95 opacity-0 group-hover:scale-100 group-hover:opacity-100 pointer-events-none"
              } z-50`}>
                <div className={`relative rounded-md p-2.5 text-[11px] font-medium shadow-xl ${
                  tooltipState.color === "empty" ? "bg-[#1e1e1e] text-white"
                  : tooltipState.color === "warning" ? "bg-warning text-warning-foreground"
                  : tooltipState.color === "destructive" ? "bg-destructive text-destructive-foreground"
                  : "bg-success text-black"
                }`}>
                  <div className={`absolute right-full top-1/2 -mt-[6px] border-[6px] border-transparent ${
                    tooltipState.color === "empty" ? "border-r-[#1e1e1e]"
                    : tooltipState.color === "warning" ? "border-r-warning"
                    : tooltipState.color === "destructive" ? "border-r-destructive"
                    : "border-r-success"
                  }`} />
                  {tooltipState.message}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* FILA 4: Revision tecnica (izquierda) | Mapa unificado (derecha) */}
        <div id="revision" className="grid gap-4 lg:grid-cols-[1fr_2fr]">

          {/* Panel izquierdo: revision tecnica */}
          <section id="mapa" className="panel p-5 flex flex-col gap-4">
            <PanelHeader icon={<ListChecks className="h-3.5 w-3.5" />} title="Revision tecnica" />

            {/* Indicadores de estado de cada condicion requerida */}
            <div className="divide-y divide-border rounded-md border border-border bg-background/30">
              <CheckRow label="Formato JPG" state={formatState}
                hint={formatState === "error" ? `${invalidCount} archivo(s) rechazado(s): solo se aceptan imagenes en formato JPG o JPEG`
                  : formatState === "ok" ? "Todos los archivos son JPG y estan listos para procesar"
                  : "Sin archivos cargados aun"} />
              <CheckRow label="Cantidad minima" state={countState}
                hint={countState === "ok" ? `${validCount} imagenes JPG cargadas (minimo requerido: ${MIN_IMAGES})`
                  : countState === "warn" ? `Faltan ${MIN_IMAGES - validCount} imagen(es) para alcanzar el minimo de ${MIN_IMAGES}`
                  : `Se requieren al menos ${MIN_IMAGES} imagenes JPG validas`} />
              <CheckRow label="Solapamiento >= 60%" state={overlapState}
                hint={overlapState === "running" ? "Analizando el solapamiento entre imagenes..."
                  : overlap == null ? "Se verificara al generar el mapa"
                  : overlap >= MIN_OVERLAP ? `Las fotos se solapan correctamente (${overlap}%)`
                  : `Solapamiento insuficiente entre fotos (${overlap}% - minimo 60%)`} />
              <CheckRow label="Generacion de mapa" state={mapState}
                hint={mapState === "running" ? "Procesando y unificando imagenes..."
                  : mapState === "ok" ? "Mapa generado y disponible para descarga"
                  : mapState === "error" ? "El proceso fue interrumpido por un error"
                  : "Pendiente: completa los pasos anteriores"} />
            </div>

            {/* Resumen numerico de la carga actual */}
            <div className="rounded-md border border-border bg-background/30 p-3 space-y-3">
              <p className="mono text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Resumen de carga</p>
              <div className="grid grid-cols-2 gap-2">
                <InfoTile icon={<ImageIcon className="h-3.5 w-3.5" />} label="Total imagenes" value={String(items.length)} />
                <InfoTile icon={<FileCheck className="h-3.5 w-3.5" />} label="JPG cargadas" value={String(validCount)} tone={validCount >= MIN_IMAGES ? "ok" : undefined} />
                <InfoTile icon={<XCircle className="h-3.5 w-3.5" />} label="Con error" value={String(invalidCount)} tone={invalidCount > 0 ? "error" : undefined} />
                <InfoTile icon={<Percent className="h-3.5 w-3.5" />} label="Solapamiento" value={overlap == null ? "-" : `${overlap}%`}
                  tone={overlap == null ? undefined : overlap >= MIN_OVERLAP ? "ok" : "error"} />
              </div>
            </div>

            {/* Explicacion del solapamiento en lenguaje simple */}
            <div className="rounded-md border border-border bg-background/30 p-3 space-y-1.5">
              <p className="mono text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Que es el solapamiento?</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                El solapamiento es el porcentaje de area que comparten dos fotografias aereas consecutivas.
                Un solapamiento minimo del <span className="font-semibold text-foreground">60%</span> garantiza
                que el sistema pueda unir las imagenes sin dejar zonas sin cobertura en el mapa final.
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Si el solapamiento es insuficiente, sube mas fotografias de la misma zona, asegurandote
                de que cada foto capture parte del area ya fotografiada por las fotos vecinas.
              </p>
            </div>

            {/* Indicador de fase actual con barra de progreso */}
            <div className="rounded-md border border-border bg-background/30 p-3 space-y-1.5">
              <p className="mono text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Estado del proceso</p>
              <div className="flex items-center gap-2">
                <Clock className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                <p className="text-xs text-foreground font-medium">{phaseLabel[phase]}</p>
              </div>
              <Progress value={progress} className="h-1" />
              <p className="mono text-[10px] text-muted-foreground">{progress}% completado</p>
            </div>
          </section>

          {/* Panel derecho: visualizacion del mapa */}
          <section className="panel overflow-hidden flex flex-col">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold">Mapa unificado</span>
              </div>
            </div>

            {/* Visor del mapa con estados visuales. Usa object-contain para respetar la forma irregular de la ortofoto. */}
            <div className="relative h-[min(68vh,760px)] min-h-[420px] w-full overflow-hidden bg-[#1d1d1d]">
              <div className="absolute inset-0 opacity-60" style={{
                backgroundImage: "linear-gradient(var(--grid-color) 1px, transparent 1px), linear-gradient(90deg, var(--grid-color) 1px, transparent 1px)",
                backgroundSize: "32px 32px",
              }} />
              {phase === "done" && resultUrl ? (
                <Link
                  to="/analysis"
                  className="group relative block h-full w-full cursor-pointer"
                  title="Abrir analisis de volumen"
                >
                  <img
                    src={resultUrl}
                    alt="Mapa unificado generado a partir de las imagenes aereas"
                    className="relative h-full w-full object-contain p-3 transition duration-200 group-hover:brightness-110"
                  />
                  <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-md border border-border bg-card/90 px-3 py-2 text-xs font-medium text-foreground opacity-0 shadow-xl backdrop-blur transition group-hover:opacity-100">
                    Click para analizar volumen
                  </div>
                </Link>
              ) : processing ? (
                <div className="relative flex h-full w-full flex-col items-center justify-center gap-3">
                  <div className="scan-line relative h-24 w-24 overflow-hidden rounded-md border border-primary/40 bg-primary/10">
                    <Loader2 className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 animate-spin text-primary" />
                  </div>
                  <p className="mono text-[11px] uppercase tracking-wider text-primary">{phaseLabel[phase]}</p>
                  <div className="w-64"><Progress value={progress} className="h-1" /></div>
                </div>
              ) : phase === "error" ? (
                <div className="relative flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full border border-destructive/40 bg-destructive/15 mb-1">
                    <XCircle className="h-6 w-6 text-destructive" />
                  </div>
                  <div className="w-full max-w-md">
                    <p className="text-sm font-semibold text-foreground mb-1">Error en el procesamiento</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">{errorMsg}</p>
                  </div>
                </div>
              ) : (
                <div className="relative flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                  <MapIcon className="h-12 w-12 opacity-40" />
                  <p className="mono text-[11px] uppercase tracking-wider">El mapa aparecera aqui</p>
                  <p className="text-xs opacity-70">Carga imagenes y presiona Generar mapa unificado</p>
                </div>
              )}
            </div>

            {/* Metadatos del mapa */}
            <div className="grid grid-cols-5 divide-x divide-border border-t border-border bg-card/40">
              <MetaCell label="Estado" value={phase === "done" ? "Completado" : phase === "error" ? "Error" : processing ? "Procesando" : "En espera"} />
              <MetaCell label="Imagenes" value={`${validCount} / ${items.length}`} />
              <MetaCell label="Solapamiento" value={overlap == null ? "-" : `${overlap}%`} tone={overlap == null ? undefined : overlap >= MIN_OVERLAP ? "ok" : "error"} />
              <MetaCell label="Origen" value={phase === "done" ? "TIF" : "-"} />
              <MetaCell label="Preview" value={phase === "done" ? "WEBP" : "-"} />
            </div>

            {/* Boton de descarga, visible solo cuando el mapa esta listo */}
            {phase === "done" && (
              <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
                <Button size="sm" onClick={() => { const a = document.createElement("a"); a.href = technicalDownloadUrl || unifiedMapTechnicalDownload; a.download = `mapa-unificado.${technicalDownloadFormat.toLowerCase()}`; a.click(); }} className="h-8 px-3 text-xs">
                  <Download className="mr-1.5 h-3.5 w-3.5" /> Descargar salida tecnica
                </Button>
                <p className="text-xs text-success font-medium">Preview WEBP generado exitosamente</p>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}


// =============================================================================
// FUNCIONES Y COMPONENTES AUXILIARES
// =============================================================================

/** Pausa la ejecucion N milisegundos. Simula latencia de red entre fases. */
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Encabezado estandar para cada panel del sistema */
function PanelHeader({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode; }) {
  return (
    <div className="flex items-center justify-between px-1">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-primary/15 text-primary">{icon}</span>
        <h3 className="mono text-[11px] font-semibold uppercase tracking-wider">{title}</h3>
      </div>
      {children}
    </div>
  );
}

/** Tile de metrica para el resumen de carga en la revision tecnica */
function InfoTile({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: "ok" | "warn" | "error"; }) {
  const color = tone === "ok" ? "text-success" : tone === "warn" ? "text-warning-foreground" : tone === "error" ? "text-destructive" : "text-foreground";
  return (
    <div className="flex items-center gap-2 rounded border border-border bg-background/40 px-2 py-1.5">
      <span className="text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <p className="mono text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className={`text-sm font-semibold tabular-nums ${color}`}>{value}</p>
      </div>
    </div>
  );
}

/** Celda de metadatos en la barra inferior del mapa unificado */
function MetaCell({ label, value, tone }: { label: string; value: string; tone?: "ok" | "error"; }) {
  const color = tone === "ok" ? "text-success" : tone === "error" ? "text-destructive" : "text-foreground";
  return (
    <div className="px-3 py-2">
      <p className="mono text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-xs font-semibold truncate ${color}`}>{value}</p>
    </div>
  );
}

/** Paso numerado para el panel de instrucciones */
function GuideStep({ number, title, text }: { number: string; title: string; text: string; }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-primary/15 mono text-[10px] font-semibold text-primary ring-1 ring-primary/30">{number}</span>
      <span>
        <span className="block font-semibold text-foreground text-xs">{title}</span>
        <span className="text-xs text-muted-foreground leading-relaxed">{text}</span>
      </span>
    </li>
  );
}

/**
 * Fila de verificacion en el panel de revision tecnica.
 * Muestra estado con icono, etiqueta, hint descriptivo y badge de texto.
 */
function CheckRow({ label, state, hint }: { label: string; state: TriState; hint?: string; }) {
  const cfg = useMemo(() => {
    switch (state) {
      case "ok": return { icon: <CheckCircle2 className="h-4 w-4 text-success" />, text: "APROBADO", color: "text-success", bar: "bg-success" };
      case "warn": return { icon: <AlertTriangle className="h-4 w-4 text-warning" />, text: "INSUFICIENTE", color: "text-warning", bar: "bg-warning" };
      case "error": return { icon: <XCircle className="h-4 w-4 text-destructive" />, text: "ERROR", color: "text-destructive", bar: "bg-destructive" };
      case "running": return { icon: <Loader2 className="h-4 w-4 animate-spin text-primary" />, text: "ANALIZANDO", color: "text-primary", bar: "bg-primary" };
      default: return { icon: <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/60" />, text: "PENDIENTE", color: "text-muted-foreground", bar: "bg-muted-foreground/40" };
    }
  }, [state]);
  return (
    <div className="relative flex items-start gap-3 px-3 py-2.5">
      <span className={`absolute left-0 top-0 h-full w-0.5 ${cfg.bar}`} />
      <div className="mt-0.5">{cfg.icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium leading-tight">{label}</p>
        {hint && <p className="mono text-[10px] text-muted-foreground">{hint}</p>}
      </div>
      <span className={`mono text-[10px] font-semibold tracking-wider ${cfg.color}`}>{cfg.text}</span>
    </div>
  );
}
