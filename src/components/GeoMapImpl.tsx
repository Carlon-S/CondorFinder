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

// Ícono grande de círculo de color — para marcar zonas (HDU5) con
// "precisión espectacular" pero visualmente distintas de los pines de
// puntos de origen (HDU6). DivIcon en vez de L.Icon: se puede colorear por
// CSS sin depender de un PNG por color.
//
// filled=false ("no activo": zona no sumada a la ruta, o punto inactivo) se
// dibuja HUECO (relleno transparente, solo borde de color) en vez de bajar
// la opacidad del ícono entero — la opacidad no se distinguía bien apenas
// se solapaba con las capas del mapa; sólido-vs-hueco es un patrón mucho
// más reconocible ("marcado" vs "sin marcar").
function zoneIcon(color: string, filled: boolean): L.DivIcon {
  const fillStyle = filled
    ? `background:${color};border:3px solid white;`
    : `background:rgba(255,255,255,0.6);border:3px solid ${color};`;
  return L.divIcon({
    className: "",
    html: `<div style="width:28px;height:28px;border-radius:9999px;${fillStyle}box-shadow:0 2px 8px rgba(0,0,0,0.4);"></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    tooltipAnchor: [0, -18],
  });
}

// Ícono cuadrado (esquinas redondeadas) para puntos de origen (HDU6) — forma
// distinta a los círculos de zonas (HDU5) para poder diferenciarlos de un
// vistazo aunque estén juntos en el mismo mapa (ej. /rutas). Mismo patrón
// sólido-vs-hueco que zoneIcon para distinguir activo/inactivo.
function originIcon(active: boolean): L.DivIcon {
  const fillStyle = active
    ? "background:var(--primary);border:3px solid white;"
    : "background:rgba(255,255,255,0.6);border:2.5px solid var(--muted-foreground);";
  return L.divIcon({
    className: "",
    html: `<div style="width:22px;height:22px;border-radius:6px;${fillStyle}box-shadow:0 2px 8px rgba(0,0,0,0.35);"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    tooltipAnchor: [0, -15],
  });
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
  return <img src={src} alt={alt} onError={() => setError(true)} />;
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

export function GeoMapImpl({
  center = MAIPU_CENTER,
  zoom = 13,
  marker,
  points,
  polygons,
  routePositions,
  onMapClick,
  onPointClick,
  focusPoint,
  className,
}: GeoMapProps) {
  return (
    <MapContainer center={center} zoom={zoom} className={className} scrollWheelZoom>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ClickHandler onMapClick={onMapClick} />
      <FlyToPoint target={focusPoint ?? null} />
      {marker && <Marker position={marker} />}
      {routePositions && routePositions.length > 1 && (
        <Polyline positions={routePositions} pathOptions={{ color: "#0ea5e9", weight: 4 }} />
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
