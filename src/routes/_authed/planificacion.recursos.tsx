// =============================================================================
// CONDORFINDER, RECURSOS (HDU6 + HDU8)
// Archivo: src/routes/_authed/planificacion.recursos.tsx
//
// Los puntos desde donde sale la flota y, a través de cada uno, sus vehículos.
//
// Vista SEPARADA de /planificacion/rutas, aunque las dos cuelguen del mismo
// grupo del menú. Estuvieron fusionadas en una sola pantalla y no funcionó: son
// dos tareas con ritmos distintos. Administrar puntos y flota es CONFIGURACIÓN
// (se hace una vez, es precisa, vive en formularios y tablas); generar una ruta
// es OPERACIÓN (se hace a diario, es exploratoria, vive en el mapa). Fusionadas,
// la configuración se quedaba permanentemente con un tercio de la pantalla
// operativa, y el panel lateral terminaba con dos tarjetas que no se hablan
// compitiendo por la misma columna.
//
// Acá el mapa NO es el contenido: sirve para ubicar un punto y para verificar
// dónde quedó. El contenido es la tabla de puntos al pie, que es lo que se
// compara. Al revés que en la vista de rutas.
//
// La tabla es deliberadamente la MISMA que la de la flota: table-fixed con los
// anchos en un solo lugar, el interruptor de estado al principio, buscador con
// filtro de tres estados y paginación. Dos tablas que hacen lo mismo y se ven
// distinto obligan a reaprender la segunda.
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Eye,
  Loader2,
  MapPin,
  Pencil,
  Search,
  Trash2,
  Truck,
} from "@/components/icons/Icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GeoMap, type GeoMapPoint } from "@/components/GeoMap";
import { SortableHead } from "@/components/SortableHead";
import { MapThumb } from "@/components/MapThumb";
import { PanelPuntos, type PanelPuntosMapProps } from "@/components/PanelPuntos";
import { notify } from "@/lib/notify";
import {
  deleteResourcePoint,
  listResourcePoints,
  resourcePhotoUrl,
  setPointActive,
  type ResourcePoint,
} from "@/lib/resources";
import { listAnalyses, listZones, setPendingOpenId } from "@/lib/analysisStore";
import { projectPolygonToWgs84 } from "@/lib/projection";
import { ZoneZoomDialog, type ZoneZoomData } from "@/components/ZoneZoomDialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/_authed/planificacion/recursos")({
  component: RecursosPage,
});

/** Anchos de columna, en un solo lugar, para usarlos con `table-fixed`. Mismo
 *  motivo que en la tabla de la flota: con el ancho automático del navegador
 *  cada columna mide lo que mide su contenido más largo, así que una dirección
 *  larga se comía el espacio y el encabezado de capacidad se partía en dos
 *  líneas. Suman 100. */
const ANCHOS = {
  estado: "w-[12%]",
  // Más ancha que las demás desde que la celda muestra la foto real del lugar
  // y no una miniatura de mapa: una fachada a 4rem no se reconoce. Los puntos
  // salieron de estado y acciones, que no los necesitaban.
  lugar: "w-[13%]",
  punto: "w-[19%]",
  direccion: "w-[18%]",
  recursos: "w-[11%]",
  capacidad: "w-[13%]",
  acciones: "w-[14%]",
} as const;

/** Las columnas por las que se puede ordenar. La foto y las acciones quedan
 *  fuera: una imagen no tiene orden y una columna de botones tampoco. */
type Campo = "estado" | "nombre" | "direccion" | "recursos" | "capacidad";

/** Un basural guardado, dibujado en este mapa como contexto.
 *
 *  Guarda los datos y no un `GeoMapPoint` armado, porque el clic abre su mapa
 *  unificado con el MISMO visor que /rutas (`ZoneZoomDialog`), y ese necesita
 *  las detecciones y los tres totales. El `id` es el del ANÁLISIS (lo que trae
 *  la posición y las cifras) y el `nombre` es el de su ZONA. */
interface ZonaEnMapa {
  position: [number, number];
  visor: ZoneZoomData;
}

/** Prefijo del id de un marcador de zona en el mapa, para distinguirlo de un
 *  punto de recurso: los dos viven en el mismo arreglo de `points`. */
const PREFIJO_ZONA = "zona:";

/** Cinco filas por página. Acá sí es un número fijo, y no la medición del alto
 *  disponible que hace la tabla de la flota: esa tabla ocupa la pantalla
 *  entera, ésta comparte la vista con el panel y el mapa, así que el alto que
 *  le toca no es suyo y medirlo la haría crecer y encoger según cuánto ocupe lo
 *  de arriba. */
const POR_PAGINA = 5;

function RecursosPage() {
  const navigate = useNavigate();
  const [points, setPoints] = useState<ResourcePoint[]>([]);
  const [loading, setLoading] = useState(true);
  // Lo que el panel necesita del mapa mientras se ubica un punto. Vive acá
  // porque el mapa es de esta vista, no del panel.
  const [mapProps, setMapProps] = useState<PanelPuntosMapProps>({
    marker: null,
    onMapClick: null,
    focusPoint: null,
  });
  const [puntoSeleccionado, setPuntoSeleccionado] = useState<string | null>(null);
  const [puntoAEditar, setPuntoAEditar] = useState<string | null>(null);
  const [alternando, setAlternando] = useState<string | null>(null);
  const [aEliminar, setAEliminar] = useState<ResourcePoint | null>(null);
  /** El punto cuya foto de calle se está mirando en grande. null = ninguna. */
  const [fotoAmpliada, setFotoAmpliada] = useState<ResourcePoint | null>(null);
  const [eliminando, setEliminando] = useState(false);

  /** Las zonas guardadas, como contexto del mapa. Son el terreno al que hay que
   *  ir, no algo que esta vista administre. */
  const [zonas, setZonas] = useState<ZonaEnMapa[]>([]);
  /** Zona cuyo mapa unificado se está mirando, o null. */
  const [zonaAbierta, setZonaAbierta] = useState<ZoneZoomData | null>(null);

  const [busqueda, setBusqueda] = useState("");
  const [filtroEstado, setFiltroEstado] = useState<"todos" | "activos" | "inactivos">("todos");
  const [sortBy, setSortBy] = useState<Campo>("nombre");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [pagina, setPagina] = useState(1);

  const recargar = async () => {
    try {
      setPoints(await listResourcePoints());
    } catch (err) {
      notify.error(
        "No se pudieron cargar los puntos",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    recargar();
  }, []);

  // Las zonas guardadas, como CONTEXTO del mapa.
  //
  // Un punto de origen no se ubica en el vacío: se ubica respecto de los
  // basurales que hay que ir a retirar. Sin ellas, este mapa mostraba solo los
  // pines de los puntos y había que irse a /rutas para saber si el punto que se
  // estaba creando quedaba cerca o lejos del trabajo.
  //
  // Se cargan una vez al montar y no se vuelven a pedir: acá no se crean ni se
  // editan zonas, así que no hay nada que pueda cambiarlas mientras la vista
  // está abierta. Degrada en silencio porque son referencia: sin ellas el mapa
  // sigue sirviendo para lo que esta vista hace, que es configurar puntos.
  //
  // El nombre sale de la colección de ZONAS y no del análisis: lo que el mapa
  // rotula es el terreno, así que con el nombre de la medición una zona
  // renombrada seguía apareciendo con el nombre viejo.
  useEffect(() => {
    Promise.all([listAnalyses(), listZones().catch(() => [])])
      .then(([registros, zonasGuardadas]) => {
        const nombres = new Map(zonasGuardadas.map((z) => [z.id, z.name]));
        const resueltas: ZonaEnMapa[] = [];
        for (const r of registros) {
          // Las reemplazadas por una captura más nueva (HDU7) quedan fuera, igual
          // que en /rutas: si no, una zona con tres capturas se dibujaría tres
          // veces sobre la misma coordenada.
          if (r.historical) continue;
          if (!r.orthoCenter || !r.crs) continue;
          const wgs84 = projectPolygonToWgs84([r.orthoCenter], r.crs);
          const centro = wgs84?.[0];
          if (!centro || !r.mapUrl) continue;
          // Las detecciones vienen como un blob opaco en el registro guardado
          // (ver analyses.py), así que se filtran las que no sirven para dibujar
          // en vez de confiar en su forma: sin bbox no hay recuadro que poner.
          const detecciones = (Array.isArray(r.detections) ? r.detections : [])
            .filter((d): d is Record<string, never> => {
              const det = d as { enabled?: boolean; bbox?: unknown };
              return det.enabled !== false && !!det.bbox;
            })
            .map((d, i) => {
              const det = d as unknown as {
                id?: number;
                class?: string;
                volume_m3?: number;
                weight_kg?: number;
                area_m2?: number;
                bbox: { minx: number; miny: number; maxx: number; maxy: number };
              };
              return {
                id: det.id ?? i,
                wasteClass: det.class ?? "Tipo de basura indefinido",
                volumeM3: det.volume_m3 ?? null,
                weightKg: det.weight_kg ?? null,
                areaM2: det.area_m2 ?? null,
                bbox: det.bbox,
              };
            });
          resueltas.push({
            position: centro,
            visor: {
              id: r.id,
              name: (r.zoneId ? nombres.get(r.zoneId) : undefined) ?? r.name,
              mapUrl: r.mapUrl,
              detections: detecciones,
              summary: {
                totalVolumeM3: r.summary?.totalVolumeM3 ?? 0,
                totalWeightKg: r.summary?.totalWeightKg ?? 0,
                totalAreaM2: r.summary?.totalAreaM2 ?? 0,
              },
            },
          });
        }
        setZonas(resueltas);
      })
      .catch(() => {});
  }, []);

  const totales = {
    puntos: points.filter((p) => p.active).length,
    recursos: points.reduce((sum, p) => sum + p.resource_count, 0),
    disponibles: points.reduce((sum, p) => sum + p.available_count, 0),
    capacidad: points.reduce((sum, p) => sum + p.capacity_m3, 0),
  };

  const inactivos = points.filter((p) => !p.active).length;

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const filtrados = points.filter((p) => {
      if (filtroEstado === "activos" && !p.active) return false;
      if (filtroEstado === "inactivos" && p.active) return false;
      if (!q) return true;
      return [p.name, p.address, p.comuna].some((campo) => campo?.toLowerCase().includes(q));
    });

    // Copia antes de ordenar: sort() muta, y `points` es el estado que también
    // alimenta los marcadores del mapa.
    const signo = sortDir === "asc" ? 1 : -1;
    return [...filtrados].sort((a, b) => {
      switch (sortBy) {
        case "estado":
          // Activo primero en ascendente. Es lo que se busca al ordenar por
          // estado: qué puntos participan de una ruta.
          return (Number(b.active) - Number(a.active)) * signo;
        case "direccion":
          // localeCompare con la comuna de respaldo: varios puntos pueden
          // compartir dirección vacía y ahí lo que distingue es la comuna.
          return `${a.address} ${a.comuna}`.localeCompare(`${b.address} ${b.comuna}`, "es") * signo;
        case "recursos":
          return (a.resource_count - b.resource_count) * signo;
        case "capacidad":
          return (a.capacity_m3 - b.capacity_m3) * signo;
        default:
          // localeCompare y no una comparación de strings: los nombres llevan
          // tildes y "Ñuñoa" iría después de "Zapadores" comparando por código
          // de carácter.
          return a.name.localeCompare(b.name, "es") * signo;
      }
    });
  }, [points, busqueda, filtroEstado, sortBy, sortDir]);

  const alternarOrden = (campo: Campo) => {
    if (campo === sortBy) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(campo);
      setSortDir("asc");
    }
  };

  const totalPaginas = Math.max(1, Math.ceil(visibles.length / POR_PAGINA));
  // Filtrar deja la página actual fuera de rango (estabas en la 3 y ahora hay
  // una): sin esto la tabla se ve vacía aunque haya resultados.
  useEffect(() => setPagina((p) => Math.min(p, totalPaginas)), [totalPaginas]);
  const paginaActual = Math.min(pagina, totalPaginas);
  const desde = (paginaActual - 1) * POR_PAGINA;
  const enPagina = visibles.slice(desde, desde + POR_PAGINA);

  const alternarActivo = async (p: ResourcePoint) => {
    setAlternando(p.id);
    try {
      const actualizado = await setPointActive(p, !p.active);
      setPoints((prev) => prev.map((x) => (x.id === p.id ? actualizado : x)));
    } catch (err) {
      notify.error(
        "No se pudo cambiar el estado del punto",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
    } finally {
      setAlternando(null);
    }
  };

  const confirmarEliminar = async () => {
    if (!aEliminar) return;
    setEliminando(true);
    try {
      await deleteResourcePoint(aEliminar.id);
      setPoints((prev) => prev.filter((x) => x.id !== aEliminar.id));
      notify.success("Punto eliminado", aEliminar.name);
      setAEliminar(null);
    } catch (err) {
      notify.error(
        "No se pudo eliminar el punto",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
    } finally {
      setEliminando(false);
    }
  };

  const irAlPunto = (id: string) =>
    navigate({ to: "/planificacion/recursos/$pointId", params: { pointId: id } });

  // Las zonas van PRIMERO para que los pines de los puntos queden dibujados
  // encima: lo que se administra acá son los puntos, y un círculo de zona
  // tapando el pin que se está editando esconde justo lo que se está haciendo.
  //
  // **Sin `previewImageUrl`, a propósito.** Ese campo hace que el mapa unificado
  // aparezca al pasar el puntero, y acá eso está mal: una imagen de varios MB
  // tapando el mapa mientras se ubica un punto estorba justo la operación de
  // esta vista. La imagen se mira cuando se la pide, apretando la zona, igual
  // que en /rutas.
  const mapPoints: GeoMapPoint[] = [
    ...zonas.map((z) => ({
      id: `${PREFIJO_ZONA}${z.visor.id}`,
      position: z.position,
      label: `${z.visor.name} · ${z.visor.summary.totalVolumeM3} m³`,
      // Con `color` el marcador se dibuja como círculo en vez de pin, que es lo
      // que distingue una zona de un punto en /rutas. Violeta, el primero de los
      // colores de zona de esa vista: no compite con el navy de los puntos ni
      // con el teal del relleno. Literal y no `var(--primary)` por el renderer
      // de canvas, igual que el resto de los colores del mapa.
      color: "#7c3aed",
    })),
    ...points.map((p) => ({
      id: p.id,
      position: [p.lat, p.lng] as [number, number],
      label: p.active
        ? `${p.name} · ${p.capacity_m3} m³`
        : `${p.name} (inactivo) · ${p.capacity_m3} m³`,
      muted: !p.active,
    })),
  ];

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <div className="border-b border-border/25 px-6 py-4">
        <p className="eyebrow">Planificación</p>
        <h1 className="font-rubik text-3xl font-semibold tracking-normal text-foreground md:text-4xl">
          Recursos
        </h1>
      </div>

      <main className="flex flex-1 flex-col gap-5 p-6">
        {/* Franja de cifras, el mismo tratamiento .panel que la flota de un
            punto. Estuvo suelta en la cabecera, alineada a la derecha del
            título: ahí las cuatro cifras flotaban sobre el fondo de la página,
            sin superficie propia, y competían con el título por la misma línea.

            Bajarla al cuerpo la convierte en lo que es, la cabecera de los
            datos, y de paso deja el título solo, que es lo que hacen las otras
            vistas. Las cuatro van al mismo tamaño: la jerarquía la da el orden,
            no el cuerpo de la tipografía. */}
        <div className="panel flex flex-wrap items-center divide-x divide-border/10 px-1">
          <Cifra
            icono={<MapPin className="h-4 w-4" />}
            etiqueta="Puntos activos"
            valor={String(totales.puntos)}
          />
          <Cifra
            icono={<Truck className="h-4 w-4" />}
            etiqueta="Recursos"
            valor={String(totales.recursos)}
          />
          <Cifra
            icono={<CheckCircle2 className="h-4 w-4" />}
            etiqueta="Disponibles"
            valor={`${totales.disponibles} de ${totales.recursos}`}
          />
          <Cifra
            icono={<Boxes className="h-4 w-4" />}
            etiqueta="Capacidad de transporte"
            valor={`${totales.capacidad} m³`}
          />
        </div>

        {/* Panel y mapa, del MISMO alto. El alto lo pone el formulario y el mapa
            lo sigue: las dos son celdas de la misma fila de la grilla, que se
            estiran por igual, así que basta con que el mapa no imponga uno
            propio (antes tenía su clamp) y que ocupe el de la fila con h-full.
            Con alturas distintas, una de las dos tarjetas terminaba siempre con
            un escalón al pie contra la otra.

            El min-h es para que el mapa no quede aplastado cuando el panel
            muestra la ficha de un punto, que es más corta que el formulario.
            El mapa acompaña, no manda: acá se está configurando, y lo que se
            compara está en la tabla de abajo. */}
        <div className="grid min-h-[clamp(18rem,38vh,28rem)] gap-5 lg:grid-cols-[clamp(19rem,28vw,26rem)_1fr]">
          <aside className="rounded-xl border border-border bg-card p-5">
            <PanelPuntos
              onMapProps={setMapProps}
              onPuntosCambiaron={recargar}
              puntoSeleccionadoId={puntoSeleccionado}
              puntoAEditarId={puntoAEditar}
              onIntencionAtendida={() => {
                setPuntoSeleccionado(null);
                setPuntoAEditar(null);
              }}
            />
          </aside>

          <section className="map-frame h-full bg-background">
            <GeoMap
              className="h-full w-full"
              points={mapPoints}
              // Las zonas comparten el mapa pero no son puntos: su id va
              // prefijado, y apretarlas abre su mapa unificado en vez de la
              // ficha de un punto. Sin esta bifurcación se le mandaba a
              // PanelPuntos la orden de abrir un punto que no existe, que es una
              // orden de un solo uso y se quedaba pegada.
              onPointClick={(p) => {
                if (p.id.startsWith(PREFIJO_ZONA)) {
                  const id = p.id.slice(PREFIJO_ZONA.length);
                  setZonaAbierta(zonas.find((z) => z.visor.id === id)?.visor ?? null);
                  return;
                }
                setPuntoSeleccionado(p.id);
              }}
              marker={mapProps.marker}
              onMapClick={mapProps.onMapClick ?? undefined}
              focusPoint={mapProps.focusPoint}
              lockToMaipu
            />
            {loading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/60">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}
          </section>
        </div>

        {/* El contenido de la vista. Un punto se compara con otro por sus cifras,
            y eso necesita filas, no marcadores. */}
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {/* Título, buscador y filtro en UNA fila, como el listado de zonas de
              Vista Principal y la tabla de la flota.

              Se muestran SIEMPRE, no solo cuando sobran filas. Estuvieron
              condicionados a que hubiera más puntos que los que caben en una
              página, con el argumento de que con dos puntos un buscador no hace
              nada; el problema es que entonces la tabla cambia de forma según
              cuántos datos tenga, y quien la conoció con un punto no sabe que
              existe un filtro. Los otros dos listados los muestran siempre. */}
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
            <span className="flex items-center gap-2.5 border-l-2 border-primary/50 pl-3">
              <MapPin className="h-3.5 w-3.5 text-foreground/70" />
              <h2 className="text-sm font-semibold tracking-tight text-foreground">Puntos</h2>
            </span>

            <div className="relative min-w-[12rem] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar por nombre, dirección o comuna"
                className="h-8 pl-8 text-xs"
              />
            </div>

            <div className="flex items-center gap-1 rounded-md bg-background/60 p-0.5">
              {(
                [
                  ["todos", `Todos (${points.length})`],
                  ["activos", `Activos (${points.length - inactivos})`],
                  ["inactivos", `Inactivos (${inactivos})`],
                ] as const
              ).map(([valor, etiqueta]) => (
                <button
                  key={valor}
                  type="button"
                  onClick={() => setFiltroEstado(valor)}
                  className={`cursor-pointer rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    filtroEstado === valor
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {etiqueta}
                </button>
              ))}
            </div>
          </div>

          {/* Alto FIJO, calculado para cinco filas más el encabezado, haya dos
              puntos o veinte. Con el alto siguiendo al contenido, la tarjeta
              crecía y encogía al filtrar o al cambiar de página, y los
              controles de paginación se movían justo cuando hay que apretarlos
              dos veces seguidas. Va en rem porque toda la interfaz escala con
              el clamp de html (ver styles.css): en px se quedaría corta en
              1440p y sobraría en un portátil.

              overflow-y-auto y no hidden: si una fila mide más de lo previsto
              (una dirección que envuelve, otra escala de fuente), el scroll es
              lo que impide que la quinta quede recortada sin forma de verla. */}
          {/* 30rem y no 26: con la foto del lugar a 4rem de alto, cinco filas
              más la cabecera ya no entraban y la quinta quedaba bajo el scroll,
              justo cuando la paginación promete cinco. */}
          <div className="h-[30rem] overflow-y-auto px-5 pb-5">
            {loading ? (
              <div className="space-y-2 pt-4">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-14 w-full rounded-md" />
                ))}
              </div>
            ) : points.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <MapPin className="h-10 w-10 text-muted-foreground/30" />
                <div>
                  <p className="text-sm font-semibold text-foreground">Todavía no hay puntos</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Un punto es el lugar donde está la flota. Sin al menos uno no se puede
                    planificar ninguna ruta. Se define desde el panel de arriba.
                  </p>
                </div>
              </div>
            ) : visibles.length === 0 ? (
              <p className="py-12 text-center text-xs text-muted-foreground">
                Ningún punto coincide con la búsqueda.
              </p>
            ) : (
              <Table className="table-fixed">
                <TableHeader>
                  {/* Los mismos encabezados ordenables que la flota y que el
                      listado de zonas, con el mismo componente. El indicador se
                      dibuja siempre, en los tres estados: con table-fixed el
                      ancho ya no se mueve, pero la flecha atenuada al pasar el
                      cursor es lo que avisa que la columna se puede ordenar.

                      La unidad la pone el propio SortableHead con `unit`, así
                      que no hay que repetir el span en mono acá. */}
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <SortableHead
                      field="estado"
                      label="Estado"
                      className={ANCHOS.estado}
                      sortBy={sortBy}
                      sortDir={sortDir}
                      onSort={alternarOrden}
                    />
                    <TableHead className={ANCHOS.lugar}>Lugar</TableHead>
                    <SortableHead
                      field="nombre"
                      label="Punto"
                      className={ANCHOS.punto}
                      sortBy={sortBy}
                      sortDir={sortDir}
                      onSort={alternarOrden}
                    />
                    <SortableHead
                      field="direccion"
                      label="Dirección"
                      className={ANCHOS.direccion}
                      sortBy={sortBy}
                      sortDir={sortDir}
                      onSort={alternarOrden}
                    />
                    <SortableHead
                      field="recursos"
                      label="Recursos"
                      className={ANCHOS.recursos}
                      sortBy={sortBy}
                      sortDir={sortDir}
                      onSort={alternarOrden}
                      align="center"
                    />
                    <SortableHead
                      field="capacidad"
                      label="Capacidad"
                      unit="m³"
                      className={ANCHOS.capacidad}
                      sortBy={sortBy}
                      sortDir={sortDir}
                      onSort={alternarOrden}
                      align="center"
                    />
                    <TableHead className={ANCHOS.acciones}></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {enPagina.map((p) => (
                    <TableRow key={p.id} className="hover:bg-card/60">
                      {/* ESTADO PRIMERO, igual que en la flota: es lo que decide
                          si este punto participa de una ruta, antes que quién
                          es. */}
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={p.active}
                            disabled={alternando === p.id}
                            onCheckedChange={() => alternarActivo(p)}
                            aria-label={
                              p.active
                                ? `Desactivar el punto ${p.name}`
                                : `Activar el punto ${p.name}`
                            }
                          />
                          {alternando === p.id ? (
                            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                          ) : (
                            <span
                              className={`text-xs font-medium ${
                                p.active ? "text-success-strong" : "text-muted-foreground"
                              }`}
                            >
                              {p.active ? "Activo" : "Inactivo"}
                            </span>
                          )}
                        </div>
                      </TableCell>

                      {/* HUECO RESERVADO PARA LA FOTO DEL SECTOR.
                          La decisión de si la foto sale de Google Street View
                          (que cobra por imagen y exige una cuenta con
                          facturación) está pendiente. Hasta entonces el hueco
                          lo ocupa la vista de mapa del lugar, que es gratis y
                          existe para todos los puntos por igual; un recuadro
                          gris vacío reservaría el mismo espacio sin decir nada.
                          El día que haya foto, se cambia este componente por el
                          de la foto y no se mueve ninguna columna: el ancho ya
                          está fijado en ANCHOS.lugar. */}
                      <TableCell>
                        {p.street_view ? (
                          // La foto real de la calle. Es un <button> porque se
                          // amplía al apretarla: a 16x11 se reconoce que hay un
                          // lugar, pero no si ES el patio que uno busca.
                          //
                          // El diálogo usa EL MISMO archivo, escalado con CSS.
                          // Pedir una versión grande sería otra URL y por lo
                          // tanto otra solicitud cobrada, así que se guarda al
                          // tamaño máximo una sola vez y se muestra chica acá.
                          <button
                            type="button"
                            onClick={() => setFotoAmpliada(p)}
                            title={`Ver el lugar de ${p.name}`}
                            className="group relative block h-16 w-24 cursor-pointer overflow-hidden rounded-md border border-border/60"
                          >
                            <img
                              src={resourcePhotoUrl(p.street_view)}
                              alt={`Vista de calle de ${p.name}`}
                              loading="lazy"
                              className={`h-full w-full object-cover transition-opacity group-hover:opacity-80 ${
                                p.active ? "" : "opacity-50 grayscale"
                              }`}
                            />
                          </button>
                        ) : (
                          // Sin cobertura de Street View, sin clave, o un punto
                          // creado antes de que esto existiera: el mapa estático
                          // de siempre. Mismo tamaño, así que la columna no se
                          // mueve según haya foto o no.
                          <MapThumb
                            lat={p.lat}
                            lng={p.lng}
                            muted={!p.active}
                            className="h-16 w-24 rounded-md border border-border/60"
                          />
                        )}
                      </TableCell>

                      <TableCell className="truncate text-xs font-medium text-foreground">
                        {p.name}
                      </TableCell>

                      <TableCell className="truncate text-xs text-muted-foreground">
                        {[p.address === p.name ? null : p.address, p.comuna]
                          .filter(Boolean)
                          .join(", ") || "-"}
                      </TableCell>

                      <TableCell className="mono text-center text-xs tabular-nums">
                        {p.available_count} de {p.resource_count}
                      </TableCell>

                      <TableCell className="mono text-center text-xs font-semibold tabular-nums text-foreground">
                        {p.capacity_m3}
                      </TableCell>

                      {/* Las tres acciones visibles siempre, como en la lista
                          de zonas. Estuvieron asomando al pasar el cursor y es
                          una apuesta que solo gana con ratón: quien llega por
                          teclado, o desde una pantalla táctil, no tiene cómo
                          descubrir que existen. Lo que separa la principal de
                          las otras dos no es que aparezcan, es que una lleva
                          texto y las otras son íconos.

                          La fila entera ya NO navega. Con tres acciones en la
                          misma fila, un clic en cualquier otro lado abría la
                          flota sin que nadie lo pidiera, y "Ver punto" pasaba a
                          ser un adorno que repetía lo que hacía todo lo demás. */}
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            onClick={() => irAlPunto(p.id)}
                            title="Ver la flota de este punto"
                          >
                            <Eye className="mr-1.5 h-3.5 w-3.5" /> Ver punto
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                            onClick={() => setPuntoAEditar(p.id)}
                            title="Editar punto"
                            aria-label={`Editar el punto ${p.name}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0 text-muted-foreground hover:bg-destructive/15 hover:text-destructive-strong"
                            onClick={() => setAEliminar(p)}
                            title="Eliminar punto"
                            aria-label={`Eliminar el punto ${p.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          {/* La barra va SIEMPRE, incluso con una sola página. Apareciendo solo
              cuando sobran filas, cambiaba el alto de la tarjeta al filtrar,
              que es justo lo que el alto fijo de arriba evita. Con una página
              los botones quedan deshabilitados, que ya dice que no hay a dónde
              ir. */}
          {!loading && points.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
              <p className="text-xs text-muted-foreground">
                Mostrando{" "}
                <span className="mono tabular-nums text-foreground">
                  {desde + 1}-{Math.min(desde + POR_PAGINA, visibles.length)}
                </span>{" "}
                de <span className="mono tabular-nums text-foreground">{visibles.length}</span>
              </p>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={paginaActual === 1}
                  onClick={() => setPagina(paginaActual - 1)}
                >
                  Anterior
                </Button>
                {Array.from({ length: totalPaginas }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setPagina(n)}
                    aria-current={n === paginaActual ? "page" : undefined}
                    className={`mono h-8 w-8 cursor-pointer rounded-md text-xs tabular-nums transition-colors ${
                      n === paginaActual
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    {n}
                  </button>
                ))}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={paginaActual === totalPaginas}
                  onClick={() => setPagina(paginaActual + 1)}
                >
                  Siguiente
                </Button>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Borrar un punto se lleva su flota por delante (resources.py borra los
          recursos de ese punto junto con él), así que la confirmación lo dice
          con el número en la mano en vez de un "esta acción no se puede
          deshacer" genérico. */}
      <AlertDialog
        open={aEliminar !== null}
        onOpenChange={(abierto) => {
          if (!abierto && !eliminando) setAEliminar(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Eliminar punto
            </AlertDialogTitle>
            <AlertDialogDescription>
              {aEliminar && (
                <>
                  Se va a eliminar {aEliminar.name}
                  {aEliminar.resource_count > 0 && (
                    <>
                      {" "}
                      y{" "}
                      {aEliminar.resource_count === 1
                        ? "su único recurso"
                        : `sus ${aEliminar.resource_count} recursos`}
                      , con sus fotos y sus capacidades
                    </>
                  )}
                  . No se puede deshacer. Si el punto deja de operar solo por un tiempo, conviene
                  desactivarlo con el interruptor: deja de participar en las rutas y no se pierde
                  nada.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={eliminando}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmarEliminar} disabled={eliminando}>
              {eliminando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* La foto de calle en grande. Es el MISMO archivo que la miniatura: se
          guarda al tamaño máximo (640x640 con scale=2) una sola vez y acá se
          muestra sin reducir. Pedirle a Google una versión grande sería otra
          URL y por lo tanto otra solicitud cobrada.

          Mismo diálogo que el de la foto de un recurso (ver el de la vista de
          flota): a sangre, sin padding ni encabezado visible, con el título
          solo para lectores de pantalla. Dos visores de foto que se ven
          distinto obligan a reaprender el segundo, y acá es la misma gesto
          sobre la misma clase de contenido.

          Sin línea de atribución: las imágenes de Street View Static traen el
          logo de Google impreso en el propio ráster, así que repetirlo en texto
          sería decir dos veces lo mismo. */}
      <Dialog open={fotoAmpliada !== null} onOpenChange={(open) => !open && setFotoAmpliada(null)}>
        <DialogContent className="max-w-3xl overflow-hidden p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>{fotoAmpliada?.name ?? "Lugar del punto"}</DialogTitle>
          </DialogHeader>
          {fotoAmpliada?.street_view && (
            <img
              src={resourcePhotoUrl(fotoAmpliada.street_view)}
              alt={`Vista de calle de ${fotoAmpliada.name}`}
              className="h-auto w-full"
            />
          )}
        </DialogContent>
      </Dialog>

      {/* El mapa unificado de una zona, al apretar su círculo. El MISMO visor
          que /rutas: antes era una versión propia con la imagen y dos cifras,
          sin recuadros de detección ni detalle por tipo, o sea dos respuestas
          distintas a la misma pregunta según de dónde se abriera.

          Se abre a pedido y no al pasar el puntero: la imagen pesa varios MB y
          tapaba el mapa justo mientras se está ubicando un punto, que es para lo
          que existe esta vista. */}
      <ZoneZoomDialog
        zona={zonaAbierta}
        onOpenChange={(abierto) => !abierto && setZonaAbierta(null)}
        onVerAnalisis={(id) => {
          setPendingOpenId(id);
          navigate({ to: "/analysis" });
        }}
      />
    </div>
  );
}

/** Una cifra de la franja. Idéntica a la de la vista de la flota, a propósito:
 *  ícono al costado, etiqueta chica arriba y el valor en .mono debajo. */
function Cifra({
  icono,
  etiqueta,
  valor,
}: {
  icono: React.ReactNode;
  etiqueta: string;
  valor: string;
}) {
  return (
    <div className="flex flex-shrink-0 items-center gap-3 px-5 py-3.5">
      <span className="flex h-8 w-8 items-center justify-center text-muted-foreground">
        {icono}
      </span>
      <span>
        <span className="block text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
          {etiqueta}
        </span>
        <span className="mono block text-sm font-semibold tabular-nums text-foreground">
          {valor}
        </span>
      </span>
    </div>
  );
}
