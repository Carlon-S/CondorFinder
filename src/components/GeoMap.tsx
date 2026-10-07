import { useEffect, useState, type ComponentType } from "react";

export interface GeoMapPoint {
  id: string;
  position: [number, number];
  label: string;
  /** Si viene, el marker se dibuja como un círculo grande de este color en
   *  vez del pin por defecto — ej. zonas de basural cargadas (HDU5), para
   *  distinguirlas visualmente de los puntos (HDU6). */
  color?: string;
  /** Marca el punto como "no activo/no incluido" (ej. un punto
   *  desactivado, o una zona todavía no sumada a la ruta) con un ícono hueco
   *  (relleno transparente, solo borde) en vez del ícono sólido normal — la
   *  opacidad sola no se distinguía bien sobre las capas del mapa. Default false. */
  muted?: boolean;
  /** Si viene, el tooltip al pasar el mouse muestra esta imagen (ej. el
   *  mapa unificado de la zona) en vez de solo el texto de `label`. */
  previewImageUrl?: string;
  /** Línea de datos extra bajo el nombre en el tooltip con imagen (ej.
   *  volumen/peso/cantidad de zonas) — solo tiene efecto junto a `previewImageUrl`. */
  previewSubtitle?: string;
  /** Dimensiones naturales (px) de `previewImageUrl` — necesarias para que
   *  `previewDetections` (coordenadas de píxel sobre esa imagen) se dibuje
   *  alineado encima, igual que el "zoom" completo. */
  previewImageSize?: { w: number; h: number };
  /** Recuadros de detecciones (coordenadas de píxel sobre `previewImageUrl`)
   *  a dibujar superpuestos en el tooltip — el "png + json" junto, no solo
   *  la imagen plana. */
  previewDetections?: {
    id: number;
    bbox: { minx: number; miny: number; maxx: number; maxy: number };
    color: string;
  }[];
}

/** Un polígono georreferenciado (HDU5) — ej. un basural detectado, ya
 *  reproyectado a WGS84 por src/lib/projection.ts antes de llegar acá. */
export interface GeoMapPolygon {
  id: string;
  positions: [number, number][];
  color?: string;
  label?: string;
}

/** Resumen de una sub-ruta (HDU5/AC2) — mismo índice que outboundPaths[i]/
 *  returnPaths[i], para la ventana flotante sobre cada tramo (estilo
 *  Google Maps: camiones, tiempo, distancia; la velocidad se calcula acá
 *  mismo como distancia/tiempo, no viaja aparte). */
export interface GeoMapRouteSegment {
  originName: string;
  trucksUsed: number;
  outboundDistanceKm: number;
  outboundDurationHours: number;
  returnDistanceKm: number;
  returnDurationHours: number;
}

export interface GeoMapProps {
  center?: [number, number];
  zoom?: number;
  /** El punto único que se está creando/editando — no se muestra junto a `points`, son modos distintos. */
  marker?: [number, number] | null;
  /** Puntos ya guardados, todos a la vez (HDU6/AC4). */
  points?: GeoMapPoint[];
  /** Polígonos georreferenciados, todos a la vez (HDU5). */
  polygons?: GeoMapPolygon[];
  /** Trazo de la ruta generada (HDU5/AC2) — fallback simple (línea recta
   *  entre paradas) cuando no hay geometría real todavía. */
  routePositions?: [number, number][] | null;
  /** Trazos reales (calles, vía OSRM) de ida/vuelta de cada sub-ruta —
   *  cuando vienen, se pintan en vez de routePositions, cada uno con su
   *  propio estilo (ver GeoMapImpl.tsx). */
  outboundPaths?: [number, number][][] | null;
  /** Las transiciones entre zonas consecutivas, todas juntas. Se pintan con su
   *  propio color: es donde el camión va cargando, y metidas dentro de la ida
   *  un recorrido de varias paradas era una sola mancha. */
  transferPaths?: [number, number][][] | null;
  /** Tramo de la última zona al relleno sanitario, el único que el camión hace
   *  cargado. Mismo índice que los otros dos. Separado para poder pintarlo
   *  distinto: no es "la misma ruta en el otro sentido". */
  disposalPaths?: [number, number][][] | null;
  returnPaths?: [number, number][][] | null;
  /** Mismo índice que outboundPaths/returnPaths -- datos para la ventana
   *  flotante de cada tramo. */
  routeSegments?: GeoMapRouteSegment[] | null;
  /** Puntos a encuadrar (zoom+centrado automático) cada vez que cambian —
   *  ej. todos los puntos de los trazos de una ruta recién generada, para
   *  que quede completa en pantalla sin que el trabajador tenga que hacer
   *  zoom out a mano. Necesita 2+ puntos; con menos no hace nada. */
  fitBoundsTo?: [number, number][] | null;
  /** Clic sobre el trazo de un recorrido, con su índice en `routeSegments`. */
  onRouteClick?: (segmentIndex: number) => void;
  /** Sitio de disposición final, dibujado como contexto permanente. No es
   *  clickeable: es a dónde va el material, no algo que el trabajador elija. */
  disposalSite?: { name: string; position: [number, number] } | null;
  onMapClick?: (lat: number, lng: number) => void;
  /** Click en un marker de `points` — el padre decide qué hacer (ej. setSelectedPoint). */
  onPointClick?: (point: GeoMapPoint) => void;
  /** Punto al que el mapa debe centrarse+acercarse — controlado por el
   *  padre, no por GeoMap: así tanto un click real como un deep-link
   *  (?point=id) disparan el mismo vuelo. */
  focusPoint?: [number, number] | null;
  /** Encuadra la comuna completa al abrir y NO deja salir de ella: ni
   *  arrastrando ni alejando el zoom.
   *
   *  Es opt-in y no el comportamiento por omisión a propósito. Esta
   *  restricción existió antes para los dos mapas y se quitó por pedido
   *  expreso; ahora vuelve solo donde se pidió, que es la vista de recursos.
   *  El mapa de rutas sigue libre, porque ahí se mira el trazo completo de un
   *  recorrido y recortarlo al límite comunal escondería tramos. */
  lockToMaipu?: boolean;
  className?: string;
}

/**
 * Mapa geográfico real (Leaflet + tiles de OpenStreetMap): a diferencia del
 * visor de analysis.tsx, aquí las coordenadas son lat/lng reales, no píxeles
 * de una imagen puntual de una zona. Pensado como pieza base compartida
 * entre HDU5 (mostrar polígonos georreferenciados) y HDU6 (ubicar puntos
 * de origen).
 *
 * Leaflet toca `window` en el top-level de su propio módulo, sin ningún
 * guard — un import ESTÁTICO de "leaflet"/"react-leaflet" revienta el SSR
 * en Node apenas Vite evalúa el módulo, sin que importe si el render está
 * condicionado a un guard de "mounted" (eso solo protege el render, no el
 * import). Por eso la implementación real vive en GeoMapImpl.tsx y se carga
 * acá vía import() dinámico dentro de un useEffect: así el import mismo
 * ocurre después del mount, solo en el cliente, y nunca durante SSR.
 */
/** Con qué motor se dibuja el mapa.
 *
 *  Sin `VITE_MAPS_PROVIDER=google` (o sin clave) es Leaflet con tiles de
 *  OpenStreetMap, que es gratis y no necesita cuenta: el sistema tiene que
 *  seguir corriendo en la máquina de cualquiera del equipo. Mismo criterio que
 *  `ROUTES_PROVIDER` en el backend.
 *
 *  Las DOS condiciones juntas, igual que allá: un `.env` a medio configurar no
 *  debe dejar el mapa en un estado que nadie eligió.
 *
 *  **Google se cobra por CARGA DE MAPA**, o sea una por cada vez que se entra a
 *  /rutas o a /recursos. El zoom, el paneo y las capas son gratis. Durante una
 *  tarde de ajustes visuales conviene dejar esta variable sin definir: el hot
 *  reload remonta el mapa en cada guardado. */
const USA_GOOGLE =
  import.meta.env.VITE_MAPS_PROVIDER === "google" && !!import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

export function GeoMap(props: GeoMapProps) {
  const [Impl, setImpl] = useState<ComponentType<GeoMapProps> | null>(null);

  useEffect(() => {
    let cancelled = false;
    // El import() dinámico cumple dos funciones: evita el SSR (Leaflet toca
    // `window` en el top-level de su módulo) y deja cada motor en su propio
    // bloque, así el que no se usa no viaja al navegador.
    const cargar = USA_GOOGLE
      ? import("./GoogleMapImpl").then((m) => m.GoogleMapImpl)
      : import("./GeoMapImpl").then((m) => m.GeoMapImpl);
    cargar.then((componente) => {
      if (!cancelled) setImpl(() => componente);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!Impl) {
    return (
      <div
        className={`flex items-center justify-center bg-muted/40 text-xs text-muted-foreground ${props.className ?? ""}`}
      >
        Cargando mapa...
      </div>
    );
  }

  return <Impl {...props} />;
}
