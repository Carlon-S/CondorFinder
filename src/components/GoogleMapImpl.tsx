import { useEffect, useState } from "react";
import {
  AdvancedMarker,
  APIProvider,
  Map as GoogleMap,
  useMap,
  useMapsLibrary,
} from "@vis.gl/react-google-maps";
import type { GeoMapPoint, GeoMapProps } from "@/components/GeoMap";
import {
  ROUTE_DISPOSAL_COLOR,
  ROUTE_DISPOSAL_OPACITY,
  ROUTE_OUTBOUND_COLOR,
  ROUTE_OUTLINE_COLOR,
  ROUTE_RETURN_COLOR,
  ROUTE_RETURN_OPACITY,
} from "@/components/route-colors";
import {
  DISPOSAL_PIN,
  ORIGIN_PIN_FILL,
  ORIGIN_PIN_REGULAR,
  ORIGIN_PIN_SIZE,
  ZONE_PIN_FILL,
  ZONE_PIN_REGULAR,
  ZONE_PIN_SIZE,
} from "@/components/map-pins";
import {
  MAIPU_BBOX,
  MAIPU_BOUNDARY,
  MAIPU_MASK,
  MAIPU_VIEW_BBOX,
  MAIPU_VIEW_CENTER,
} from "@/lib/maipuBoundary";

// =============================================================================
// CONDORFINDER — MAPA CON GOOGLE MAPS
// Archivo: src/components/GoogleMapImpl.tsx
//
// La otra implementación de `GeoMapProps`, junto a GeoMapImpl.tsx (Leaflet).
// Cuál se carga lo decide `VITE_MAPS_PROVIDER` en GeoMap.tsx; sin esa variable
// sigue siendo Leaflet, que es gratis y no necesita clave.
//
// **Esta es la única pieza del sistema que llama a Google desde el NAVEGADOR**,
// y no hay alternativa: el Maps JavaScript API corre en el cliente por
// definición. Por eso su clave es otra, restringida por referente HTTP y no por
// IP, y por eso tiene su propia cuota diaria: una restricción por referente se
// falsifica, así que el tope es la defensa real.
//
// Se cobra POR CARGA DE MAPA (SKU `FAF4-3B2D-51B2`, 10.000 gratis al mes), o
// sea cada vez que se instancia el mapa: abrir /rutas, abrir /recursos, un F5.
// **El zoom, el paneo, los marcadores, los polígonos y la capa de tráfico no
// cuestan nada.** El riesgo real no es el uso en producción sino el hot reload
// durante el desarrollo visual: cada guardado puede remontar el mapa. Si vas a
// pasar una tarde ajustando estilos, dejá `VITE_MAPS_PROVIDER` sin definir y
// trabajá contra Leaflet.
//
// Los dibujos de los pines salen de map-pins.ts, compartidos con la
// implementación de Leaflet, y las clases CSS son las mismas: el cambio de
// motor no debería cambiar cómo se ve nada.
// =============================================================================

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? "";
// Los marcadores avanzados exigen un Map ID. `DEMO_MAP_ID` es el de Google para
// pruebas: funciona, pero imprime un aviso en consola y no admite estilos
// propios. Para producción conviene crear uno en la consola y ponerlo acá.
const MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_ID ?? "DEMO_MAP_ID";

/** Cuántos niveles de zoom al volar a un punto, mismo valor que el de Leaflet
 *  para que cambiar de motor no cambie cuánto se acerca. */
const ZOOM_FOCO = 16;

function aLatLng(p: [number, number]): google.maps.LatLngLiteral {
  return { lat: p[0], lng: p[1] };
}

// =============================================================================
// CAPAS IMPERATIVAS
//
// Google Maps no tiene componentes React para polígonos ni polilíneas, así que
// van por `useMap()` y un efecto que crea y limpia. El patrón se repite: crear
// en el efecto, devolver una función que llama a setMap(null). Sin esa limpieza
// cada render dejaría el trazo anterior dibujado debajo del nuevo.
// =============================================================================

/** La máscara que atenúa todo lo que no es Maipú, más el contorno exacto.
 *
 *  Google representa un polígono con agujeros igual que Leaflet: el primer
 *  anillo es el contorno exterior y los siguientes son huecos. Por eso
 *  MAIPU_MASK sirve sin convertir nada.
 *
 *  `clickable: false` en las dos, y acá es crítico: la máscara cubre el mundo
 *  entero, así que si tomara eventos se quedaría con TODOS los clics con que
 *  recursos.tsx crea un punto. */
function CapasDeMaipu() {
  const map = useMap();
  const maps = useMapsLibrary("maps");

  useEffect(() => {
    if (!map || !maps) return;
    const mascara = new maps.Polygon({
      paths: MAIPU_MASK.map((anillo) => anillo.map(aLatLng)),
      strokeWeight: 0,
      fillColor: "#0F2244",
      fillOpacity: 0.22,
      clickable: false,
      zIndex: 1,
      map,
    });
    const contorno = new maps.Polygon({
      paths: MAIPU_BOUNDARY.map(aLatLng),
      strokeColor: "#0F2244",
      strokeWeight: 1.5,
      strokeOpacity: 0.9,
      fillOpacity: 0,
      clickable: false,
      zIndex: 2,
      map,
    });
    return () => {
      mascara.setMap(null);
      contorno.setMap(null);
    };
  }, [map, maps]);

  return null;
}

/** La congestión en vivo sobre las calles, con los colores de Google.
 *
 *  **Es gratis**: viene incluida en la carga del mapa, no es una llamada
 *  aparte. Es la razón por la que esta migración responde la pregunta "dónde
 *  hay taco" sin pasar a `Compute Routes Enterprise`, que es lo que costaría
 *  pintar la congestión sobre el propio trazo de la ruta. */
function TraficoEnVivo({ activa }: { activa: boolean }) {
  const map = useMap();
  const maps = useMapsLibrary("maps");

  useEffect(() => {
    if (!map || !maps || !activa) return;
    const capa = new maps.TrafficLayer({ map });
    return () => capa.setMap(null);
  }, [map, maps, activa]);

  return null;
}

/** Los polígonos georreferenciados de HDU5 (basurales detectados). */
function Poligonos({ polygons }: { polygons: GeoMapProps["polygons"] }) {
  const map = useMap();
  const maps = useMapsLibrary("maps");

  useEffect(() => {
    if (!map || !maps || !polygons?.length) return;
    const dibujados = polygons.map(
      (p) =>
        new maps.Polygon({
          paths: p.positions.map(aLatLng),
          strokeColor: p.color ?? ROUTE_OUTBOUND_COLOR,
          strokeWeight: 2,
          fillColor: p.color ?? ROUTE_OUTBOUND_COLOR,
          fillOpacity: 0.35,
          clickable: false,
          zIndex: 3,
          map,
        }),
    );
    return () => dibujados.forEach((d) => d.setMap(null));
  }, [map, maps, polygons]);

  return null;
}

/** Los trazos de la ruta: ida, descarga y regreso, cada uno con su estilo.
 *
 *  Cada tramo son DOS polilíneas superpuestas: una gruesa oscura abajo y la de
 *  color encima. Es lo mismo que hace la implementación de Leaflet, y existe
 *  porque un trazo de color plano sobre un mapa lleno de calles de colores se
 *  pierde; el contorno lo despega del fondo.
 *
 *  El clic abarca los tres tramos del mismo recorrido, no solo la ida: el
 *  relleno sanitario queda lejos de las zonas y quien aprieta ahí espera abrir
 *  el mismo detalle. */
function Trazos({
  outboundPaths,
  disposalPaths,
  returnPaths,
  routePositions,
  onRouteClick,
}: Pick<
  GeoMapProps,
  "outboundPaths" | "disposalPaths" | "returnPaths" | "routePositions" | "onRouteClick"
>) {
  const map = useMap();
  const maps = useMapsLibrary("maps");

  useEffect(() => {
    if (!map || !maps) return;
    const creadas: google.maps.Polyline[] = [];

    const trazar = (
      camino: [number, number][],
      color: string,
      opacidad: number,
      indice: number | null,
    ) => {
      const path = camino.map(aLatLng);
      creadas.push(
        new maps.Polyline({
          path,
          strokeColor: ROUTE_OUTLINE_COLOR,
          strokeOpacity: 0.9,
          strokeWeight: 9,
          clickable: false,
          zIndex: 4,
          map,
        }),
      );
      const linea = new maps.Polyline({
        path,
        strokeColor: color,
        strokeOpacity: opacidad,
        strokeWeight: 5,
        clickable: indice !== null && !!onRouteClick,
        zIndex: 5,
        map,
      });
      if (indice !== null && onRouteClick) {
        linea.addListener("click", () => onRouteClick(indice));
      }
      creadas.push(linea);
    };

    if (outboundPaths?.length) {
      outboundPaths.forEach((c, i) => trazar(c, ROUTE_OUTBOUND_COLOR, 1, i));
      disposalPaths?.forEach((c, i) => trazar(c, ROUTE_DISPOSAL_COLOR, ROUTE_DISPOSAL_OPACITY, i));
      returnPaths?.forEach((c, i) => trazar(c, ROUTE_RETURN_COLOR, ROUTE_RETURN_OPACITY, i));
    } else if (routePositions?.length) {
      // Respaldo: línea recta entre paradas cuando todavía no hay geometría
      // real. No es clickeable porque no representa un recorrido calculado.
      trazar(routePositions, ROUTE_OUTBOUND_COLOR, 1, null);
    }

    return () => creadas.forEach((p) => p.setMap(null));
  }, [map, maps, outboundPaths, disposalPaths, returnPaths, routePositions, onRouteClick]);

  return null;
}

/** Encuadra el conjunto de puntos cada vez que cambia. Necesita dos o más:
 *  con uno solo, `fitBounds` haría un acercamiento máximo que desorienta. */
function Encuadre({ points }: { points: [number, number][] | null | undefined }) {
  const map = useMap();
  const maps = useMapsLibrary("core");

  useEffect(() => {
    if (!map || !maps || !points || points.length < 2) return;
    const caja = new maps.LatLngBounds();
    points.forEach((p) => caja.extend(aLatLng(p)));
    map.fitBounds(caja, 48);
  }, [map, maps, points]);

  return null;
}

/** Vuela a un punto cuando el padre lo pide (clic en una fila, deep link). */
function VueloAPunto({ target }: { target: [number, number] | null | undefined }) {
  const map = useMap();

  useEffect(() => {
    if (!map || !target) return;
    map.panTo(aLatLng(target));
    if ((map.getZoom() ?? 0) < ZOOM_FOCO) map.setZoom(ZOOM_FOCO);
  }, [map, target]);

  return null;
}

// =============================================================================
// MARCADORES
//
// `AdvancedMarker` acepta JSX como contenido, así que los pines son los mismos
// SVG que dibuja la implementación de Leaflet y las tarjetas de hover se
// escriben en React en vez de como HTML interpolado en un string. Es la parte
// donde este motor es más cómodo que el otro.
// =============================================================================

function PinSvg({ path, color, size }: { path: string; color: string; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill={color}
      style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.45))" }}
    >
      <path d={path} />
    </svg>
  );
}

/** La miniatura de la tarjeta de hover, con su propio manejo de error: si el
 *  PNG no carga (la zona se borró desde otra pestaña) se ve un aviso en vez de
 *  un ícono roto. Estado propio por marcador, porque que uno falle no debe
 *  afectar a los demás. */
function MiniaturaPrevia({ src, alt }: { src: string; alt: string }) {
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

/** Los recuadros de detección sobre la miniatura: el "png + json" juntos, no
 *  solo la imagen plana.
 *
 *  `slice` y no `meet`: tiene que recortar igual que el `object-fit: cover` de
 *  la imagen de abajo, o los rectángulos quedarían corridos respecto de lo que
 *  realmente se ve.
 *
 *  Componente propio y no JSX en línea para que el tamaño natural llegue como
 *  prop ya definida: la comprobación de tipos del JSX no atraviesa el callback
 *  del `map()`. */
function DeteccionesPrevias({
  detections,
  imageSize,
}: {
  detections: NonNullable<GeoMapPoint["previewDetections"]>;
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

/** Un marcador de zona o de punto, con su tarjeta al pasar el mouse.
 *
 *  La tarjeta aparece por CSS (`group-hover`) y no por estado de React: con
 *  estado, mover el mouse por un mapa con veinte zonas dispararía un render por
 *  cada entrada y salida. */
function MarcadorConPrevia({
  punto,
  onClick,
}: {
  punto: GeoMapPoint;
  onClick?: (p: GeoMapPoint) => void;
}) {
  const esZona = !!punto.color;
  const size = esZona ? ZONE_PIN_SIZE : ORIGIN_PIN_SIZE;
  const path = esZona
    ? punto.muted
      ? ZONE_PIN_REGULAR
      : ZONE_PIN_FILL
    : punto.muted
      ? ORIGIN_PIN_REGULAR
      : ORIGIN_PIN_FILL;
  const color = punto.muted ? "var(--muted-foreground)" : (punto.color ?? "var(--primary)");

  return (
    <AdvancedMarker
      position={aLatLng(punto.position)}
      onClick={onClick ? () => onClick(punto) : undefined}
      title={punto.previewImageUrl ? undefined : punto.label}
    >
      {/* El pin se ancla por su punta inferior, igual que en Leaflet: un pin
          apunta hacia abajo y tiene que quedar clavado en la coordenada, no
          flotando sobre ella. AdvancedMarker centra por omisión, así que el
          translate lo corrige. */}
      <div
        className="group relative"
        style={{ transform: `translateY(${size / 2 - 2}px)`, cursor: onClick ? "pointer" : "" }}
      >
        <PinSvg path={path} color={color} size={size} />

        {/* El tamaño natural se saca a una constante para que TypeScript lo vea
            definido dentro del map() de abajo: la comprobación del JSX no
            atraviesa el callback. */}
        {punto.previewImageUrl ? (
          <div className="condorfinder-map-tooltip-image pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 group-hover:block">
            <div className="tooltip-preview">
              <MiniaturaPrevia src={punto.previewImageUrl} alt={punto.label} />
              {punto.previewDetections && punto.previewImageSize && (
                <DeteccionesPrevias
                  detections={punto.previewDetections}
                  imageSize={punto.previewImageSize}
                />
              )}
            </div>
            <strong>{punto.label}</strong>
            {punto.previewSubtitle && <span>{punto.previewSubtitle}</span>}
          </div>
        ) : null}
      </div>
    </AdvancedMarker>
  );
}

// =============================================================================
// EL COMPONENTE
// =============================================================================

export function GoogleMapImpl({
  center,
  zoom,
  marker,
  points,
  polygons,
  routePositions,
  outboundPaths,
  disposalPaths,
  returnPaths,
  fitBoundsTo,
  onRouteClick,
  disposalSite,
  onMapClick,
  onPointClick,
  focusPoint,
  lockToMaipu,
  className,
}: GeoMapProps) {
  if (!API_KEY) {
    // No debería llegar acá: GeoMap.tsx solo elige esta implementación cuando
    // hay clave. Queda como red por si alguien la importa directo.
    return (
      <div
        className={`flex items-center justify-center bg-muted/40 text-xs text-muted-foreground ${className ?? ""}`}
      >
        Falta VITE_GOOGLE_MAPS_API_KEY
      </div>
    );
  }

  const encuadreInicial = lockToMaipu ? MAIPU_BBOX : MAIPU_VIEW_BBOX;

  return (
    <div className={className}>
      <APIProvider apiKey={API_KEY}>
        <GoogleMap
          mapId={MAP_ID}
          defaultCenter={aLatLng(center ?? MAIPU_VIEW_CENTER)}
          defaultZoom={zoom ?? 13}
          defaultBounds={
            center
              ? undefined
              : {
                  south: encuadreInicial[0][0],
                  west: encuadreInicial[0][1],
                  north: encuadreInicial[1][0],
                  east: encuadreInicial[1][1],
                }
          }
          // Mismo criterio que el mapa de Leaflet: el zoom va abajo a la
          // derecha, porque arriba a la izquierda está el panel.
          zoomControlOptions={{ position: 9 }}
          mapTypeControl={false}
          streetViewControl={false}
          fullscreenControl={false}
          // lockToMaipu: encuadra la comuna y no deja salir de ella. Es opt-in,
          // no el comportamiento por omisión: en /rutas el recorrido sale de
          // Maipú hacia el relleno y recortarlo escondería tramos.
          restriction={
            lockToMaipu
              ? {
                  latLngBounds: {
                    south: MAIPU_BBOX[0][0] - 0.03,
                    west: MAIPU_BBOX[0][1] - 0.03,
                    north: MAIPU_BBOX[1][0] + 0.03,
                    east: MAIPU_BBOX[1][1] + 0.03,
                  },
                  strictBounds: false,
                }
              : undefined
          }
          minZoom={lockToMaipu ? 12 : undefined}
          onClick={
            onMapClick
              ? (e) => {
                  const ll = e.detail.latLng;
                  if (ll) onMapClick(ll.lat, ll.lng);
                }
              : undefined
          }
          style={{ width: "100%", height: "100%" }}
        >
          <CapasDeMaipu />
          {/* Solo donde hay una ruta que leer: en la vista de recursos el
              tráfico sería ruido sobre una tarea de configuración. */}
          <TraficoEnVivo activa={!!outboundPaths?.length || !!routePositions?.length} />
          <Poligonos polygons={polygons} />
          <Trazos
            outboundPaths={outboundPaths}
            disposalPaths={disposalPaths}
            returnPaths={returnPaths}
            routePositions={routePositions}
            onRouteClick={onRouteClick}
          />
          <Encuadre points={fitBoundsTo} />
          <VueloAPunto target={focusPoint} />

          {/* El punto que se está creando o editando. No convive con `points`:
              son modos distintos de la misma vista. */}
          {marker && (
            <AdvancedMarker position={aLatLng(marker)}>
              <div style={{ transform: `translateY(${ORIGIN_PIN_SIZE / 2 - 2}px)` }}>
                <PinSvg path={ORIGIN_PIN_FILL} color="var(--primary)" size={ORIGIN_PIN_SIZE} />
              </div>
            </AdvancedMarker>
          )}

          {points?.map((p) => (
            <MarcadorConPrevia key={p.id} punto={p} onClick={onPointClick} />
          ))}

          {/* El relleno sanitario: placa circular con el nombre impreso, no un
              pin, y anclada en su CENTRO. La forma informa: zonas y puntos son
              gotas que marcan lugares del plan del día; el relleno es un
              círculo porque es infraestructura fija. No es clickeable: es a
              dónde va el material, no algo que el trabajador elija. */}
          {disposalSite && (
            <AdvancedMarker position={aLatLng(disposalSite.position)} clickable={false}>
              <div className="disposal-marker">
                <span className="disposal-marker__plate">
                  <svg viewBox="0 0 256 256" fill="currentColor">
                    <path d={DISPOSAL_PIN} />
                  </svg>
                </span>
                <span className="disposal-marker__label">{disposalSite.name}</span>
              </div>
            </AdvancedMarker>
          )}
        </GoogleMap>
      </APIProvider>
    </div>
  );
}
