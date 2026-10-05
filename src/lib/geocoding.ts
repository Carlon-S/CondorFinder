// =============================================================================
// CONDORFINDER — GEOCODIFICACIÓN (HDU6)
// Archivo: src/lib/geocoding.ts
//
// Dos proveedores, y el de abajo nunca se va: Google por el backend cuando hay
// clave, Nominatim (OpenStreetMap) cuando no la hay o cuando Google no
// responde. Es el mismo criterio con el que `routes_provider.py` respalda a
// Google con OSRM: el sistema tiene que seguir funcionando en la máquina de
// cualquiera del equipo, sin cuenta de GCP.
//
// **Google se llama por el BACKEND, no desde acá.** Podría llamarse directo y
// ahorrarse un salto, pero entonces la clave viajaría al navegador y haría
// falta una segunda clave restringida por referente, que es falsificable.
// Ubicar un punto de recurso se hace un puñado de veces en la vida del
// sistema, así que la latencia extra no le importa a nadie.
//
// Las dos funciones de siempre (reverseGeocode/forwardGeocode) conservan su
// firma: `PanelPuntos.tsx` no sabe cuál de los dos proveedores respondió, y no
// tiene por qué saberlo.
//
// Todas son un auto-completado de cortesía: nunca deben tirar una excepción no
// capturada ni bloquear el guardado, así que cualquier falla devuelve null y el
// llamador decide (dejar el texto libre, no mover el marcador, etc).
// =============================================================================

import { CLIENT_BACKEND_URL as BACKEND_URL } from "./config";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org";

/** Una llamada al proxy del backend. `null` ante cualquier problema, incluido
 *  que el backend conteste `null` porque no tiene clave configurada. */
async function porElBackend<T>(ruta: string): Promise<T | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/resources/direcciones/${ruta}`, {
      credentials: "include",
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data ?? null) as T | null;
  } catch {
    return null;
  }
}

interface NominatimAddress {
  road?: string;
  house_number?: string;
  suburb?: string;
  city_district?: string;
  municipality?: string;
  city?: string;
  town?: string;
}

export interface ReverseGeocodeResult {
  address: string;
  comuna: string;
}

export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<ReverseGeocodeResult | null> {
  const deGoogle = await porElBackend<ReverseGeocodeResult>(`inversa?lat=${lat}&lng=${lng}`);
  if (deGoogle?.address || deGoogle?.comuna) return deGoogle;

  try {
    const res = await fetch(
      `${NOMINATIM_URL}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&addressdetails=1`,
    );
    if (!res.ok) return null;
    const data: { address?: NominatimAddress } = await res.json();
    const a = data.address;
    if (!a) return null;
    const address = `${a.road ?? ""} ${a.house_number ?? ""}`.trim();
    // Nominatim etiqueta las comunas chilenas como "suburb", no como
    // "city_district"/"municipality" (la jerarquía que sí usa para otros
    // países) — "city" es casi siempre "Santiago" para todo el Gran
    // Santiago sin importar la comuna real, así que va al final como
    // último recurso, no primero.
    const comuna = a.suburb ?? a.city_district ?? a.municipality ?? a.town ?? a.city ?? "";
    if (!address && !comuna) return null;
    return { address, comuna };
  } catch {
    return null;
  }
}

export interface ForwardGeocodeResult {
  lat: number;
  lng: number;
}

export async function forwardGeocode(query: string): Promise<ForwardGeocodeResult | null> {
  const deGoogle = await porElBackend<ForwardGeocodeResult>(
    `coordenada?q=${encodeURIComponent(query)}`,
  );
  if (deGoogle) return deGoogle;

  try {
    const res = await fetch(
      `${NOMINATIM_URL}/search?format=jsonv2&q=${encodeURIComponent(query)}&countrycodes=cl&limit=1`,
    );
    if (!res.ok) return null;
    const data: Array<{ lat: string; lon: string }> = await res.json();
    if (data.length === 0) return null;
    return { lat: Number(data[0].lat), lng: Number(data[0].lon) };
  } catch {
    return null;
  }
}

/** Una sugerencia del autocompletado. `placeId` es opaco: solo sirve para
 *  pedirle el detalle a `detalleDeSugerencia()`. */
export interface SugerenciaDireccion {
  placeId: string;
  texto: string;
}

/** Sugerencias mientras se escribe.
 *
 *  **Solo con Google**: devuelve lista vacía sin clave, y el campo se comporta
 *  como el texto libre de siempre. Nominatim tiene búsqueda, pero sus
 *  resultados para direcciones chilenas son demasiado pobres para ofrecerlos
 *  como sugerencias: mostrar una lista mala es peor que no mostrar ninguna,
 *  porque invita a elegir algo equivocado.
 *
 *  Se cobra POR SOLICITUD, no por sesión, así que el antirrebote del llamador
 *  es lo que mantiene el consumo bajo. */
export async function sugerirDirecciones(texto: string): Promise<SugerenciaDireccion[]> {
  if (texto.trim().length < 3) return [];
  const r = await porElBackend<SugerenciaDireccion[]>(`sugerencias?q=${encodeURIComponent(texto)}`);
  return r ?? [];
}

export interface DetalleDireccion {
  address: string;
  comuna: string;
  lat: number;
  lng: number;
}

/** Todo lo de una sugerencia elegida, de una sola vez: calle con número,
 *  comuna y coordenada. Es lo que llena el formulario y mueve el marcador sin
 *  una segunda geocodificación. */
export async function detalleDeSugerencia(placeId: string): Promise<DetalleDireccion | null> {
  return porElBackend<DetalleDireccion>(`detalle?placeId=${encodeURIComponent(placeId)}`);
}
