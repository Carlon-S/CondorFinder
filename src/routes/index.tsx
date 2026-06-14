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
//   2. Validación de cantidad mínima (16 imágenes)
//   3. Generación y visualización del mapa unificado
//
// =============================================================================


import { createFileRoute } from "@tanstack/react-router";
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
  Layers,
  Info,
  ListChecks,
  ImageIcon,
  Clock,
  FileCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { unifyImages, uploadImages, deleteImage, deleteAllImages, listUploadedImages, pollTask, type OverlapPair } from "@/lib/unify";
import unifiedMapImg from "@/assets/unified-map-simulation.png";
import { saveMapUrl, clearMapUrl } from "@/lib/mapState";
import { AppNavbar } from "@/components/AppNavbar";
import {
  saveItems, loadItems, saveUploadDone, loadUploadDone,
  savePhase, loadPhase, saveResultUrl, loadResultUrl,
  saveTaskId, loadTaskId, clearTaskId,
  saveBackendStage, loadBackendStage, clearBackendStage,
  saveNoWasteDetected, loadNoWasteDetected, clearNoWasteDetected,
  saveDetectionJsonUrl, loadDetectionJsonUrl, clearDetectionJsonUrl,
  clearImageState, type PersistedFileItem,
} from "@/lib/imageState";

import { useNavigate } from "@tanstack/react-router";

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
 * - generating_map     → generando el mapa unificado (backend)
 * - done               → proceso completado exitosamente
 * - error              → proceso detenido por un error
 */
type Phase =
  | "idle"
  | "validating_format"
  | "checking_count"
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

const WEIGHT_LIMIT_KG = 5000;

interface Detection {
  id: number;
  class: string;
  confidence: number;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
  volume_m3: number;
  weight_kg: number | null;
}

// Color fijo por tipo de basura — no se repiten
const CLASS_COLORS: Record<string, string> = {
  // Nombres en español (nuevas ejecuciones)
  "Residuo de construcción":   "#ef4444",
  "Metal":                     "#f97316",
  "Plástico":                  "#3b82f6",
  "Residuo orgánico":          "#22c55e",
  "Muebles":                   "#a855f7",
  "Neumáticos":                "#64748b",
  "Tipo de basura indefinido": "#f59e0b",
  // Nombres en inglés (tareas anteriores al cambio)
  construction_waste: "#ef4444",
  metal:              "#f97316",
  plastic:            "#3b82f6",
  organic_waste:      "#22c55e",
  furniture:          "#a855f7",
  tyres:              "#64748b",
  other:              "#f59e0b",
};

function classColor(cls: string): string {
  if (CLASS_COLORS[cls]) return CLASS_COLORS[cls];
  let hash = 0;
  for (let i = 0; i < cls.length; i++) hash = (hash * 31 + cls.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360},75%,55%)`;
}

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

  const itemNamesRef = useRef<Set<string>>(new Set());
  const [skippedCount, setSkippedCount] = useState(0);

  /** Indica si el usuario está arrastrando archivos sobre la zona de drop */
  const [dragOver, setDragOver] = useState(false);

  /** Porcentaje de progreso del proceso (0-100) */
  const [progress, setProgress] = useState(0);

  /** Mensaje de error detallado para mostrar al usuario cuando el proceso falla */
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  /** Progreso de subida al backend (0-100), null si no hay subida en curso */
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  /** true si hay una subida de imágenes en curso */
  const [uploading, setUploading] = useState(false);

  /** Referencia al input de tipo file (oculto), activado por el botón de carga */
  const inputRef = useRef<HTMLInputElement>(null);

  const [items, setItems] = useState<FileItem[]>(() => {
    return loadItems().map((p) => ({
      id: p.id,
      file: new File([], p.name),
      status: p.status,
      reason: p.reason,
      preview: p.preview ?? "",
    }));
  });

  const [backendStage, setBackendStage] = useState<"checking_overlap" | "joining" | "detecting" | null>(null);

  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>(() => {
    const saved = loadPhase() as Phase;
    return saved === "done" || saved === "error" || saved === "generating_map" ? saved : "idle";
  });

  const [resultUrl, setResultUrl] = useState<string | null>(() => loadResultUrl());
  const [noWasteDetected, setNoWasteDetected] = useState<boolean>(() => loadNoWasteDetected());
  const [overlapDetail, setOverlapDetail] = useState<OverlapPair[]>([]);
  const [errorStage, setErrorStage] = useState<"checking_overlap" | "joining" | "detecting" | null>(null);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [imgNaturalSize, setImgNaturalSize] = useState<{ w: number; h: number } | null>(null);

  const [uploadDone, setUploadDone] = useState<boolean>(() => loadUploadDone());

  // ---------------------------------------------------------------------------
  // LIMPIEZA DE MEMORIA AL DESMONTAR
  // Libera todos los blob: URLs activos para evitar memory leaks.
  // Los data: URLs (thumbnails) se liberan automáticamente con el estado de React.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      items.forEach((i) => {
        if (i.preview.startsWith("blob:")) URL.revokeObjectURL(i.preview);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const persisted: PersistedFileItem[] = items.map((i) => ({
      id: i.id,
      name: i.file.name,
      size: i.file.size,
      status: i.status,
      reason: i.reason,
      preview: i.preview.startsWith("data:") ? i.preview : undefined,
    }));
    saveItems(persisted);
  }, [items]);

  useEffect(() => { saveUploadDone(uploadDone); }, [uploadDone]);
  useEffect(() => { savePhase(phase); }, [phase]);
  useEffect(() => { if (resultUrl) saveResultUrl(resultUrl); }, [resultUrl]);

  // Al montar, verifica qué archivos están realmente en el backend
  // y reconcilia con los items persistidos en sessionStorage
  useEffect(() => {
    const navType = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming)?.type;
    const isReload = navType === "reload";

    if (items.length === 0) {
      // Solo limpiar el backend si es sesión nueva, no si es un reload
      if (!isReload) {
        deleteAllImages().catch(() => {});
      }
      return;
    }

    // Sesión con items: reconciliar con el backend
    listUploadedImages().then((serverFiles) => {
      if (serverFiles === null) return; // backend caído, no hacer nada

      const serverSet = new Set(serverFiles);
      const validItems = items.filter((i) => i.status === "valid");

      const allPresent = validItems.length > 0 &&
        validItems.every((i) => serverSet.has(i.file.name));

      if (allPresent) {
        setUploadDone(true);
      } else if (validItems.length > 0) {
        setUploadDone(false);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (!uploadDone) return;

      listUploadedImages().then((serverFiles) => {
        if (serverFiles === null) return;
        if (serverFiles.length === 0) {
          clearAll();
        }
      });
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadDone]);

  useEffect(() => {
    const savedTaskId = loadTaskId();
    if (!savedTaskId || phase !== "generating_map") return;

    const controller = new AbortController();

    // Restaurar stage guardado para evitar flash de "Iniciando pipeline..."
    const savedStage = loadBackendStage();
    if (savedStage) {
      setBackendStage(savedStage);
      setProgress(savedStage === "joining" ? 55 : 75);
    } else {
      setBackendStage(null);
      setProgress(40);
    }

    pollTask(savedTaskId, (stage) => {
      setBackendStage(stage);
      saveBackendStage(stage);
      setProgress(stage === "checking_overlap" ? 45 : stage === "joining" ? 60 : 75);
    }, controller.signal).then((res) => {
      const stageAtError = res.status === "error"
        ? (res.overlapDetail !== undefined ? "checking_overlap" : loadBackendStage())
        : null;
      clearBackendStage();
      if (res.status === "error") {
        clearTaskId();
        setPhase("error"); savePhase("error");
        setProgress(100);
        setErrorMsg(res.message || "No se pudo generar el mapa. Intenta nuevamente.");
        setErrorStage(stageAtError);
        if (res.overlapDetail) setOverlapDetail(res.overlapDetail);
        return;
      }
      setProgress(85);
      const finalUrl = res.mapUrl || unifiedMapImg;
      const noWaste = res.detectionCount === 0;
      setResultUrl(finalUrl); saveResultUrl(finalUrl);
      setNoWasteDetected(noWaste); saveNoWasteDetected(noWaste);
      saveMapUrl(finalUrl);
      if (res.detectionJsonUrl) {
        saveDetectionJsonUrl(res.detectionJsonUrl);
        fetch(res.detectionJsonUrl)
          .then(r => r.json())
          .then(data => setDetections(data.detections ?? []))
          .catch(() => {});
      }
      setProgress(100);
      setPhase("done"); savePhase("done");
    }).catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      clearTaskId();
      clearBackendStage();
      setPhase("error"); savePhase("error");
      setErrorMsg("No se pudo generar el mapa. Intenta nuevamente.");
    });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    itemNamesRef.current = new Set(items.map((i) => i.file.name));
  }, [items]);

  // Si la página se recarga con phase=done, re-fetch las detecciones desde sessionStorage
  useEffect(() => {
    if (phase !== "done") return;
    const jsonUrl = loadDetectionJsonUrl();
    if (!jsonUrl) return;
    fetch(jsonUrl)
      .then(r => r.json())
      .then(data => setDetections(data.detections ?? []))
      .catch(() => {});
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
  const canGenerate = items.length > 0 && !hasInvalid && enoughImages && !processing && uploadDone && !uploading;

  // ---------------------------------------------------------------------------
  // ESTADOS DE LA REVISIÓN TÉCNICA
  // ---------------------------------------------------------------------------

  /** Estado del check "Formato JPG" */
  const formatState: TriState = hasInvalid ? "error" : items.length > 0 ? "ok" : "pending";

  /** Estado del check "Cantidad mínima" */
  const countState: TriState = items.length === 0 ? "pending" : enoughImages ? "ok" : "warn";

  /** Estado del check "Solapamiento" */
  const overlapState: TriState =
    phase === "generating_map" && backendStage === "checking_overlap" ? "running"
    : phase === "error" && errorStage === "checking_overlap" ? "error"
    : phase === "done" ||
      (phase === "generating_map" && (backendStage === "joining" || backendStage === "detecting")) ||
      (phase === "error" && errorStage !== null && errorStage !== "checking_overlap") ? "ok"
    : "pending";

  /** Estado del check "Generación de mapa (ODM)" */
  const joinState: TriState =
    phase === "generating_map" && backendStage === "joining" ? "running"
    : phase === "error" && errorStage === "joining" ? "error"
    : phase === "done" ||
      (phase === "generating_map" && backendStage === "detecting") ||
      (phase === "error" && errorStage === "detecting") ? "ok"
    : "pending";

  /** Estado del check "Detección de basura" */
  const detectState: TriState =
    phase === "generating_map" && backendStage === "detecting" ? "running"
    : phase === "error" && errorStage === "detecting" ? "error"
    : phase === "done" ? "ok"
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
  const addFiles = useCallback(async (files: FileList | File[]) => {
    if (uploading) return;

    const newItems: FileItem[] = [];
    const validFiles: File[] = [];
    let skipped = 0;

    Array.from(files).forEach((file) => {
      if (itemNamesRef.current.has(file.name)) {
        skipped++;
        return;
      }
      const ok = isJpg(file);
      const id = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`;
      const blobUrl = URL.createObjectURL(file);
      newItems.push({
        id,
        file,
        status: ok ? "valid" : "invalid",
        reason: ok ? undefined : "Solo se aceptan archivos JPG o JPEG.",
        preview: blobUrl,
      });
      if (ok) validFiles.push(file);
    });

    if (skipped > 0) {
      setSkippedCount(skipped);
      setTimeout(() => setSkippedCount(0), 5000);
    }

    if (newItems.length === 0) return;

    setItems((prev) => [...prev, ...newItems]);
    setUploadDone(false);

    if (validFiles.length === 0) return;

    // Primero subir al backend
    setUploading(true);
    setUploadProgress(0);
    try {
      await uploadImages(validFiles, (pct) => setUploadProgress(pct));
      setUploadDone(true);
    } catch {
      setUploadDone(false);
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }

    // Recién después generar thumbnails, con un pequeño delay entre cada uno
    // para no bloquear el hilo principal de golpe
    for (const item of newItems) {
      if (item.status !== "valid") continue;
      await new Promise<void>((resolve) => {
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
          URL.revokeObjectURL(item.preview);
          setItems((prev) =>
            prev.map((i) => i.id === item.id ? { ...i, preview: thumbnail } : i)
          );
          resolve();
        };
        img.onerror = () => resolve();
        img.src = item.preview;
      });
      // Cede el hilo entre cada thumbnail para no congelar la UI
      await new Promise((r) => setTimeout(r, 10));
    }
  }, [uploading]);

  /** Elimina un archivo individual y libera su memoria */
  const removeItem = (id: string) => {
    setItems((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target) {
        URL.revokeObjectURL(target.preview);
        // Eliminar del backend si era válida (solo las válidas se subieron)
        if (target.status === "valid") {
          deleteImage(target.file.name).catch(() => {
            // Fallo silencioso: el archivo simplemente no se borra del disco
          });
        }
      }
      return prev.filter((i) => i.id !== id);
    });
  };
  
  const uploadLabel: Record<string, string> = {
    idle: "Listo para procesar",
    uploading: "Subiendo imágenes al servidor...",
    done: "Imágenes listas",
    error: "Error al subir imágenes",
  };

  const uploadPhase = uploading ? "uploading" : uploadDone ? "done" : "idle";

  /** Reinicia el proceso sin borrar las imágenes cargadas */
  const resetProcess = () => {
    setPhase("idle");
    setProgress(0);
    setResultUrl(null);
    setErrorMsg(null);
    setBackendStage(null);
    setNoWasteDetected(false);
    clearNoWasteDetected();
    setOverlapDetail([]);
    setErrorStage(null);
    setDetections([]);
    setImgNaturalSize(null);
    clearTaskId();
    clearDetectionJsonUrl();
  };

  /** Elimina todas las imágenes y reinicia el proceso */
  const clearAll = () => {
    items.forEach((i) => URL.revokeObjectURL(i.preview));
    setItems([]);
    clearMapUrl();
    resetProcess();
    deleteAllImages().catch(() => {});
    setUploadDone(false);
    setUploadProgress(null);
    clearImageState();
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
   */
  const generate = async () => {
    if (!canGenerate) return;
    resetProcess();
    const validFiles = items.filter((i) => i.status === "valid").map((i) => i.file);
    setPhase("validating_format"); setProgress(10);
    setPhase("checking_count"); setProgress(25);
    setPhase("generating_map"); setProgress(40);
    setBackendStage(null);
    clearBackendStage();

    try {
      const res = await unifyImages(validFiles, {}, (stage) => {
        setBackendStage(stage);
        saveBackendStage(stage);
        setProgress(stage === "checking_overlap" ? 45 : stage === "joining" ? 60 : 75);
      }, (taskId) => {
        saveTaskId(taskId);
      });

      if (res.status === "error") {
        const stageAtError = res.overlapDetail !== undefined ? "checking_overlap" : loadBackendStage();
        clearTaskId(); clearBackendStage();
        setPhase("error"); savePhase("error");
        setProgress(100);
        setErrorMsg(res.message || "No se pudo generar el mapa. Intenta nuevamente.");
        setErrorStage(stageAtError);
        if (res.overlapDetail) setOverlapDetail(res.overlapDetail);
        return;
      }

      setProgress(85);
      const finalUrl = res.mapUrl || unifiedMapImg;
      const noWaste = res.detectionCount === 0;
      setResultUrl(finalUrl); saveResultUrl(finalUrl);
      setNoWasteDetected(noWaste); saveNoWasteDetected(noWaste);
      saveMapUrl(finalUrl);
      if (res.detectionJsonUrl) {
        saveDetectionJsonUrl(res.detectionJsonUrl);
        fetch(res.detectionJsonUrl)
          .then(r => r.json())
          .then(data => setDetections(data.detections ?? []))
          .catch(() => {});
      }
      setProgress(100);
      setPhase("done"); savePhase("done");
      clearBackendStage();

    } catch {
      clearTaskId(); clearBackendStage();
      setPhase("error"); savePhase("error");
      setErrorMsg("No se pudo generar el mapa. Intenta nuevamente.");
    }
  };

  /** Descarga el mapa como blob local — evita bloqueo cross-origin del atributo download */
  const downloadMap = async () => {
    const url = resultUrl || unifiedMapImg;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = "mapa-unificado.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch {
      const a = document.createElement("a");
      a.href = url;
      a.download = "mapa-unificado.png";
      a.click();
    }
  };

  /** Etiquetas descriptivas para cada fase del proceso */
    function getPhaseLabel(phase: Phase, backendStage: "checking_overlap" | "joining" | "detecting" | null): string {
    if (phase === "generating_map") {
      if (backendStage === "checking_overlap") return "Verificando solapamiento entre imágenes...";
      if (backendStage === "joining") return "Unificando imágenes...";
      if (backendStage === "detecting") return "Detectando basura...";
      return "Iniciando pipeline...";
    }
    const labels: Record<Phase, string> = {
      idle: "Listo para procesar",
      validating_format: "Validando formato JPG...",
      checking_count: "Revisando cantidad de imágenes...",
      generating_map: "Iniciando pipeline...",
      done: "Mapa generado exitosamente",
      error: "Proceso detenido por error",
    };
    return labels[phase];
  }

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
    <div className="min-h-screen bg-background text-foreground gis-gradient-bg">
      <AppNavbar />
      <main className="mx-auto max-w-[1400px] px-4 py-4 sm:px-6 sm:py-6 space-y-4">

        {/* Título de página */}
        <div>
          <h2 className="font-SpaceGrotesk text-3xl font-bold tracking-tight text-foreground md:text-4xl">
            Unificación de imágenes aéreas
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Carga imágenes JPG capturadas con drone para generar el mapa unificado de la zona.
          </p>
        </div>

        {/* ── FILA 1: Instrucciones ── */}
        <section className="panel p-5">
          <PanelHeader icon={<Info className="h-3.5 w-3.5" />} title="Instrucciones" />
          <ol className="mt-4 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
            <GuideStep number="1" title="Selecciona la zona" text="Usa imágenes tomadas en un mismo sector para que el mapa final sea coherente y continuo." />
            <GuideStep number="2" title="Carga archivos JPG" text="Arrastra las fotografías o selecciónalas desde tu equipo. Solo se aceptan archivos JPG o JPEG." />
            <GuideStep number="3" title="Verifica el requisito" text={`Se necesitan al menos ${MIN_IMAGES} imágenes JPG válidas para procesar.`} />
            <GuideStep number="4" title="Genera el mapa" text="Cuando todo esté aprobado, presiona el botón para obtener el mapa unificado." />
          </ol>
        </section>

        {/* ── FILA 2: Carga | Imágenes ── */}
        <div className="grid gap-4 md:grid-cols-[2fr_3fr]">

          {/* Zona de carga */}
          <section className="panel p-5 flex flex-col gap-4 h-[460px]">
            <PanelHeader icon={<Upload className="h-3.5 w-3.5" />} title="Carga de imágenes" />
            <button
              type="button"
              onClick={() => !uploading && inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`upload-zone group relative flex w-full flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center transition-all duration-300 flex-1 overflow-hidden ${
                dragOver ? "border-primary bg-primary/10 scale-[1.01]" : "border-border/60 bg-background/30 hover:border-primary/50 hover:bg-primary/5"
              }`}
            >
              <div className="upload-icon flex h-14 w-14 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/30">
                <Upload className="h-7 w-7" />
              </div>
              <p className="mt-4 text-sm font-semibold">Arrastra imágenes JPG aquí</p>
              <p className="mt-1 text-xs text-muted-foreground">o haz clic para seleccionar desde tu equipo</p>
              <p className="mt-3 text-[10px] text-muted-foreground/60">Solo JPG · JPEG · Mínimo {MIN_IMAGES} imágenes</p>
              <input ref={inputRef} type="file" accept="image/jpeg,.jpg,.jpeg" multiple className="hidden"
                disabled={uploading}
                onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
              />
            </button>
          </section>

          {/* Grid de imágenes */}
          <section className="panel p-5 flex flex-col gap-3 h-[460px] relative overflow-hidden">

            {/* Overlay de carga — cubre toda la card independientemente del scroll */}
            {uploading && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-xl bg-background/85 backdrop-blur-sm">
                <div className="scan-line relative h-20 w-20 overflow-hidden rounded-md border border-primary/40 bg-primary/10">
                  <Loader2 className="absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 animate-spin text-primary" />
                </div>
                <p className="text-[11px] font-semibold text-primary">Subiendo imágenes al servidor...</p>
              </div>
            )}

            <div className="flex items-center justify-between">
              <PanelHeader icon={<ImageIcon className="h-3.5 w-3.5" />} title="Imágenes adjuntas">
                <p className="text-[10px] text-muted-foreground ml-2">{validCount} JPG · {invalidCount} rechazadas</p>
              </PanelHeader>
              <div className="flex items-center gap-2">
                {skippedCount > 0 && (
                  <p className="text-[10px] rounded px-2 py-0.5 bg-warning/15 text-yellow-400 border border-warning/20">
                    {skippedCount} omitido(s) — nombre duplicado
                  </p>
                )}
                {invalidCount > 0 && (
                  <Button variant="ghost" size="sm" onClick={clearInvalid} disabled={processing}
                    className="h-7 px-2 text-xs hover:bg-destructive/15 hover:text-destructive">
                    <Trash2 className="mr-1 h-3 w-3" /> No JPG
                  </Button>
                )}
                {items.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={clearAll} disabled={processing}
                    className="h-7 px-2 text-xs hover:bg-destructive/15 hover:text-destructive">
                    <Trash2 className="mr-1 h-3 w-3" /> Limpiar todo
                  </Button>
                )}
              </div>
            </div>

            {items.length > 0 ? (
              <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
                <ul className="grid grid-cols-3 gap-2 pb-1 pr-1 will-change-scroll">
                  {items.map((it) => (
                    <li key={it.id}
                      className={`overflow-hidden rounded-lg border bg-background/40 transform-gpu ${
                        it.status === "invalid" ? "border-destructive/40" : "border-border/60"
                      }`}
                    >
                      <div className="relative h-28 w-full overflow-hidden bg-muted">
                        {it.preview.startsWith("data:") ? (
                          <img src={it.preview} alt={it.file.name} className="h-full w-full object-cover" decoding="async" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <Loader2 className="h-5 w-5 animate-spin text-primary/40" />
                          </div>
                        )}
                        <button type="button" aria-label="Eliminar" onClick={() => removeItem(it.id)} disabled={processing}
                          className="absolute right-1.5 top-1.5 rounded bg-background/85 p-1 text-muted-foreground shadow-sm backdrop-blur transition hover:bg-destructive/15 hover:text-destructive">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="min-w-0 p-2">
                        <p className="truncate text-[10px] font-medium" title={it.file.name}>{it.file.name}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="flex flex-1 min-h-0 items-center justify-center rounded-lg border border-dashed border-border/40 bg-background/20 text-center text-xs text-muted-foreground/60">
                Las imágenes seleccionadas aparecerán aquí
              </div>
            )}
          </section>
        </div>

        {/* ── FILA 3: Botón + tooltip ── */}
        <div className="flex items-center justify-center gap-3">
          <Button onClick={generate} disabled={!canGenerate} className="w-full max-w-sm btn-cta" size="lg">
            {processing ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generando...</>)
            : phase === "done" || phase === "error" ? (<><RotateCcw className="mr-2 h-4 w-4" /> Reprocesar mapa</>)
            : (<><MapIcon className="mr-2 h-4 w-4" /> Generar mapa unificado</>)}
          </Button>

          <div className="group relative flex-shrink-0">
            <div className={`flex h-9 w-9 items-center justify-center rounded-full cursor-help transition-colors ${
              tooltipState.color === "empty" ? "bg-[#1c2219] text-[#ede8df] hover:bg-[#1c2219]/90"
              : tooltipState.color === "warning" ? "bg-warning text-warning-foreground hover:bg-warning/90"
              : tooltipState.color === "destructive" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
              : "bg-success text-black hover:bg-success/90"
            }`}>
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className={`absolute left-full top-1/2 ml-2 -translate-y-1/2 w-64 transition-all ${
              tooltipState.color === "warning" ? "opacity-100 scale-100 pointer-events-auto"
              : "scale-95 opacity-0 group-hover:scale-100 group-hover:opacity-100 pointer-events-none"
            } z-50`}>
              <div className={`relative rounded-md p-2.5 text-[11px] font-medium shadow-xl ${
                tooltipState.color === "empty" ? "bg-[#1c2219] text-[#ede8df]"
                : tooltipState.color === "warning" ? "bg-warning text-warning-foreground"
                : tooltipState.color === "destructive" ? "bg-destructive text-destructive-foreground"
                : "bg-success text-black"
              }`}>
                <div className={`absolute right-full top-1/2 -mt-[6px] border-[6px] border-transparent ${
                  tooltipState.color === "empty" ? "border-r-[#1c2219]"
                  : tooltipState.color === "warning" ? "border-r-warning"
                  : tooltipState.color === "destructive" ? "border-r-destructive"
                  : "border-r-success"
                }`} />
                {tooltipState.message}
              </div>
            </div>
          </div>
        </div>

        {/* ── FILA 4: Revisión técnica | Mapa ── */}
        <div className="grid gap-4 md:grid-cols-[1fr_1.6fr]">

          {/* Revisión técnica */}
          <section className="panel flex flex-col">
            <div className="flex-shrink-0 px-5 pt-5 pb-4">
              <PanelHeader icon={<ListChecks className="h-3.5 w-3.5" />} title="Revisión técnica" />
            </div>

            {/* Contenido scrollable — no desplaza la card del mapa */}
            <div className="flex-1 overflow-y-auto px-5 pb-5 space-y-4 min-h-0">

              <div className="divide-y divide-border/60 rounded-lg border border-border/40 bg-background/20 overflow-hidden">
                <CheckRow label="Formato JPG" state={formatState}
                  hint={formatState === "error" ? `${invalidCount} archivo(s) rechazado(s): solo se aceptan imágenes JPG o JPEG`
                    : formatState === "ok" ? "Todos los archivos son JPG y están listos para procesar"
                    : "Sin archivos cargados aún"} />
                <CheckRow label="Cantidad mínima" state={countState}
                  hint={countState === "ok" ? `${validCount} imágenes JPG cargadas (mínimo requerido: ${MIN_IMAGES})`
                    : countState === "warn" ? `Faltan ${MIN_IMAGES - validCount} imagen(es) para alcanzar el mínimo de ${MIN_IMAGES}`
                    : `Se requieren al menos ${MIN_IMAGES} imágenes JPG válidas`} />
                <CheckRow label="Solapamiento (~60%)" state={overlapState}
                  hint={overlapState === "running" ? "Verificando solapamiento entre imágenes..."
                    : overlapState === "ok" ? "Solapamiento entre imágenes aprobado"
                    : overlapState === "error" ? (errorMsg ?? "Solapamiento insuficiente en uno o más pares")
                    : "Pendiente: se verifica al iniciar la generación"} />
                <CheckRow label="Generación de mapa" state={joinState}
                  hint={joinState === "running" ? "Unificando imágenes..."
                    : joinState === "ok" ? "Mapa unificado generado correctamente"
                    : joinState === "error" ? "La unificación de imágenes falló"
                    : "Pendiente: requiere solapamiento aprobado"} />
                <CheckRow label="Detección de basura" state={detectState}
                  hint={detectState === "running" ? "Detectando basura..."
                    : detectState === "ok" ? "Detección completada"
                    : detectState === "error" ? "La detección de basura falló"
                    : "Pendiente: requiere mapa unificado"} />
              </div>

              {overlapDetail.length > 0 && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 space-y-2">
                  <p className="text-[10px] font-semibold text-destructive">Pares en conflicto ({overlapDetail.length})</p>
                  <ul className="space-y-1.5 max-h-[140px] overflow-y-auto pr-1">
                    {overlapDetail.map((pair, i) => (
                      <li key={i} className="rounded border border-destructive/20 bg-background/40 px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="mono text-[10px] font-semibold text-destructive">{pair.solape}%</span>
                          <span className="mono text-[9px] text-muted-foreground">{pair.distancia_m} m</span>
                        </div>
                        <p className="mono text-[9px] text-muted-foreground truncate mt-0.5" title={pair.imagen_1}>{pair.imagen_1}</p>
                        <p className="mono text-[9px] text-muted-foreground truncate" title={pair.imagen_2}>{pair.imagen_2}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Estado del proceso */}
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground">Estado del proceso</p>
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <p className="text-xs text-foreground font-medium">{getPhaseLabel(phase, backendStage)}</p>
                </div>
                <Progress value={progress} className="h-1" />
                <p className="text-[10px] text-muted-foreground">{progress}% completado</p>
                {uploadProgress !== null && (
                  <div className="mt-1.5 space-y-1">
                    <p className="text-[10px] font-semibold text-primary">Subiendo imágenes al servidor...</p>
                    <Progress value={uploadProgress} className="h-1" />
                    <p className="text-[10px] text-muted-foreground">{uploadProgress}% subido</p>
                  </div>
                )}
              </div>

              {/* Resumen de carga */}
              <div className="grid grid-cols-2 gap-2">
                <InfoTile icon={<ImageIcon className="h-3.5 w-3.5" />} label="Total imágenes" value={String(items.length)} />
                <InfoTile icon={<FileCheck className="h-3.5 w-3.5" />} label="JPG cargadas" value={String(validCount)} tone={validCount >= MIN_IMAGES ? "ok" : undefined} />
                <InfoTile icon={<XCircle className="h-3.5 w-3.5" />} label="Con error" value={String(invalidCount)} tone={invalidCount > 0 ? "error" : undefined} />
              </div>

            </div>
          </section>

          {/* Mapa unificado */}
          <section className="panel overflow-hidden flex flex-col">
            <div className="flex items-center justify-between border-b border-border/30 px-4 py-3">
              <div className="flex items-center gap-2.5 border-l-2 border-primary/50 pl-3">
                <Layers className="h-4 w-4 text-primary/75" />
                <span className="text-sm font-semibold">Mapa unificado</span>
              </div>
              {phase === "done" && (
                <Button size="sm" onClick={downloadMap} className="h-7 px-3 text-xs">
                  <Download className="mr-1.5 h-3.5 w-3.5" /> Descargar mapa
                </Button>
              )}
            </div>

            <div className="relative flex-1 min-h-[380px] w-full overflow-hidden bg-background/50">
              {phase === "done" && resultUrl ? (
                <>
                  <button
                    type="button"
                    onClick={() => navigate({ to: "/analysis" })}
                    className="relative h-full w-full cursor-pointer group"
                    title="Ver análisis de detección"
                  >
                    <div className="absolute inset-3 flex items-center justify-center">
                      <div className="relative w-full h-full">
                        <img
                          src={resultUrl}
                          alt="Mapa unificado generado a partir de las imágenes aéreas"
                          className="h-full w-full object-contain transition-opacity group-hover:opacity-80"
                          onLoad={e => {
                            const img = e.currentTarget;
                            setImgNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
                          }}
                        />
                        {imgNaturalSize && detections.length > 0 && (
                          <svg
                            viewBox={`0 0 ${imgNaturalSize.w} ${imgNaturalSize.h}`}
                            className="absolute inset-0 w-full h-full pointer-events-none transition-opacity group-hover:opacity-80"
                            preserveAspectRatio="xMidYMid meet"
                          >
                            {detections
                              .filter(d => !(d.weight_kg != null && d.weight_kg > WEIGHT_LIMIT_KG))
                              .map(d => {
                                const color = classColor(d.class);
                                const bw = d.bbox.maxx - d.bbox.minx;
                                const bh = d.bbox.maxy - d.bbox.miny;
                                const FONT = 24;
                                return (
                                  <g key={d.id}>
                                    <rect x={d.bbox.minx} y={d.bbox.miny} width={bw} height={bh}
                                      fill={color} fillOpacity={0.18} stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
                                    <text x={d.bbox.minx} y={d.bbox.miny - 6} fontSize={FONT} fill={color}
                                      fontFamily="monospace" fontWeight="700" paintOrder="stroke"
                                      stroke="rgba(0,0,0,0.75)" strokeWidth={5} strokeLinejoin="round">
                                      {d.class}
                                    </text>
                                  </g>
                                );
                              })}
                          </svg>
                        )}
                      </div>
                    </div>
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="flex items-center gap-2 rounded-md bg-background/85 px-4 py-2 shadow-xl backdrop-blur">
                        <MapIcon className="h-4 w-4 text-primary" />
                        <span className="text-sm font-semibold text-foreground">Ver análisis de detección</span>
                      </div>
                    </div>
                  </button>
                  {noWasteDetected && (
                    <div className="absolute bottom-0 left-0 right-0 z-10 flex items-start gap-3 bg-warning/90 backdrop-blur-sm px-4 py-2.5">
                      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-black" />
                      <p className="text-xs font-medium leading-relaxed text-black">
                        No se detectó basura en el área procesada. El mapa está disponible para inspección visual.
                      </p>
                    </div>
                  )}
                </>
              ) : processing ? (
                <div className="flex h-full w-full flex-col items-center justify-center gap-3">
                  <div className="scan-line relative h-24 w-24 overflow-hidden rounded-md border border-primary/40 bg-primary/10">
                    <Loader2 className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 animate-spin text-primary" />
                  </div>
                  <p className="mono text-[11px] uppercase tracking-wider text-primary">{getPhaseLabel(phase, backendStage)}</p>
                  <div className="w-64"><Progress value={progress} className="h-1" /></div>
                </div>
              ) : phase === "error" ? (
                <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full border border-destructive/40 bg-destructive/15 mb-1">
                    <XCircle className="h-6 w-6 text-destructive" />
                  </div>
                  <p className="text-sm font-semibold text-foreground mb-1">Error en el procesamiento</p>
                  <p className="text-xs text-muted-foreground leading-relaxed max-w-md">{errorMsg}</p>
                </div>
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                  <MapIcon className="h-12 w-12 opacity-30" />
                  <p className="mono text-[11px] uppercase tracking-wider">El mapa aparecerá aquí</p>
                  <p className="text-xs opacity-60">Carga imágenes y presiona Generar mapa unificado</p>
                </div>
              )}
            </div>

            {phase === "done" && noWasteDetected ? null : (
              <div className="grid grid-cols-3 divide-x divide-border/30 border-t border-border/30">
                <MetaCell label="Estado" value={phase === "done" ? "Completado" : phase === "error" ? "Error" : processing ? "Procesando" : "En espera"} />
                <MetaCell label="Imágenes" value={`${validCount} / ${items.length}`} />
                <MetaCell label="Salida" value={phase === "done" ? "JPG generado" : "JPG"} tone={phase === "done" ? "ok" : undefined} />
              </div>
            )}

            {phase === "done" && (
              <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border/30 bg-success/5">
                <p className="text-xs text-success font-semibold">Mapa generado exitosamente</p>
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

/** Encabezado de panel con barra de acento izquierda */
function PanelHeader({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode; }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2.5 border-l-2 border-primary/50 pl-3">
        <span className="text-primary/75 [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
      </div>
      {children}
    </div>
  );
}

/** Tile de metrica para el resumen de carga */
function InfoTile({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: "ok" | "warn" | "error"; }) {
  const color = tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : tone === "error" ? "text-destructive" : "text-foreground";
  return (
    <div className="flex items-center gap-3 rounded-lg bg-background/60 px-3 py-2.5">
      <span className="text-primary/60 flex-shrink-0 [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] text-muted-foreground leading-none mb-1">{label}</p>
        <p className={`text-sm font-bold tabular-nums leading-none ${color}`}>{value}</p>
      </div>
    </div>
  );
}

/** Celda de metadatos en la barra inferior del mapa unificado */
function MetaCell({ label, value, tone }: { label: string; value: string; tone?: "ok" | "error"; }) {
  const color = tone === "ok" ? "text-success" : tone === "error" ? "text-destructive" : "text-foreground/80";
  return (
    <div className="px-3 py-2">
      <p className="text-[10px] text-muted-foreground leading-none mb-1">{label}</p>
      <p className={`text-xs font-semibold truncate ${color}`}>{value}</p>
    </div>
  );
}

/** Paso del panel de instrucciones — número fantasma como fondo editorial */
function GuideStep({ number, title, text, compact }: { number: string; title: string; text: string; compact?: boolean }) {
  return (
    <li className={`relative overflow-hidden rounded-lg bg-background/30 flex flex-col justify-end gap-1 ${
      compact ? "px-3 pb-3 pt-5 min-h-[88px]" : "px-4 pb-4 pt-6 min-h-[108px]"
    }`}>
      <span
        className={`absolute -top-3 -left-1 font-SpaceGrotesk font-bold leading-none select-none pointer-events-none ${
          compact ? "text-5xl" : "text-7xl"
        }`}
        style={{ color: "var(--primary)", opacity: 0.1 }}
      >
        {number}
      </span>
      <span className={`relative font-semibold text-foreground ${compact ? "text-xs" : "text-sm"}`}>{title}</span>
      <span className={`relative text-muted-foreground leading-snug ${compact ? "text-[11px]" : "text-xs"}`}>{text}</span>
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
      case "ok":      return { icon: <CheckCircle2 className="h-4 w-4 text-success" />,               text: "Aprobado",     color: "text-success",          bar: "bg-success",              bg: "bg-success/5" };
      case "warn":    return { icon: <AlertTriangle className="h-4 w-4 text-warning" />,               text: "Insuficiente", color: "text-warning",           bar: "bg-warning",              bg: "bg-warning/5" };
      case "error":   return { icon: <XCircle className="h-4 w-4 text-destructive" />,                 text: "Error",        color: "text-destructive",       bar: "bg-destructive",          bg: "bg-destructive/5" };
      case "running": return { icon: <Loader2 className="h-4 w-4 animate-spin text-primary" />,        text: "Analizando",   color: "text-primary",           bar: "bg-primary",              bg: "bg-primary/5" };
      default:        return { icon: <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/50 mt-1.5" />, text: "Pendiente", color: "text-muted-foreground", bar: "bg-muted-foreground/30", bg: "" };
    }
  }, [state]);
  return (
    <div className={`check-row relative flex items-start gap-3 px-3 py-3 ${cfg.bg}`}>
      <span className={`absolute left-0 top-0 h-full w-[3px] rounded-r-full ${cfg.bar} transition-all duration-300`} />
      <div className="mt-0.5 flex-shrink-0">{cfg.icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold leading-tight text-foreground">{label}</p>
        {hint && <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{hint}</p>}
      </div>
      <span className={`text-[10px] font-semibold ${cfg.color} flex-shrink-0`}>{cfg.text}</span>
    </div>
  );
}
