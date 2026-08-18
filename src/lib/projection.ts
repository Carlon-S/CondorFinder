// =============================================================================
// CONDORFINDER — REPROYECCIÓN UTM → WGS84 (HDU5)
// Archivo: src/lib/projection.ts
//
// volumeCalc.py ya calcula geo_polygon por detección, pero en el CRS
// proyectado del ortomosaico (lo que ODM genera — casi siempre una zona UTM
// WGS84, ej. "EPSG:32719" para Maipú/Región Metropolitana), no en lat/lng.
// Leaflet necesita WGS84 (EPSG:4326) para ubicar algo en un mapa real, así
// que esta reproyección tiene que pasar en algún lado — se hace acá, en el
// cliente, para no tener que tocar el backend (HDU5 es solo frontend).
//
// No se usa una base de datos EPSG externa: se reconoce el patrón de zona
// UTM WGS84 (326xx = hemisferio norte, 327xx = sur, xx = número de zona,
// 01-60) y se arma la definición proj4 directo — cubre el caso real, porque
// ODM siempre georreferencia sus ortomosaicos en una zona UTM.
// =============================================================================

import proj4 from "proj4";

const UTM_EPSG_PATTERN = /^EPSG:(326|327)(\d{2})$/;

function utmProj4Def(crs: string): string | null {
  const match = crs.trim().toUpperCase().match(UTM_EPSG_PATTERN);
  if (!match) return null;
  const hemisphere = match[1] === "327" ? "south" : "north";
  const zone = Number(match[2]);
  if (zone < 1 || zone > 60) return null;
  return `+proj=utm +zone=${zone}${hemisphere === "south" ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
}

/**
 * Reproyecta un polígono de `crs` (CRS proyectado del ortomosaico) a WGS84.
 * Devuelve pares [lat, lng] (orden que espera Leaflet), o `null` si `crs` no
 * matchea el patrón de zona UTM WGS84 reconocido — el caller debe omitir ese
 * polígono en vez de ubicarlo mal.
 */
export function projectPolygonToWgs84(coords: number[][], crs: string): [number, number][] | null {
  const def = utmProj4Def(crs);
  if (!def) return null;

  try {
    const projection = proj4(def, "WGS84");
    return coords.map(([x, y]) => {
      const [lng, lat] = projection.forward([x, y]);
      return [lat, lng] as [number, number];
    });
  } catch {
    return null;
  }
}
