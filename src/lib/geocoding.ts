// =============================================================================
// CONDORFINDER — GEOCODIFICACIÓN (HDU6)
// Archivo: src/lib/geocoding.ts
//
// Nominatim (OpenStreetMap) — mismo proveedor de tiles que ya usa GeoMap, sin
// API key. Ambas funciones son un auto-completado de cortesía: nunca deben
// tirar una excepción no capturada ni bloquear el flujo de guardado, así que
// cualquier falla (red, sin resultados) devuelve null y el caller decide qué
// hacer (dejar el campo como texto libre, no mover el marcador, etc).
// =============================================================================

const NOMINATIM_URL = "https://nominatim.openstreetmap.org";

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

export async function reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult | null> {
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
