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
  preview: string;
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

export function clearImageState(): void {
  if (!isBrowser) return;
  sessionStorage.removeItem(KEY_ITEMS);
  sessionStorage.removeItem(KEY_UPLOAD_DONE);
  sessionStorage.removeItem(KEY_PHASE);
  sessionStorage.removeItem(KEY_RESULT_URL);
}