import { useEffect, useState } from "react";
import {
  MapContainer,
  TileLayer,
  ZoomControl,
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
import {
  ROUTE_DISPOSAL_COLOR,
  ROUTE_DISPOSAL_OPACITY,
  ROUTE_OUTBOUND_COLOR,
  ROUTE_OUTLINE_COLOR,
  ROUTE_RETURN_COLOR,
  ROUTE_RETURN_OPACITY,
} from "@/components/route-colors";
import {
  MAIPU_BBOX,
  MAIPU_BOUNDARY,
  MAIPU_MASK,
  MAIPU_VIEW_BBOX,
  MAIPU_VIEW_CENTER,
} from "@/lib/maipuBoundary";
import {
  DISPOSAL_PIN,
  DISPOSAL_PLATE,
  ORIGIN_PIN_FILL,
  ORIGIN_PIN_REGULAR,
  ORIGIN_PIN_SIZE,
  ZONE_PIN_FILL,
  ZONE_PIN_REGULAR,
  ZONE_PIN_SIZE,
} from "@/components/map-pins";

/** Encuadre inicial: el casco urbano de Maipú. Ver la nota de
 *  MAIPU_VIEW_CENTER sobre por qué no es el centro geométrico de la comuna.
 *  El mapa NO está acotado, se puede navegar libremente fuera de ella. */
const MAIPU_CENTER = MAIPU_VIEW_CENTER;

// Este módulo solo se carga vía import() dinámico desde GeoMap.tsx, después
// del mount, nunca se evalúa durante SSR. Leaflet toca `window` en el
// top-level de su propio módulo (sin guard), así que fixDefaultIcon() puede
// llamarse directo acá arriba: para cuando este archivo se ejecuta, `window`
// ya existe siempre.
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
  // El tooltipAnchor por defecto de Leaflet es [16, -28], el 16 corrige
  // por la sombra clásica del pin, y sin quererlo descentra cualquier
  // <Tooltip direction="top"> unos px hacia la derecha del ícono.
  tooltipAnchor: [0, -28],
});

// Pines reales (Phosphor "MapPin"/"MapPinArea", regular + fill) en vez de
// las formas de CSS que había antes, se arman como <svg> crudo porque
// Leaflet arma L.divIcon a partir de un string de HTML, no de JSX, asi que los
// trazados entran interpolados. Los dibujos viven en map-pins.ts porque
// GoogleMapImpl.tsx usa los mismos: con una copia en cada implementacion, la
// que no se esta mirando se queda con el pin viejo.

function pinDivIcon(path: string, color: string, size: number): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<svg width="${size}" height="${size}" viewBox="0 0 256 256" fill="${color}" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.45));"><path d="${path}"/></svg>`,
    // El pin "apunta" hacia abajo, el ancla va en la punta inferior del
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
  return pinDivIcon(
    filled ? ZONE_PIN_FILL : ZONE_PIN_REGULAR,
    filled ? color : "var(--muted-foreground)",
    ZONE_PIN_SIZE,
  );
}

// Puntos de origen (HDU6): pin "de área" (silueta con base ovalada en la
// versión fill), mismo criterio sólido=activo/hueco=inactivo que zoneIcon.
function originIcon(active: boolean): L.DivIcon {
  return pinDivIcon(
    active ? ORIGIN_PIN_FILL : ORIGIN_PIN_REGULAR,
    active ? "var(--primary)" : "var(--muted-foreground)",
    ORIGIN_PIN_SIZE,
  );
}

/** El relleno sanitario: placa circular con su nombre impreso, no un pin.
 *
 *  La forma lo distingue de los otros dos marcadores sin necesidad de leyenda:
 *  las zonas y los puntos son gotas, que marcan lugares del plan del día; el
 *  relleno es un círculo, porque es infraestructura fija. Y por eso se ancla en
 *  su CENTRO (`iconAnchor` a la mitad del alto de la placa) y no en una punta
 *  que no tiene. Ver `.disposal-marker` en styles.css para el detalle del
 *  tratamiento. */

function disposalIcon(name: string): L.DivIcon {
  return L.divIcon({
    className: "",
    html:
      `<div class="disposal-marker">` +
      `<span class="disposal-marker__plate">` +
      `<svg viewBox="0 0 256 256" fill="currentColor"><path d="${DISPOSAL_PIN}"/></svg>` +
      `</span>` +
      // El nombre va escapado: hoy es una constante del repositorio, pero el
      // día que el relleno sea un punto de recursos (ver disposalSite.ts) este
      // texto viene de la base y entraría como HTML crudo.
      `<span class="disposal-marker__label">${escapeHtml(name)}</span>` +
      `</div>`,
    // Alto total aproximado (placa + gap + etiqueta) solo para que Leaflet
    // reserve la caja; el centrado real lo hace el flex del contenido.
    iconSize: [DISPOSAL_PLATE, DISPOSAL_PLATE + 18],
    iconAnchor: [DISPOSAL_PLATE / 2, DISPOSAL_PLATE / 2],
  });
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/** Recuadros de detecciones superpuestos sobre la miniatura del tooltip
 *  (HDU5), "png + json" juntos, no solo la imagen plana. slice (no meet):
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
 *  error, si el PNG no carga (404, ej. la zona se eliminó desde otra
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

/** Centra+acerca el mapa a `target` cada vez que cambia, usado tanto al
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
 *  generada), una sola vez cada vez que la referencia del array cambia
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

/** Click en la ruta -> vuelve a encuadrar la ruta COMPLETA (mismo
 *  flyToBounds que FitBounds hace al generarla, no un zoom de acercamiento
 *  a un punto), pensado para volver rápido a "ver toda la ruta" después
 *  de haber hecho zoom/pan manual. En vez de un eventHandlers de click
 *  sobre cada Polyline (poco confiable con el renderer Canvas para líneas
 *  muy largas/finas), escucha el click del MAPA (mismo mecanismo que
 *  ClickHandler arriba, ya probado) y mide la distancia en PÍXELES al
 *  vértice más cercano de cualquiera de los trazos, funciona igual con
 *  canvas o SVG, sin depender del hit-testing de la capa. */
function RouteClickZoom({
  outboundPaths,
  disposalPaths,
  returnPaths,
  onRouteClick,
}: {
  outboundPaths: [number, number][][] | null | undefined;
  disposalPaths: [number, number][][] | null | undefined;
  returnPaths: [number, number][][] | null | undefined;
  /** Índice del recorrido cuyo trazo se apretó. Es el mismo índice de
   *  `routeSegments`, así que la vista puede abrir su detalle. */
  onRouteClick?: (segmentIndex: number) => void;
}) {
  const CLICK_TOLERANCE_PX = 20;
  const map = useMapEvents({
    click(e) {
      // Los TRES tramos del recorrido, en un solo arreglo. Los tres comparten
      // índice con routeSegments (ver el contrato en routePlan.ts), así que se
      // recorren juntos y reportan el mismo número: apretar el tramo de
      // descarga abre el mismo recorrido que apretar la ida.
      const familias = [outboundPaths ?? [], disposalPaths ?? [], returnPaths ?? []];
      if (familias.every((f) => f.length === 0)) return;
      const clickPoint = map.latLngToContainerPoint(e.latlng);

      let closestDist = Infinity;
      let closestIndex = -1;
      for (const familia of familias) {
        for (const [i, path] of familia.entries()) {
          for (const vertex of path) {
            const dist = clickPoint.distanceTo(map.latLngToContainerPoint(vertex));
            if (dist < closestDist) {
              closestDist = dist;
              closestIndex = i;
            }
          }
        }
      }

      if (closestDist <= CLICK_TOLERANCE_PX) {
        // El encuadre abarca los tres tramos: con el relleno al poniente de la
        // comuna, encuadrar solo ida y vuelta dejaba la descarga fuera de
        // pantalla justo después de apretarla.
        map.flyToBounds(L.latLngBounds(familias.flat(2)), {
          padding: [48, 48],
          duration: 0.6,
        });
        if (closestIndex >= 0) onRouteClick?.(closestIndex);
      }
    },
  });
  return null;
}

/** Distancia aproximada (en grados, NO metros) entre dos puntos, alcanza
 *  para repartir proporciones a lo largo de un trazo (pointAtFraction de
 *  abajo), no se usa para mostrar ninguna distancia real al usuario. */
function approxDistance(a: [number, number], b: [number, number]): number {
  const dLat = a[0] - b[0];
  const dLng = a[1] - b[1];
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/** Punto ubicado a `fraction` (0-1) de la distancia ACUMULADA de `path`
 *  (no del índice de vértice), así la ventana flotante queda a un cuarto
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

/** Key estable PERO distinta entre rutas distintas, primer/último punto +
 *  cantidad de vértices. Forzar el remonte completo del Polyline (y de su
 *  ventana flotante) cuando cambia la ruta es la garantía más simple y
 *  robusta contra el problema de arriba (Leaflet no repositiona un
 *  tooltip ya abierto solo porque cambiaron las coordenadas de su capa) ,
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

// Renderer Canvas explícito con más "padding" (buffer alrededor del
// viewport donde Leaflet SÍ dibuja) que el default (0.1 = 10%) -- con una
// polilínea larga (100+ km) y zoom/pan seguidos, el buffer chico dejaba
// tramos de la línea fuera de la zona dibujada, viéndose como cortes/
// líneas blancas justo en el borde de ese buffer. Módulo-level: un solo
// renderer reusado, no uno nuevo por render (recrearlo tira todas las
// capas y las vuelve a dibujar, perdiendo el beneficio de performance).
const ROUTE_CANVAS_RENDERER = L.canvas({ padding: 1 });

/** Ancla una ventana flotante (estilo Google Maps: burbuja + flecha) al
 *  punto ubicado a `fraction` del trazo `path`. Marker invisible +
 *  Tooltip direction="top" en vez de atar el tooltip directo al Polyline:
 *  un Polyline con tooltip "permanent" no recalcula su posición cuando
 *  solo cambian sus coordenadas (setLatLngs no mueve un tooltip ya
 *  abierto) -- por eso, al generar una ruta nueva, la ventana anterior se
 *  quedaba pegada en el lugar de la ruta vieja. Un Marker si sigue su
 *  propia posición correctamente, y la key (más abajo) fuerza además un
 *  remonte completo cuando cambia la ruta, como garantía extra. */
export function GeoMapImpl({
  center = MAIPU_CENTER,
  zoom = 13,
  marker,
  points,
  polygons,
  routePositions,
  outboundPaths,
  disposalPaths,
  returnPaths,
  routeSegments,
  fitBoundsTo,
  onMapClick,
  onPointClick,
  onRouteClick,
  disposalSite,
  focusPoint,
  lockToMaipu,
  className,
}: GeoMapProps) {
  const hasRealPaths =
    (outboundPaths && outboundPaths.length > 0) ||
    (disposalPaths && disposalPaths.length > 0) ||
    (returnPaths && returnPaths.length > 0);
  return (
    // renderer=ROUTE_CANVAS_RENDERER: sin canvas, cada trazo de ruta
    // (potencialmente cientos de vértices en una ruta larga, x2 por el
    // "casing" debajo) se dibuja como SVG -- Leaflet redibuja SVG a mano
    // en cada frame de zoom, y con esa cantidad de puntos el zoom se
    // sentía con lag notorio. Canvas delega el redibujado al navegador y
    // es muchísimo más fluido; los markers (L.divIcon) no se ven
    // afectados, Leaflet los sigue manejando por DOM sin importar esto.
    <MapContainer
      // Con lockToMaipu se encuadra por BOUNDS y no por centro+zoom: "centrado
      // en toda la comuna" es que entre entera en pantalla, y eso depende del
      // tamaño del contenedor, así que un zoom fijo no lo garantiza. Leaflet
      // calcula el zoom que hace calzar la caja.
      // El zoom por defecto de Leaflet va arriba a la izquierda, que es justo
      // donde flota el panel del plan en la vista de rutas: los botones + y -
      // quedaban debajo de la tarjeta, inalcanzables. Abajo a la derecha no
      // choca con nada y es donde lo ponen las herramientas de mapas.
      zoomControl={false}
      {...(lockToMaipu
        ? {
            // Abre sobre el casco urbano, no sobre la comuna entera (ver
            // MAIPU_VIEW_BBOX). El paneo sigue limitado por MAIPU_BBOX, asi
            // que no se pierde nada: solo cambia desde dónde se empieza a
            // mirar.
            bounds: MAIPU_VIEW_BBOX,
            // El límite de paneo lleva MARGEN: la caja de la comuna ensanchada
            // un 30%. Ceñido exactamente a la comuna, mirar un punto del borde
            // era imposible porque el pin quedaba pegado al canto de la
            // pantalla, y acercarse a una calle del límite dejaba media vista
            // bloqueada. Con el margen se puede asomar a los alrededores, pero
            // no irse a otra región.
            maxBounds: L.latLngBounds(MAIPU_BBOX).pad(0.3),
            // Borde rígido, no elástico: con viscosidad menor a 1 el mapa se
            // deja arrastrar fuera y vuelve solo, lo que se lee como que la
            // restricción falla en vez de existir.
            maxBoundsViscosity: 1,
            // Sin esto se puede alejar hasta ver el continente: maxBounds
            // limita el paneo, no el zoom.
            minZoom: 12,
          }
        : { center, zoom })}
      className={className}
      scrollWheelZoom
      renderer={ROUTE_CANVAS_RENDERER}
    >
      <ZoomControl position="bottomright" />
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {/* Límite comunal de Maipú, siempre visible, debajo de todo lo demás.
          Da la referencia de qué territorio administra el municipio. Que se
          pueda navegar fuera de él o no lo decide lockToMaipu, no este dibujo:
          el polígono es la referencia visual, la restricción es del
          contenedor.

          Son DOS capas: la máscara que atenúa lo de afuera y, encima, el
          contorno exacto. Antes era una sola línea punteada, y el problema no
          era el estilo del trazo: un borde obliga a recorrerlo con la vista
          para saber qué queda adentro, y sobre un mapa lleno de calles se
          pierde. Atenuando el afuera, la comuna queda iluminada y la
          pertenencia se lee sin buscarla. Es lo que hacen ArcGIS y Mapbox.

          interactive={false} en las DOS, y acá es más crítico que antes: la
          máscara cubre el mundo entero, así que si tomara eventos se quedaría
          con todos los clicks con que recursos.tsx crea un punto, no solo con
          los de adentro de la comuna.

          Los colores van en hexadecimal literal y NO como var(--primary): este
          mapa dibuja los trazos con el renderer de canvas (ver el comentario
          de ROUTE_CANVAS_RENDERER más abajo), y una variable CSS no se
          resuelve al asignarla a ctx.fillStyle, se descarta en silencio y sale
          del color que hubiera quedado. Es el mismo motivo por el que
          route-colors.ts guarda literales. */}
      <Polygon
        positions={MAIPU_MASK}
        interactive={false}
        pathOptions={{
          // Sin trazo: el contorno lo pone la capa de abajo. Si esta lo
          // dibujara, también trazaría el anillo mundial.
          stroke: false,
          fill: true,
          fillColor: "#0F2244", // --primary
          // Suficiente para separar adentro de afuera, poco para que el mapa
          // base siga siendo legible fuera de la comuna: el recorrido hacia el
          // relleno sanitario sale de Maipú y hay que poder seguirlo.
          fillOpacity: 0.22,
        }}
      />
      <Polygon
        positions={MAIPU_BOUNDARY}
        interactive={false}
        pathOptions={{
          color: "#0F2244", // --primary
          weight: 1.5,
          opacity: 0.9,
          fill: false,
        }}
      />

      <ClickHandler onMapClick={onMapClick} />
      <FlyToPoint target={focusPoint ?? null} />
      <FitBounds points={fitBoundsTo ?? null} />
      <RouteClickZoom
        outboundPaths={outboundPaths}
        disposalPaths={disposalPaths}
        returnPaths={returnPaths}
        onRouteClick={onRouteClick}
      />
      {marker && <Marker position={marker} />}
      {hasRealPaths ? (
        <>
          {/* Borde oscuro debajo de ambos trazos ("casing"), separa la
              línea del fondo del mapa sin importar qué colores tenga
              debajo (antes el celeste/naranjo original se camuflaba
              contra el agua y las calles de los tiles de OSM). */}
          {outboundPaths?.map((path, i) => (
            <Polyline
              key={`outbound-outline-${pathKey(path as [number, number][])}-${i}`}
              positions={path as [number, number][]}
              pathOptions={{ color: ROUTE_OUTLINE_COLOR, weight: 8, opacity: 0.5 }}
            />
          ))}
          {disposalPaths?.map((path, i) => (
            <Polyline
              key={`disposal-outline-${pathKey(path as [number, number][])}-${i}`}
              positions={path as [number, number][]}
              pathOptions={{ color: ROUTE_OUTLINE_COLOR, weight: 8, opacity: 0.5 }}
            />
          ))}
          {returnPaths?.map((path, i) => (
            <Polyline
              key={`return-outline-${pathKey(path as [number, number][])}-${i}`}
              positions={path as [number, number][]}
              pathOptions={{ color: ROUTE_OUTLINE_COLOR, weight: 8, opacity: 0.5 }}
            />
          ))}
          {/* Ida, trazo real (calles, OSRM), azul sólido (estilo Google
              Maps). Ventana flotante anclada al 25% del recorrido, con
              camiones/tiempo/distancia/velocidad de ESTE tramo, mismo
              índice que routeSegments. Click en la línea -> zoom ahí. */}
          {outboundPaths?.map((path, i) => {
            const key = `outbound-${pathKey(path as [number, number][])}-${i}`;
            return (
              <Polyline
                key={key}
                positions={path as [number, number][]}
                pathOptions={{ color: ROUTE_OUTBOUND_COLOR, weight: 5 }}
              />
            );
          })}
          {/* Acá iban unas burbujas permanentes sobre cada trazo, con los
              camiones, la distancia, el tiempo y la velocidad media. Se
              eliminaron: son etiquetas fijas encima del mapa que tapan calles
              justo en el recorrido que hay que leer, y todo lo que decían está
              ahora en la línea de tiempo del panel, donde cada tramo tiene su
              propia fila y no compite con la cartografía. */}
          {/* Descarga: de la última zona al relleno sanitario. Sale de la
              familia azul a propósito, en el teal de --disposal, porque no es
              "la misma ruta en el otro sentido": es el único tramo que el
              camión hace CARGADO (el único al que routing.py le aplica
              _LOADED_SPEED_FACTOR) y el único que no empieza ni termina en el
              patio. Pintado del mismo azul, el recorrido parecía ir y volver
              de la base, que es justo la geometría equivocada que esto vino a
              corregir. */}
          {disposalPaths?.map((path, i) => {
            const key = `disposal-${pathKey(path as [number, number][])}-${i}`;
            return (
              <Polyline
                key={key}
                positions={path as [number, number][]}
                pathOptions={{
                  color: ROUTE_DISPOSAL_COLOR,
                  weight: 5,
                  opacity: ROUTE_DISPOSAL_OPACITY,
                }}
              />
            );
          })}
          {/* Vuelta del relleno al patio, vacío. Mismo azul que la ida, más
              claro y semitransparente, sin punteado (estilo Google Maps: mismo
              color de ruta, dos sentidos). */}
          {returnPaths?.map((path, i) => {
            const key = `return-${pathKey(path as [number, number][])}-${i}`;
            return (
              <Polyline
                key={key}
                positions={path as [number, number][]}
                pathOptions={{
                  color: ROUTE_RETURN_COLOR,
                  weight: 5,
                  opacity: ROUTE_RETURN_OPACITY,
                }}
              />
            );
          })}
        </>
      ) : (
        routePositions &&
        routePositions.length > 1 && (
          <Polyline
            positions={routePositions}
            pathOptions={{ color: ROUTE_OUTBOUND_COLOR, weight: 4 }}
          />
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
      {/* El sitio de disposición, debajo de los demás marcadores en el orden
          de dibujo porque es contexto permanente del territorio, no algo que se
          elija. No es clickeable por la misma razón. */}
      {disposalSite && (
        // Sin Tooltip: el nombre ya va impreso en la placa, así que un tooltip
        // al pasar el mouse repetiría el mismo texto sobre el texto, y además
        // el marcador es interactive={false} y no recibe el hover.
        <Marker
          position={disposalSite.position}
          icon={disposalIcon(disposalSite.name)}
          interactive={false}
        />
      )}
      {points?.map((p) => (
        <Marker
          key={p.id}
          position={p.position}
          icon={p.color ? zoneIcon(p.color, !p.muted) : originIcon(!p.muted)}
          eventHandlers={{
            click: (e) => {
              // Sin esto, el click en el marker también dispara el click
              // del mapa (bubblingMouseEvents es true por defecto en
              // Leaflet), onMapClick es el mismo handler que "placing"
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
