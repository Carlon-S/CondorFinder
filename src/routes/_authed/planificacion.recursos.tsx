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
  setPointActive,
  type ResourcePoint,
} from "@/lib/resources";

export const Route = createFileRoute("/_authed/planificacion/recursos")({
  component: RecursosPage,
});

/** Anchos de columna, en un solo lugar, para usarlos con `table-fixed`. Mismo
 *  motivo que en la tabla de la flota: con el ancho automático del navegador
 *  cada columna mide lo que mide su contenido más largo, así que una dirección
 *  larga se comía el espacio y el encabezado de capacidad se partía en dos
 *  líneas. Suman 100. */
const ANCHOS = {
  estado: "w-[14%]",
  lugar: "w-[9%]",
  punto: "w-[19%]",
  direccion: "w-[18%]",
  recursos: "w-[11%]",
  capacidad: "w-[13%]",
  acciones: "w-[16%]",
} as const;

/** Las columnas por las que se puede ordenar. La foto y las acciones quedan
 *  fuera: una imagen no tiene orden y una columna de botones tampoco. */
type Campo = "estado" | "nombre" | "direccion" | "recursos" | "capacidad";

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
  const [eliminando, setEliminando] = useState(false);

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

  const mapPoints: GeoMapPoint[] = points.map((p) => ({
    id: p.id,
    position: [p.lat, p.lng] as [number, number],
    label: p.active
      ? `${p.name} · ${p.capacity_m3} m³`
      : `${p.name} (inactivo) · ${p.capacity_m3} m³`,
    muted: !p.active,
  }));

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
              onPointClick={(p) => setPuntoSeleccionado(p.id)}
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
          <div className="h-[26rem] overflow-y-auto px-5 pb-5">
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
                        <MapThumb
                          lat={p.lat}
                          lng={p.lng}
                          muted={!p.active}
                          className="h-11 w-16 rounded-md border border-border/60"
                        />
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
