// =============================================================================
// CONDORFINDER — PERSISTENCIA DE ESTADO DE IMÁGENES
// Archivo: src/lib/imageState.ts
//
// Guard typeof window !== "undefined" en todas las funciones porque
// TanStack Start ejecuta SSR en Node.js donde sessionStorage no existe.
// =============================================================================

export interface PersistedFileItem {
  id: string;
  name: string;
  size: number;
  status: "valid" | "invalid";
  reason?: string;
  preview?: string;
}

const KEY_ITEMS       = "condorfinder_items";
const KEY_UPLOAD_DONE = "condorfinder_upload_done";
const KEY_PHASE       = "condorfinder_phase";
const KEY_RESULT_URL  = "condorfinder_result_url";

const isBrowser = typeof window !== "undefined";

export function saveItems(items: PersistedFileItem[]): void {
  if (!isBrowser) return;
  sessionStorage.setItem(KEY_ITEMS, JSON.stringify(items));
}

export function loadItems(): PersistedFileItem[] {
  if (!isBrowser) return [];
  try {
    const raw = sessionStorage.getItem(KEY_ITEMS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveUploadDone(done: boolean): void {
  if (!isBrowser) return;
  sessionStorage.setItem(KEY_UPLOAD_DONE, String(done));
}

export function loadUploadDone(): boolean {
  if (!isBrowser) return false;
  return sessionStorage.getItem(KEY_UPLOAD_DONE) === "true";
}

export function savePhase(phase: string): void {
  if (!isBrowser) return;
  sessionStorage.setItem(KEY_PHASE, phase);
}

export function loadPhase(): string {
  if (!isBrowser) return "idle";
  return sessionStorage.getItem(KEY_PHASE) ?? "idle";
}

export function saveResultUrl(url: string): void {
  if (!isBrowser) return;
  sessionStorage.setItem(KEY_RESULT_URL, url);
}

export function loadResultUrl(): string | null {
  if (!isBrowser) return null;
  return sessionStorage.getItem(KEY_RESULT_URL);
}

const KEY_TASK_ID = "condorfinder_task_id";

export function saveTaskId(taskId: string): void {
  if (!isBrowser) return;
  sessionStorage.setItem(KEY_TASK_ID, taskId);
}

export function loadTaskId(): string | null {
  if (!isBrowser) return null;
  return sessionStorage.getItem(KEY_TASK_ID);
}

export function clearTaskId(): void {
  if (!isBrowser) return;
  sessionStorage.removeItem(KEY_TASK_ID);
}

const KEY_NO_WASTE = "condorfinder_no_waste";

export function saveNoWasteDetected(noWaste: boolean): void {
  if (!isBrowser) return;
  sessionStorage.setItem(KEY_NO_WASTE, String(noWaste));
}

export function loadNoWasteDetected(): boolean {
  if (!isBrowser) return false;
  return sessionStorage.getItem(KEY_NO_WASTE) === "true";
}

export function clearNoWasteDetected(): void {
  if (!isBrowser) return;
  sessionStorage.removeItem(KEY_NO_WASTE);
}

const KEY_BACKEND_STAGE = "condorfinder_backend_stage";

export function saveBackendStage(stage: "checking_overlap" | "joining" | "detecting"): void {
  if (!isBrowser) return;
  sessionStorage.setItem(KEY_BACKEND_STAGE, stage);
}

export function loadBackendStage(): "checking_overlap" | "joining" | "detecting" | null {
  if (!isBrowser) return null;
  const val = sessionStorage.getItem(KEY_BACKEND_STAGE);
  return val === "checking_overlap" || val === "joining" || val === "detecting" ? val : null;
}

export function clearBackendStage(): void {
  if (!isBrowser) return;
  sessionStorage.removeItem(KEY_BACKEND_STAGE);
}

export function clearImageState(): void {
  if (!isBrowser) return;
  sessionStorage.removeItem(KEY_ITEMS);
  sessionStorage.removeItem(KEY_UPLOAD_DONE);
  sessionStorage.removeItem(KEY_PHASE);
  sessionStorage.removeItem(KEY_RESULT_URL);
  sessionStorage.removeItem(KEY_TASK_ID);
  sessionStorage.removeItem(KEY_NO_WASTE);
  sessionStorage.removeItem(KEY_BACKEND_STAGE);
}