import { useEffect, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polygon,
  Polyline,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import type { GeoMapProps } from "@/components/GeoMap";
import { ROUTE_OUTBOUND_COLOR, ROUTE_OUTLINE_COLOR, ROUTE_RETURN_COLOR, ROUTE_RETURN_OPACITY } from "@/components/route-colors";

/** Centro aproximado de la comuna de Maipú, Región Metropolitana. Sin
 *  exportar a propósito — nada afuera de este archivo lo usa, y exportar un
 *  valor no-componente junto al componente de este módulo rompe el
 *  contrato de Fast Refresh de Vite (fuerza un full reload en cada cambio
 *  de este archivo en vez de un hot-patch — eso a su vez generaba el error
 *  "Could not find an active match from /_authed" al recargar en medio de
 *  ese full reload, con el router en un estado intermedio). */
const MAIPU_CENTER: [number, number] = [-33.5167, -70.75];

// Este módulo solo se carga vía import() dinámico desde GeoMap.tsx, después
// del mount — nunca se evalúa durante SSR. Leaflet toca `window` en el
// top-level de su propio módulo (sin guard), así que fixDefaultIcon() puede
// llamarse directo acá arriba: para cuando este archivo se ejecuta, `window`
// ya existe siempre.
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
  // El tooltipAnchor por defecto de Leaflet es [16, -28] — el 16 corrige
  // por la sombra clásica del pin, y sin quererlo descentra cualquier
  // <Tooltip direction="top"> unos px hacia la derecha del ícono.
  tooltipAnchor: [0, -28],
});

// Pines reales (Phosphor "MapPin"/"MapPinArea", regular + fill) en vez de
// las formas de CSS que había antes — se arman como <svg> crudo porque
// Leaflet arma L.divIcon a partir de un string de HTML, no de JSX.
//
// Cada par regular/fill reemplaza el viejo truco de opacidad/borde para
// distinguir "activo" de "no activo": la silueta hueca (regular) YA se lee
// como "sin marcar" y la rellena (fill) como "marcado", sin necesitar CSS
// adicional para esa distinción — son dibujos genuinamente distintos, no
// el mismo dibujo con relleno distinto.
const ZONE_PIN_REGULAR =
  "M128,64a40,40,0,1,0,40,40A40,40,0,0,0,128,64Zm0,64a24,24,0,1,1,24-24A24,24,0,0,1,128,128Zm0-112a88.1,88.1,0,0,0-88,88c0,31.4,14.51,64.68,42,96.25a254.19,254.19,0,0,0,41.45,38.3,8,8,0,0,0,9.18,0A254.19,254.19,0,0,0,174,200.25c27.45-31.57,42-64.85,42-96.25A88.1,88.1,0,0,0,128,16Zm0,206c-16.53-13-72-60.75-72-118a72,72,0,0,1,144,0C200,161.23,144.53,209,128,222Z";
const ZONE_PIN_FILL =
  "M128,16a88.1,88.1,0,0,0-88,88c0,75.3,80,132.17,83.41,134.55a8,8,0,0,0,9.18,0C136,236.17,216,179.3,216,104A88.1,88.1,0,0,0,128,16Zm0,56a32,32,0,1,1-32,32A32,32,0,0,1,128,72Z";
// "Puntos de partida y destino" (HDU6) — un punto que el algoritmo de ruta
// puede tratar como origen o como destino (ver el rename de "punto de
// origen" a simplemente "punto" en toda la app), por eso un pin distinto
// al de zona en vez de reusar la misma familia "MapPin".
const ORIGIN_PIN_REGULAR =
  "M128,16a88.1,88.1,0,0,0-88,88c0,31.4,14.51,64.68,42,96.25a254.19,254.19,0,0,0,41.45,38.3,8,8,0,0,0,9.18,0A254.19,254.19,0,0,0,174,200.25c27.45-31.57,42-64.85,42-96.25A88.1,88.1,0,0,0,128,16Zm0,206c-16.53-13-72-60.75-72-118a72,72,0,0,1,144,0C200,161.23,144.53,209,128,222Zm40-118a8,8,0,0,1-8,8H136v24a8,8,0,0,1-16,0V112H96a8,8,0,0,1,0-16h24V72a8,8,0,0,1,16,0V96h24A8,8,0,0,1,168,104Z";
const ORIGIN_PIN_FILL =
  "M128,16a88.1,88.1,0,0,0-88,88c0,31.4,14.51,64.68,42,96.25a254.19,254.19,0,0,0,41.45,38.3,8,8,0,0,0,9.18,0A254.19,254.19,0,0,0,174,200.25c27.45-31.57,42-64.85,42-96.25A88.1,88.1,0,0,0,128,16Zm32,96H136v24a8,8,0,0,1-16,0V112H96a8,8,0,0,1,0-16h24V72a8,8,0,0,1,16,0V96h24a8,8,0,0,1,0,16Z";

function pinDivIcon(path: string, color: string, size: number): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<svg width="${size}" height="${size}" viewBox="0 0 256 256" fill="${color}" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.45));"><path d="${path}"/></svg>`,
    // El pin "apunta" hacia abajo — el ancla va en la punta inferior del
    // dibujo (no en el centro geométrico, como sí correspondía con el
    // círculo/cuadrado anteriores), para que quede clavado en la
    // coordenada real del mapa en vez de flotar sobre ella.
    iconSize: [size, size],
    iconAnchor: [size / 2, size - 2],
    tooltipAnchor: [0, -size + 8],
  });
}

// Zonas (HDU5): pin más grande, "precisión espectacular" para distinguirlas
// de los pines de puntos (HDU6) aunque compartan la misma familia de forma.
function zoneIcon(color: string, filled: boolean): L.DivIcon {
  return pinDivIcon(filled ? ZONE_PIN_FILL : ZONE_PIN_REGULAR, filled ? color : "var(--muted-foreground)", 44);
}

// Puntos de origen (HDU6): pin "de área" (silueta con base ovalada en la
// versión fill) — mismo criterio sólido=activo/hueco=inactivo que zoneIcon.
function originIcon(active: boolean): L.DivIcon {
  return pinDivIcon(active ? ORIGIN_PIN_FILL : ORIGIN_PIN_REGULAR, active ? "var(--primary)" : "var(--muted-foreground)", 36);
}

/** Recuadros de detecciones superpuestos sobre la miniatura del tooltip
 *  (HDU5) — "png + json" juntos, no solo la imagen plana. slice (no meet):
 *  tiene que recortar igual que el object-fit:cover de la imagen de al lado
 *  para que los rects queden alineados con lo que realmente se ve. */
function PreviewDetectionsOverlay({
  detections,
  imageSize,
}: {
  detections: NonNullable<import("@/components/GeoMap").GeoMapPoint["previewDetections"]>;
  imageSize: { w: number; h: number };
}) {
  return (
    <svg
      viewBox={`0 0 ${imageSize.w} ${imageSize.h}`}
      preserveAspectRatio="xMidYMid slice"
      className="tooltip-detections-overlay"
    >
      {detections.map((d) => (
        <rect
          key={d.id}
          x={d.bbox.minx}
          y={d.bbox.miny}
          width={d.bbox.maxx - d.bbox.minx}
          height={d.bbox.maxy - d.bbox.miny}
          fill={d.color}
          fillOpacity={0.35}
          stroke={d.color}
          strokeWidth={imageSize.w / 200}
        />
      ))}
    </svg>
  );
}

/** Imagen de la miniatura del tooltip de hover, con su propio manejo de
 *  error — si el PNG no carga (404, ej. la zona se eliminó desde otra
 *  pestaña/sesión mientras seguía en memoria acá) se ve un aviso en vez de
 *  un ícono de imagen rota. Estado local propio (no en el padre) porque
 *  cada marker es independiente: que uno falle no debe afectar a los demás. */
function TooltipPreviewImage({ src, alt }: { src: string; alt: string }) {
  const [error, setError] = useState(false);
  if (error) {
    return (
      <div className="tooltip-image-error">
        <span>Mapa no disponible</span>
      </div>
    );
  }
  return <img src={src} alt={alt} decoding="async" onError={() => setError(true)} />;
}

function ClickHandler({ onMapClick }: { onMapClick?: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onMapClick?.(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/** Centra+acerca el mapa a `target` cada vez que cambia — usado tanto al
 *  hacer click en un punto guardado como al llegar por deep-link
 *  (?point=id) desde Vista Principal. No hace nada mientras es null. */
function FlyToPoint({ target }: { target: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo(target, 16, { duration: 0.8 });
  }, [target, map]);
  return null;
}

/** Encuadra el mapa para que quepan todos `points` (ej. una ruta recién
 *  generada) — una sola vez cada vez que la referencia del array cambia
 *  (una respuesta nueva del backend siempre trae arrays nuevos, así que
 *  no hace falta clonar nada a mano como sí hace falta en FlyToPoint). */
function FitBounds({ points }: { points: [number, number][] | null | undefined }) {
  const map = useMap();
  useEffect(() => {
    if (points && points.length > 1) {
      map.flyToBounds(L.latLngBounds(points), { padding: [48, 48], duration: 0.8 });
    }
  }, [points, map]);
  return null;
}

/** Texto de la ventana flotante sobre un tramo de ruta (estilo Google
 *  Maps) — velocidad calculada acá mismo (distancia/tiempo), no viaja como
 *  campo aparte del backend. */
function segmentTooltipText(
  direction: "Ida" | "Vuelta",
  trucksUsed: number,
  distanceKm: number,
  durationHours: number,
): string {
  const minutes = Math.round(durationHours * 60);
  const speedKmh = durationHours > 0 ? Math.round(distanceKm / durationHours) : 0;
  const trucksLabel = trucksUsed > 0 ? `🚚×${trucksUsed} · ` : "";
  return `${trucksLabel}${direction} · ${minutes} min · ${distanceKm.toFixed(1)} km · ~${speedKmh} km/h`;
}

/** Distancia aproximada (en grados, NO metros) entre dos puntos — alcanza
 *  para repartir proporciones a lo largo de un trazo (pointAtFraction de
 *  abajo), no se usa para mostrar ninguna distancia real al usuario. */
function approxDistance(a: [number, number], b: [number, number]): number {
  const dLat = a[0] - b[0];
  const dLng = a[1] - b[1];
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/** Punto ubicado a `fraction` (0-1) de la distancia ACUMULADA de `path`
 *  (no del índice de vértice) — así la ventana flotante queda a un cuarto
 *  del recorrido real, sin importar que los vértices de OSRM no estén
 *  parejo espaciados (hay muchos más en curvas que en tramos rectos). */
function pointAtFraction(path: [number, number][], fraction: number): [number, number] | null {
  if (path.length === 0) return null;
  if (path.length === 1) return path[0];
  let total = 0;
  const segLengths: number[] = [];
  for (let i = 1; i < path.length; i++) {
    const d = approxDistance(path[i - 1], path[i]);
    segLengths.push(d);
    total += d;
  }
  if (total === 0) return path[0];
  const target = total * fraction;
  let acc = 0;
  for (let i = 0; i < segLengths.length; i++) {
    if (acc + segLengths[i] >= target) {
      const segFraction = segLengths[i] === 0 ? 0 : (target - acc) / segLengths[i];
      const [lat1, lng1] = path[i];
      const [lat2, lng2] = path[i + 1];
      return [lat1 + (lat2 - lat1) * segFraction, lng1 + (lng2 - lng1) * segFraction];
    }
    acc += segLengths[i];
  }
  return path[path.length - 1];
}

/** Key estable PERO distinta entre rutas distintas — primer/último punto +
 *  cantidad de vértices. Forzar el remonte completo del Polyline (y de su
 *  ventana flotante) cuando cambia la ruta es la garantía más simple y
 *  robusta contra el problema de arriba (Leaflet no repositiona un
 *  tooltip ya abierto solo porque cambiaron las coordenadas de su capa) —
 *  React destruye el nodo viejo del mapa y crea uno nuevo desde cero en
 *  vez de intentar "actualizar" uno que Leaflet no sabe recolocar solo. */
function pathKey(path: [number, number][]): string {
  if (path.length === 0) return "empty";
  const first = path[0];
  const last = path[path.length - 1];
  return `${first[0].toFixed(4)},${first[1].toFixed(4)}-${last[0].toFixed(4)},${last[1].toFixed(4)}-${path.length}`;
}

// Icono invisible (sin html) -- el marcador solo existe para anclar el
// tooltip permanente en un punto exacto del trazo; no debe verse ningún
// pin. Módulo-level: no hace falta recrearlo en cada render.
const INVISIBLE_ICON = L.divIcon({ className: "", html: "", iconSize: [0, 0] });

/** Ancla una ventana flotante (estilo Google Maps: burbuja + flecha) al
 *  punto ubicado a `fraction` del trazo `path`. Marker invisible +
 *  Tooltip direction="top" en vez de atar el tooltip directo al Polyline:
 *  un Polyline con tooltip "permanent" no recalcula su posición cuando
 *  solo cambian sus coordenadas (setLatLngs no mueve un tooltip ya
 *  abierto) -- por eso, al generar una ruta nueva, la ventana anterior se
 *  quedaba pegada en el lugar de la ruta vieja. Un Marker si sigue su
 *  propia posición correctamente, y la key (más abajo) fuerza además un
 *  remonte completo cuando cambia la ruta, como garantía extra. */
function RouteSegmentLabel({
  path,
  fraction,
  text,
  offset,
}: {
  path: [number, number][];
  fraction: number;
  text: string;
  /** Desplazamiento en píxeles (x, y) — en un tramo de ida y vuelta por la
   *  MISMA carretera (ej. un solo camino de montaña con curvas), el punto
   *  al 25% del recorrido de cada trazo puede caer geográficamente cerca
   *  del otro aunque se midan desde extremos opuestos (las curvas
   *  concentran buena parte de la distancia recorrida en un tramo corto).
   *  Un offset horizontal distinto para ida/vuelta garantiza que las dos
   *  burbujas nunca queden una encima de la otra, sin depender de la
   *  geometría real de la calle. */
  offset: [number, number];
}) {
  const anchor = pointAtFraction(path, fraction);
  if (!anchor) return null;
  return (
    <Marker position={anchor} icon={INVISIBLE_ICON} interactive={false}>
      <Tooltip permanent direction="top" offset={offset} className="condorfinder-route-tooltip">
        {text}
      </Tooltip>
    </Marker>
  );
}

/** Click sobre la línea de la ruta -> zoom ahí (pedido explícito: el
 *  encuadre automático solo debe pasar al generar la ruta por primera vez
 *  -- ver FitBounds -- o al clickear la línea, no en cualquier momento). */
function flyToLineClick(e: L.LeafletMouseEvent): void {
  L.DomEvent.stopPropagation(e as unknown as Event);
  const map = (e.target as unknown as { _map?: L.Map })._map;
  map?.flyTo(e.latlng, 15, { duration: 0.6 });
}

export function GeoMapImpl({
  center = MAIPU_CENTER,
  zoom = 13,
  marker,
  points,
  polygons,
  routePositions,
  outboundPaths,
  returnPaths,
  routeSegments,
  fitBoundsTo,
  onMapClick,
  onPointClick,
  focusPoint,
  className,
}: GeoMapProps) {
  const hasRealPaths = (outboundPaths && outboundPaths.length > 0) || (returnPaths && returnPaths.length > 0);
  return (
    // preferCanvas: sin esto, cada trazo de ruta (potencialmente cientos de
    // vértices en una ruta larga, x2 por el "casing" debajo) se dibuja como
    // SVG -- Leaflet redibuja SVG a mano en cada frame de zoom, y con esa
    // cantidad de puntos el zoom se sentía con lag notorio. Canvas delega
    // el redibujado al navegador y es muchísimo más fluido para polylines
    // con muchos vértices; los markers (L.divIcon) no se ven afectados,
    // Leaflet los sigue manejando por DOM sin importar este flag.
    <MapContainer center={center} zoom={zoom} className={className} scrollWheelZoom preferCanvas>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ClickHandler onMapClick={onMapClick} />
      <FlyToPoint target={focusPoint ?? null} />
      <FitBounds points={fitBoundsTo ?? null} />
      {marker && <Marker position={marker} />}
      {hasRealPaths ? (
        <>
          {/* Borde oscuro debajo de ambos trazos ("casing") — separa la
              línea del fondo del mapa sin importar qué colores tenga
              debajo (antes el celeste/naranjo original se camuflaba
              contra el agua y las calles de los tiles de OSM). */}
          {outboundPaths?.map((path, i) => (
            <Polyline
              key={`outbound-outline-${pathKey(path as [number, number][])}-${i}`}
              positions={path as [number, number][]}
              pathOptions={{ color: ROUTE_OUTLINE_COLOR, weight: 8, opacity: 0.5 }}
              eventHandlers={{ click: flyToLineClick }}
            />
          ))}
          {returnPaths?.map((path, i) => (
            <Polyline
              key={`return-outline-${pathKey(path as [number, number][])}-${i}`}
              positions={path as [number, number][]}
              pathOptions={{ color: ROUTE_OUTLINE_COLOR, weight: 8, opacity: 0.5 }}
              eventHandlers={{ click: flyToLineClick }}
            />
          ))}
          {/* Ida — trazo real (calles, OSRM), azul sólido (estilo Google
              Maps). Ventana flotante anclada al 25% del recorrido, con
              camiones/tiempo/distancia/velocidad de ESTE tramo — mismo
              índice que routeSegments. Click en la línea -> zoom ahí. */}
          {outboundPaths?.map((path, i) => {
            const key = `outbound-${pathKey(path as [number, number][])}-${i}`;
            return (
              <Polyline
                key={key}
                positions={path as [number, number][]}
                pathOptions={{ color: ROUTE_OUTBOUND_COLOR, weight: 5 }}
                eventHandlers={{ click: flyToLineClick }}
              />
            );
          })}
          {outboundPaths?.map((path, i) => {
            const seg = routeSegments?.[i];
            if (!seg) return null;
            const key = `outbound-label-${pathKey(path as [number, number][])}-${i}`;
            return (
              <RouteSegmentLabel
                key={key}
                path={path as [number, number][]}
                fraction={0.25}
                offset={[-60, 0]}
                text={segmentTooltipText("Ida", seg.trucksUsed, seg.outboundDistanceKm, seg.outboundDurationHours)}
              />
            );
          })}
          {/* Vuelta — mismo tramo tipo de calle, pero más lento (camiones
              cargados, ver _RETURN_SPEED_FACTOR en routing.py) — mismo azul,
              más claro/semitransparente, sin punteado (estilo Google Maps:
              mismo color de ruta, dos sentidos). */}
          {returnPaths?.map((path, i) => {
            const key = `return-${pathKey(path as [number, number][])}-${i}`;
            return (
              <Polyline
                key={key}
                positions={path as [number, number][]}
                pathOptions={{ color: ROUTE_RETURN_COLOR, weight: 5, opacity: ROUTE_RETURN_OPACITY }}
                eventHandlers={{ click: flyToLineClick }}
              />
            );
          })}
          {returnPaths?.map((path, i) => {
            const seg = routeSegments?.[i];
            if (!seg) return null;
            const key = `return-label-${pathKey(path as [number, number][])}-${i}`;
            return (
              <RouteSegmentLabel
                key={key}
                offset={[60, 0]}
                path={path as [number, number][]}
                fraction={0.25}
                text={segmentTooltipText("Vuelta", seg.trucksUsed, seg.returnDistanceKm, seg.returnDurationHours)}
              />
            );
          })}
        </>
      ) : (
        routePositions &&
        routePositions.length > 1 && (
          <Polyline positions={routePositions} pathOptions={{ color: ROUTE_OUTBOUND_COLOR, weight: 4 }} />
        )
      )}
      {polygons?.map((poly) => (
        <Polygon
          key={poly.id}
          positions={poly.positions}
          pathOptions={{ color: poly.color ?? "#7c3aed" }}
        >
          {poly.label && <Tooltip direction="top">{poly.label}</Tooltip>}
        </Polygon>
      ))}
      {points?.map((p) => (
        <Marker
          key={p.id}
          position={p.position}
          icon={p.color ? zoneIcon(p.color, !p.muted) : originIcon(!p.muted)}
          eventHandlers={{
            click: (e) => {
              // Sin esto, el click en el marker también dispara el click
              // del mapa (bubblingMouseEvents es true por defecto en
              // Leaflet) — onMapClick es el mismo handler que "placing"
              // usa para crear un punto nuevo, así que sin cortarlo acá,
              // clickear un punto guardado también intentaría crear uno.
              L.DomEvent.stopPropagation(e);
              onPointClick?.(p);
            },
          }}
        >
          {p.previewImageUrl ? (
            <Tooltip direction="top" className="condorfinder-map-tooltip-image">
              <div className="tooltip-image-wrap">
                <TooltipPreviewImage src={p.previewImageUrl} alt={p.label} />
                {p.previewDetections && p.previewImageSize && (
                  <PreviewDetectionsOverlay
                    detections={p.previewDetections}
                    imageSize={p.previewImageSize}
                  />
                )}
                <div className="tooltip-caption">
                  <div className="tooltip-label">{p.label}</div>
                  {p.previewSubtitle && <div className="tooltip-subtitle">{p.previewSubtitle}</div>}
                </div>
              </div>
            </Tooltip>
          ) : (
            <Tooltip direction="top" className="condorfinder-map-tooltip">
              {p.label}
            </Tooltip>
          )}
        </Marker>
      ))}
    </MapContainer>
  );
}
