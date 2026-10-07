// =============================================================================
// CONDORFINDER, RECURSOS DE UN PUNTO (HDU8)
// Archivo: src/routes/_authed/planificacion.recursos_.$pointId.tsx
//
// La flota de un punto, en su propia vista. Antes era una tabla al pie de
// /recursos, debajo del mapa y de la ficha del punto; acá tiene la pantalla
// entera, que es lo que necesita una tabla de 21 filas con orden, filtros y
// páginas.
//
// El guion bajo de "planificacion_" saca esta ruta de debajo de /planificacion:
// esa es una ruta hoja, no un layout, y anidar bajo ella exigiría un <Outlet>
// que no tiene. La URL igual queda /planificacion/{id}.
//
// Los criterios de HDU8 que viven acá:
//   AC1  "Agregar recurso" abre la modal que pregunta el TIPO, y recién con el
//        tipo elegido navega al formulario.
//   AC3  "Editar" lleva al mismo formulario con el recurso cargado.
//   AC4  El interruptor de cada fila alterna disponible / no disponible.
// El AC2 vive en el formulario y el AC5 en el backend.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ImageOff } from "lucide-react";
import {
  AlertTriangle,
  ArrowRightCircle,
  Boxes,
  CheckCircle2,
  Eye,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Truck,
} from "@/components/icons/Icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SortableHead } from "@/components/SortableHead";
import { ResourceFormDialog } from "@/components/ResourceFormDialog";
import { notify } from "@/lib/notify";
import {
  deleteResource,
  getResourcePoint,
  listResourceTypes,
  listResources,
  motivoFueraDeRuta,
  resourcePhotoUrl,
  setPointResourcesAvailability,
  setResourceAvailability,
  TEXTO_FUERA_DE_RUTA,
  type Resource,
  type ResourcePoint,
  type ResourceType,
} from "@/lib/resources";

export const Route = createFileRoute("/_authed/planificacion/recursos_/$pointId")({
  component: RecursosDelPuntoPage,
  // ?agregar=1 abre el diálogo de tipo al entrar. Lo usa el panel de puntos
  // después de crear uno: un punto sin flota no sirve para ninguna ruta, así
  // que el camino natural es seguir cargándola.
  // El tipo de retorno deja `agregar` OPCIONAL a propósito: devolviéndolo
  // siempre, el router lo vuelve obligatorio y cada navegación hacia esta ruta
  // (la tabla de puntos, el botón "Ver punto") tendría que mandarlo.
  validateSearch: (search: Record<string, unknown>): { agregar?: true } =>
    search.agregar === true || search.agregar === "1" || search.agregar === "true"
      ? { agregar: true }
      : {},
});

type Campo = "estado" | "equipo" | "tipo" | "capacidad" | "peso" | "autonomia" | "vehiculo";

/** Anchos de columna, en porcentaje y en un solo lugar, para usarlos con
 *  `table-fixed`. Con el ancho automático del navegador cada columna mide lo
 *  que mide su contenido más largo, así que "Vehículo" se comía el espacio con
 *  un "CATERPILLAR 416F2 2018" y el encabezado de capacidad se partía en dos
 *  líneas. */
const ANCHOS = {
  estado: "w-[11%]",
  // Igual de ancha que la del lugar en la tabla de puntos: las dos muestran una
  // foto que hay que poder reconocer, y a 4rem un camión es una mancha. Los
  // puntos salieron de estado y acciones.
  foto: "w-[11%]",
  equipo: "w-[15%]",
  tipo: "w-[10%]",
  capacidad: "w-[11%]",
  peso: "w-[10%]",
  autonomia: "w-[10%]",
  vehiculo: "w-[12%]",
  acciones: "w-[10%]",
} as const;

/** La cifra de capacidad separada de qué mide. Antes la celda decía "balde 3"
 *  dentro de una columna cuyo encabezado ya dice "(m³)": una columna de cifras
 *  tiene que tener cifras, y el número solo no distingue los 10 m³ de carga de
 *  una tolva de los 3 m³ del balde de una pala. Ahora el número va arriba y qué
 *  mide va abajo, en gris.
 *
 *  `declaradoEnSuTipo` decide si una capacidad ausente es un HUECO o
 *  simplemente algo que no sabemos, y es la corrección de un error de fondo.
 *  La familia de cada tipo (que TOLVA transporta, que MINICARGADOR es máquina
 *  con balde) no sale de la planilla: no hay columna de familia, la inferí. Con
 *  esa inferencia la interfaz afirmaba cosas como "el minicargador tiene el
 *  balde sin declarar", que no es un dato de la municipalidad sino una
 *  conclusión de una clasificación propia presentada como hecho.
 *
 *  La regla nueva la da el propio dato: una capacidad ausente es un hueco solo
 *  si ALGUNA otra unidad del mismo tipo sí la declara. Una TOLVA sin capacidad
 *  lo es, porque las otras seis la traen; un AMPLIROLL no, porque ninguno de
 *  los dos la trae y no sabemos si le corresponde. Los huecos van en ámbar y lo
 *  desconocido en gris. */
function capacidadDe(
  r: Resource,
  declaradoEnSuTipo: { carga: boolean; balde: boolean },
): { valor: number | null; unidad: "m³" | "kg"; nota: string; falta: boolean } {
  if (r.familia === "carga") {
    if (r.capacidad_m3 != null)
      return { valor: r.capacidad_m3, unidad: "m³", nota: "carga", falta: false };
    // Declara su límite en PESO y no en volumen: es el CAMION 3/4 PLANO. No es
    // un hueco, es otra magnitud, y marcarlo en ámbar como si faltara el dato
    // sería falso ahora que la municipalidad lo entregó.
    //
    // Se IMPRIME en kg aunque el campo guarde toneladas. El resto del sistema
    // habla de peso en kilos (el de cada zona, el de cada parada del plan, el
    // que calcula volumeCalc.py por detección), así que una flota en toneladas
    // obligaba a convertir de cabeza para comparar la carga de una zona contra
    // el límite del camión que la va a llevar. El dato guardado sigue en
    // toneladas, que es la unidad en que lo entregó la municipalidad.
    if (r.capacidad_ton != null)
      return { valor: r.capacidad_ton * 1000, unidad: "kg", nota: "carga", falta: false };
    return declaradoEnSuTipo.carga
      ? { valor: null, unidad: "m³", nota: "sin declarar", falta: true }
      : { valor: null, unidad: "m³", nota: "sin dato", falta: false };
  }
  if (r.familia === "maquina") {
    if (r.capacidad_balde_m3 != null)
      return { valor: r.capacidad_balde_m3, unidad: "m³", nota: "balde", falta: false };
    return declaradoEnSuTipo.balde
      ? { valor: null, unidad: "m³", nota: "balde sin declarar", falta: true }
      : { valor: null, unidad: "m³", nota: "sin dato", falta: false };
  }
  if (r.familia === "arrastre") {
    // Un carro que declara su capacidad la muestra como cualquier otro. La
    // nota sigue diciendo "se remolca" porque es lo que lo distingue: carga,
    // pero alguien tiene que tirarlo.
    if (r.capacidad_m3 != null)
      return { valor: r.capacidad_m3, unidad: "m³", nota: "se remolca", falta: false };
    return { valor: null, unidad: "m³", nota: "se remolca", falta: false };
  }
  return { valor: null, unidad: "m³", nota: "sin dato", falta: false };
}

function dotacionTexto(r: Resource): string {
  const partes = [
    r.conductores_requeridos &&
      `${r.conductores_requeridos} conductor${r.conductores_requeridos > 1 ? "es" : ""}`,
    r.peonetas_requeridas &&
      `${r.peonetas_requeridas} peoneta${r.peonetas_requeridas > 1 ? "s" : ""}`,
    r.operadores_requeridos &&
      `${r.operadores_requeridos} operador${r.operadores_requeridos > 1 ? "es" : ""}`,
  ].filter(Boolean);
  return partes.length > 0 ? partes.join(" + ") : "sin dotación declarada";
}

function RecursosDelPuntoPage() {
  const { pointId } = Route.useParams();
  const { agregar } = Route.useSearch();
  const navegar = useNavigate();

  const [punto, setPunto] = useState<ResourcePoint | null>(null);
  const [recursos, setRecursos] = useState<Resource[]>([]);
  const [tipos, setTipos] = useState<ResourceType[]>([]);
  const [cargando, setCargando] = useState(true);
  const [alternando, setAlternando] = useState<string | null>(null);
  const [cambiandoTodos, setCambiandoTodos] = useState(false);
  const [eligiendoTipo, setEligiendoTipo] = useState(agregar === true);
  const [aEliminar, setAEliminar] = useState<Resource | null>(null);
  const [eliminando, setEliminando] = useState(false);
  const [fotoAmpliada, setFotoAmpliada] = useState<string | null>(null);
  // Ficha de un recurso, en solo lectura. Es lo que abre "Ver recurso":
  // la fila muestra seis columnas y la unidad tiene más datos que eso.
  const [enDetalle, setEnDetalle] = useState<Resource | null>(null);
  // Formulario: `tipoNuevo` con valor = alta, `enEdicion` con valor = edición.
  // Nunca los dos a la vez.
  const [tipoNuevo, setTipoNuevo] = useState<string | null>(null);
  const [enEdicion, setEnEdicion] = useState<Resource | null>(null);

  const [busqueda, setBusqueda] = useState("");
  const [filtroEstado, setFiltroEstado] = useState<"todos" | "disponibles" | "no">("todos");
  // Por N° de equipo: es el identificador con el que la municipalidad nombra
  // sus vehículos ("la 2184"), así que es el orden en el que se los busca.
  const [sortBy, setSortBy] = useState<Campo>("equipo");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [pagina, setPagina] = useState(1);

  // La orden se borra de la URL apenas se atiende. Si se quedara, recargar la
  // página volvería a abrir el diálogo, y el enlace copiado a un compañero le
  // abriría un formulario de alta que nadie pidió.
  useEffect(() => {
    if (agregar) navegar({ to: ".", search: {}, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agregar]);

  const recargar = async () => {
    try {
      const [p, rs] = await Promise.all([getResourcePoint(pointId), listResources(pointId)]);
      setPunto(p);
      setRecursos(rs);
    } catch (err) {
      notify.error("No se pudieron cargar los recursos", err instanceof Error ? err.message : "");
    }
  };

  useEffect(() => {
    setCargando(true);
    Promise.all([
      recargar(),
      listResourceTypes()
        .then(setTipos)
        .catch(() => {}),
    ]).finally(() => setCargando(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointId]);

  // La flota ENTERA, de todos los puntos. Se carga una vez al entrar y sirve a
  // dos cosas distintas:
  //
  //   - la foto de referencia por tipo del selector, que sale de la flota real:
  //     la imagen que acompaña a "TOLVA" es literalmente una tolva de la
  //     municipalidad y no una ilustración genérica. Se piden todos los puntos
  //     porque un punto recién creado no tiene ninguna unidad, y es justo
  //     cuando más ayuda ver de qué se está hablando.
  //   - el control de patente repetida, que tiene que mirar TODOS los puntos:
  //     una patente es única en el país, no dentro de un patio. El número de
  //     equipo, en cambio, se compara solo contra los hermanos de este punto,
  //     porque así está definido el índice único del backend.
  const [flotaCompleta, setFlotaCompleta] = useState<Resource[]>([]);
  useEffect(() => {
    listResources()
      .then(setFlotaCompleta)
      .catch(() => {});
  }, [recursos]);

  const fotoPorTipo = useMemo(() => {
    const mapa: Record<string, string> = {};
    for (const r of flotaCompleta) {
      if (r.foto && !mapa[r.tipo]) mapa[r.tipo] = r.foto;
    }
    return mapa;
  }, [flotaCompleta]);

  // Qué declara al menos una unidad de cada tipo. Es lo que permite distinguir
  // un dato faltante de un dato que no sabemos si corresponde (ver capacidadDe).
  const declaradoPorTipo = useMemo(() => {
    const mapa: Record<string, { carga: boolean; balde: boolean }> = {};
    for (const r of recursos) {
      const acc = (mapa[r.tipo] ??= { carga: false, balde: false });
      if (r.capacidad_m3 != null) acc.carga = true;
      if (r.capacidad_balde_m3 != null) acc.balde = true;
    }
    return mapa;
  }, [recursos]);

  const capacidadDeFila = (r: Resource) =>
    capacidadDe(r, declaradoPorTipo[r.tipo] ?? { carga: false, balde: false });

  const alternarOrden = (campo: Campo) => {
    if (campo === sortBy) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(campo);
      setSortDir("asc");
    }
  };

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const filtrados = recursos.filter((r) => {
      if (filtroEstado === "disponibles" && !r.disponible) return false;
      if (filtroEstado === "no" && r.disponible) return false;
      if (!q) return true;
      // Se busca por todo lo que identifica a una unidad en la conversación
      // real: "la 2184", "la KZRB-69", "las tolvas", "las Hino".
      return [r.numero_equipo, r.patente, r.tipo, r.marca, r.modelo]
        .filter(Boolean)
        .some((campo) => campo.toLowerCase().includes(q));
    });

    const signo = sortDir === "asc" ? 1 : -1;
    return filtrados.sort((a, b) => {
      // Acá había una regla que ponía las unidades CON foto primero, por
      // encima del orden elegido. Se fue, y el motivo es concreto: con 21
      // unidades repartidas en páginas de 8, esa regla agrupaba las 13 con
      // foto en las primeras páginas y las 8 sin foto al final, así que al
      // ordenar por capacidad las cifras parecían reiniciarse en cada página y
      // el orden se leía como si fuera solo de la página visible. No lo era,
      // el orden siempre fue sobre la lista completa, pero eso es
      // indistinguible cuando hay una segunda clave mandando por encima.
      switch (sortBy) {
        case "estado":
          return (Number(b.disponible) - Number(a.disponible)) * signo;
        case "equipo":
          return (
            a.numero_equipo.localeCompare(b.numero_equipo, undefined, { numeric: true }) * signo
          );
        case "capacidad": {
          const ca = capacidadDeFila(a).valor ?? -1;
          const cb = capacidadDeFila(b).valor ?? -1;
          return (ca - cb) * signo;
        }
        case "peso": {
          const pa = a.capacidad_ton ?? -1;
          const pb = b.capacidad_ton ?? -1;
          return (pa - pb) * signo;
        }
        case "autonomia": {
          // Sin declarar va al fondo con -1, igual que la capacidad: en una
          // flota donde ninguna la declara el orden queda estable y no parece
          // aleatorio.
          const aa = a.autonomia_km ?? -1;
          const ab = b.autonomia_km ?? -1;
          return (aa - ab) * signo;
        }
        case "vehiculo":
          return `${a.marca} ${a.modelo}`.localeCompare(`${b.marca} ${b.modelo}`) * signo;
        case "tipo":
        default:
          return (
            (a.tipo.localeCompare(b.tipo) ||
              a.numero_equipo.localeCompare(b.numero_equipo, undefined, { numeric: true })) * signo
          );
      }
    });
  }, [recursos, busqueda, filtroEstado, sortBy, sortDir]);

  // ── Paginación según el alto disponible ───────────────────────────────────
  // No un número fijo: en una pantalla de 1440p entran bastantes más filas que
  // en un portátil, y un 10 fijo dejaría media tarjeta vacía arriba y páginas de
  // más abajo. Se mide la caja y se divide por el alto de una fila.
  const cajaTabla = useRef<HTMLDivElement>(null);
  const [porPagina, setPorPagina] = useState(8);
  useEffect(() => {
    const caja = cajaTabla.current;
    if (!caja) return;
    const medir = () => {
      // El alto de una fila se MIDE del DOM en vez de estimarse: depende de la
      // escala proporcional del sistema (el clamp de html en styles.css), así
      // que en 1440p una fila mide bastante más que en 1080p y cualquier
      // constante acierta en una resolución y falla en la otra.
      const fila = caja.querySelector("tbody tr");
      const encabezado = caja.querySelector("thead");
      const altoFila = fila?.getBoundingClientRect().height ?? 60;
      const altoEncabezado = encabezado?.getBoundingClientRect().height ?? 40;
      if (altoFila <= 0) return;
      const disponible = caja.clientHeight - altoEncabezado;
      // Mínimo 5: por debajo de eso paginar cuesta más de lo que ahorra.
      setPorPagina(Math.max(5, Math.floor(disponible / altoFila)));
    };
    medir();
    const observador = new ResizeObserver(medir);
    observador.observe(caja);
    return () => observador.disconnect();
    // Se vuelve a medir cuando aparecen filas: en el primer render la tabla
    // todavía no existe y no hay ninguna fila que medir.
  }, [cargando, recursos.length]);

  const totalPaginas = Math.max(1, Math.ceil(visibles.length / porPagina));
  // Filtrar deja la página actual fuera de rango (estabas en la 3 y ahora hay
  // una): sin esto la tabla se ve vacía aunque haya resultados.
  useEffect(() => setPagina((p) => Math.min(p, totalPaginas)), [totalPaginas]);
  const paginaActual = Math.min(pagina, totalPaginas);
  const desde = (paginaActual - 1) * porPagina;
  const enPagina = visibles.slice(desde, desde + porPagina);
  const noDisponibles = recursos.filter((r) => !r.disponible).length;

  const alternarDisponible = async (r: Resource) => {
    setAlternando(r.id);
    try {
      const actualizado = await setResourceAvailability(r.id, !r.disponible);
      setRecursos((prev) => prev.map((x) => (x.id === r.id ? actualizado : x)));
      // El punto trae su capacidad calculada por el backend: hay que volver a
      // pedirla, no recalcularla acá, o las dos cifras pueden discrepar.
      getResourcePoint(pointId)
        .then(setPunto)
        .catch(() => {});
    } catch (err) {
      notify.error(
        "No se pudo cambiar la disponibilidad",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
    } finally {
      setAlternando(null);
    }
  };

  /** Pone TODAS las unidades del punto en el mismo estado, en UNA petición.
   *
   *  No es solo comodidad: la municipalidad trabaja por jornada y hay días en
   *  que el patio entero sale o no sale, y hacerlo de a una en 21 filas es donde
   *  se cuelan los olvidos.
   *
   *  La primera versión recorría las 21 con un PATCH cada una y se sentía lenta
   *  de verdad; en paralelo habrían sido 21 escrituras compitiendo contra la
   *  misma colección, con el punto devolviendo una capacidad calculada a mitad
   *  de camino. El backend lo resuelve con un `update_many` y devuelve la lista
   *  ya actualizada. */
  const alternarTodos = async (disponible: boolean) => {
    setCambiandoTodos(true);
    try {
      const actualizados = await setPointResourcesAvailability(pointId, disponible);
      setRecursos(actualizados);
      notify.success(disponible ? "Todos disponibles" : "Ninguno disponible");
    } catch (err) {
      notify.error(
        "No se pudo cambiar la disponibilidad",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
      // La lista se vuelve a pedir: el update_many es atómico, así que o cambió
      // todo o no cambió nada, pero el error puede haber sido de red después de
      // la escritura y la tabla no debe quedar adivinando.
      listResources(pointId)
        .then(setRecursos)
        .catch(() => {});
    } finally {
      setCambiandoTodos(false);
      getResourcePoint(pointId)
        .then(setPunto)
        .catch(() => {});
    }
  };

  const confirmarEliminar = async () => {
    if (!aEliminar) return;
    setEliminando(true);
    try {
      await deleteResource(aEliminar.id);
      notify.success("Recurso eliminado");
      setAEliminar(null);
      await recargar();
    } catch (err) {
      notify.error("No se pudo eliminar", err instanceof Error ? err.message : "");
    } finally {
      setEliminando(false);
    }
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Encabezado con la misma estructura que Vista Principal y /recursos:
          rótulo, título y la acción a la derecha. Las cifras NO van acá sueltas
          al lado del botón, como estaban: quedaban sin caja, desalineadas con
          él y compitiendo con el título. Van abajo, en la franja .panel, que es
          donde el sistema pone las cifras de cabecera. */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/25 px-6 py-5">
        <div className="min-w-0">
          <p className="eyebrow">Recursos del punto</p>
          {punto ? (
            <h1 className="font-rubik text-3xl font-semibold tracking-normal text-foreground md:text-4xl">
              {punto.name}
            </h1>
          ) : (
            <Skeleton className="h-9 w-64 rounded md:h-10" />
          )}
          {/* La dirección se omite del subtítulo cuando el nombre YA es la
              dirección, que es como queda el punto importado de la planilla
              mientras la municipalidad no dé un nombre propio para el recinto.
              Repetir la misma línea dos veces se lee como un error. La comuna
              se muestra igual: no está en el título. */}
          {punto && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {[punto.address === punto.name ? null : punto.address, punto.comuna]
                .filter(Boolean)
                .join(", ")}
              {!punto.active && (
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide">
                  Inactivo
                </span>
              )}
            </p>
          )}
          {/* Debajo del bloque del título y en el navy del sidebar. Estuvo
              arriba como enlace gris chico y pasaba desapercibido: esta vista se
              abre desde otra y este es el único camino de vuelta, así que no
              puede ser lo menos visible de la pantalla.

              El color va con bg-sidebar y no con el variant por omisión, que usa
              --primary: son dos navy distintos (#070B14 contra #0F2244) y este
              tiene que leerse como "navegación", igual que el menú lateral, no
              como una acción sobre los datos. La acción principal sigue siendo
              el botón amarillo de la franja de abajo. */}
          <Link to="/planificacion/recursos" className="mt-3 inline-block">
            <Button className="bg-sidebar text-sidebar-foreground hover:bg-sidebar/90">
              <ArrowRightCircle className="mr-1.5 h-4 w-4 rotate-180" />
              Volver a los puntos
            </Button>
          </Link>
        </div>
      </div>

      <main className="flex min-h-0 flex-1 flex-col gap-5 p-6">
        {/* Franja de cifras, mismo tratamiento .panel que las otras dos vistas,
            y con la acción adentro: la franja es la cabecera de la flota y
            "Agregar recurso" actúa sobre esa flota, no sobre el punto.
            ml-auto la empuja al extremo, así el ancho de la franja no depende
            de cuántas cifras haya.

            Las tres cifras van al MISMO tamaño. Estuvieron con la capacidad al
            doble, y aunque sea la que decide, tres cifras de la misma
            naturaleza en una misma franja con tipografías distintas se leen
            como si una estuviera rota. La jerarquía la da el orden. */}
        {/* Los iconos son los MISMOS que en la lista de puntos para las mismas
            cosas: el cubo es siempre capacidad, el visto es siempre
            disponibilidad y el camión es siempre una unidad de la flota. Acá
            "Disponibles" llevaba camión y "Tipos distintos" repetía el cubo de
            capacidad, así que el mismo dibujo significaba dos cosas en la misma
            franja y dos dibujos distintos significaban lo mismo entre vistas. */}
        <div className="panel flex flex-wrap items-center divide-x divide-border/10 px-1">
          <Cifra
            icono={<Boxes className="h-4 w-4" />}
            etiqueta="Capacidad de transporte"
            valor={`${punto?.capacity_m3 ?? 0} m³`}
          />
          <Cifra
            icono={<CheckCircle2 className="h-4 w-4" />}
            etiqueta="Disponibles"
            valor={`${punto?.available_count ?? 0} de ${punto?.resource_count ?? 0}`}
          />
          <Cifra
            icono={<Layers className="h-4 w-4" />}
            etiqueta="Tipos distintos"
            valor={String(new Set(recursos.map((r) => r.tipo)).size)}
          />
          <div className="ml-auto border-l-0 px-5 py-3">
            <Button onClick={() => setEligiendoTipo(true)} className="btn-cta">
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Agregar recurso
            </Button>
          </div>
        </div>
        {/* El punto inactivo es el caso que más desconcierta: se pueden activar
            recursos uno por uno y la ruta sigue sin considerarlos, porque el
            ruteo descarta el punto entero antes de mirar sus unidades. */}
        {punto && !punto.active && punto.resource_count > 0 && (
          <p className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2.5 text-xs leading-relaxed">
            El punto está inactivo, así que sus recursos no participan de ninguna ruta aunque estén
            disponibles.
          </p>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
            {/* Disponibilidad de toda la flota, a la izquierda del buscador y
                con el MISMO interruptor que cada fila usa en su columna Estado:
                es la misma acción sobre todas en vez de sobre una, así que
                repetir el gesto es lo que la vuelve evidente sin explicarla.
                Dos botones hacían el mismo trabajo pero obligaban a leer cuál de
                los dos correspondía apretar. */}
            <div className="flex flex-shrink-0 items-center gap-2 rounded-md border border-border bg-background/60 py-1.5 pr-3 pl-2.5">
              <Switch
                checked={noDisponibles === 0}
                disabled={cambiandoTodos || recursos.length === 0}
                onCheckedChange={alternarTodos}
                aria-label="Disponibilidad de toda la flota"
              />
              <span className="text-xs font-medium whitespace-nowrap text-muted-foreground">
                {cambiandoTodos ? "Cambiando…" : noDisponibles === 0 ? "Todos" : "Ninguno"}
              </span>
            </div>

            <div className="relative min-w-[14rem] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar por número, patente, tipo o marca"
                className="h-8 pl-8 text-xs"
              />
            </div>

            {/* Tres estados y no un interruptor: "ver solo las no disponibles"
                es una pregunta tan frecuente como "ver las que puedo usar", y
                con un interruptor una de las dos queda sin atajo. */}
            <div className="flex items-center gap-1 rounded-md bg-background/60 p-0.5">
              {(
                [
                  ["todos", `Todos (${recursos.length})`],
                  ["disponibles", `Disponibles (${recursos.length - noDisponibles})`],
                  ["no", `No disponibles (${noDisponibles})`],
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

          {/* min-h-0 + flex-1: la caja mide siempre lo mismo, tenga 3 filas o
              10. Sin alto fijo, una página con menos filas encogía la tarjeta y
              los controles de paginación saltaban de lugar al cambiar de
              página. Es también lo que mide el ResizeObserver de arriba.

              overflow-y-auto y NO overflow-hidden. La paginación calcula cuántas
              filas entran, pero es una estimación sobre el alto de una fila, y
              si se queda corta con hidden las últimas quedaban recortadas sin
              ninguna forma de llegar a ellas. El cálculo evita que haya que
              desplazarse; el scroll es la red que impide que un error de
              cálculo esconda datos. */}
          <div ref={cajaTabla} className="min-h-0 flex-1 overflow-y-auto px-5">
            {cargando ? (
              <div className="space-y-2 py-4">
                {[0, 1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-md" />
                ))}
              </div>
            ) : recursos.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <Truck className="h-10 w-10 text-muted-foreground/30" />
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Este punto no tiene recursos
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Sin al menos un vehículo con capacidad de transporte no puede participar de una
                    ruta.
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setEligiendoTipo(true)}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Agregar el primero
                </Button>
              </div>
            ) : visibles.length === 0 ? (
              // Un filtro puede vaciar la tabla sin que el punto esté vacío.
              // Decir "este punto no tiene recursos" acá sería falso.
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <p className="text-sm text-muted-foreground">
                  Ninguna unidad coincide con la búsqueda.
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setBusqueda("");
                    setFiltroEstado("todos");
                  }}
                >
                  Limpiar filtros
                </Button>
              </div>
            ) : (
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <SortableHead
                      field="estado"
                      label="Estado"
                      className={ANCHOS.estado}
                      sortBy={sortBy}
                      sortDir={sortDir}
                      onSort={alternarOrden}
                    />
                    <TableHead className={ANCHOS.foto}></TableHead>
                    {/* El encabezado nombra los DOS datos de la celda: antes
                        decía solo "Equipo" y la patente aparecía abajo sin que
                        nada la anunciara. */}
                    <SortableHead
                      field="equipo"
                      label="Equipo / Patente"
                      className={ANCHOS.equipo}
                      sortBy={sortBy}
                      sortDir={sortDir}
                      onSort={alternarOrden}
                      align="center"
                    />
                    <SortableHead
                      field="tipo"
                      label="Tipo"
                      className={ANCHOS.tipo}
                      sortBy={sortBy}
                      sortDir={sortDir}
                      onSort={alternarOrden}
                    />
                    {/* La unidad va en la cabecera, como en el resto de las
                        tablas del sistema: repetida fila por fila descoloca las
                        cifras, que es la razón por la que una tabla gana a una
                        lista acá.

                        La columna tiene UNA excepción, los dos CAMION 3/4
                        PLANO, que declaran peso. No se resuelve poniéndole la
                        unidad a las 21 filas: esas dos la dicen en su propia
                        segunda línea ("kg · carga"), que ya existía para
                        calificar la cifra. Una excepción se marca donde ocurre,
                        no en el encabezado de todas. */}
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
                    {/* El límite de PESO, en su propia columna y no dentro de
                        la de capacidad: son dos magnitudes distintas del mismo
                        vehículo, y el AMPLIROLL declara las dos (20 m³ y 15 t).
                        Metidas en una sola celda, la de 15 t no se veía en
                        ninguna parte de la tabla y había que abrir la ficha de
                        cada unidad para encontrarla. */}
                    {/* En kg y no en t: todo el resto del sistema habla de peso
                        en kilos (el de cada zona, el de cada parada del plan),
                        así que una columna en toneladas obligaba a convertir de
                        cabeza para comparar la carga contra el límite del camión
                        que la va a llevar. El campo guardado sigue en toneladas,
                        que es como lo entregó la municipalidad. */}
                    <SortableHead
                      field="peso"
                      label="Peso máx."
                      unit="kg"
                      className={ANCHOS.peso}
                      sortBy={sortBy}
                      sortDir={sortDir}
                      onSort={alternarOrden}
                      align="center"
                    />
                    {/* AC3 de HDU5.1. Hoy toda la flota la tiene vacía, porque
                        la municipalidad respondió que ese límite no existe, así
                        que la columna muestra "sin límite" en las 21 filas. Se
                        incluye igual: es el único lugar donde se ve de un
                        vistazo cuáles declaran rango sin abrir la ficha de cada
                        unidad. */}
                    <SortableHead
                      field="autonomia"
                      label="Autonomía"
                      unit="km"
                      className={ANCHOS.autonomia}
                      sortBy={sortBy}
                      sortDir={sortDir}
                      onSort={alternarOrden}
                      align="center"
                    />
                    <SortableHead
                      field="vehiculo"
                      label="Vehículo"
                      className={ANCHOS.vehiculo}
                      sortBy={sortBy}
                      sortDir={sortDir}
                      onSort={alternarOrden}
                    />
                    <TableHead className={ANCHOS.acciones}></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {enPagina.map((r) => {
                    const cap = capacidadDeFila(r);
                    return (
                      <TableRow
                        key={r.id}
                        className="animate-in fade-in duration-300 fill-mode-both hover:bg-card/60"
                      >
                        {/* ESTADO PRIMERO, antes de la identidad: es lo que
                            decide si esta unidad entra en una ruta. */}
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={r.disponible}
                              disabled={alternando === r.id}
                              onCheckedChange={() => alternarDisponible(r)}
                              aria-label={
                                r.disponible
                                  ? `Marcar ${r.tipo} ${r.numero_equipo} como no disponible`
                                  : `Marcar ${r.tipo} ${r.numero_equipo} como disponible`
                              }
                            />
                            {alternando === r.id ? (
                              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                            ) : (
                              <span
                                className={`text-xs font-medium ${
                                  r.disponible ? "text-success-strong" : "text-muted-foreground"
                                }`}
                              >
                                {r.disponible ? "Disponible" : "No disponible"}
                              </span>
                            )}
                          </div>
                        </TableCell>

                        <TableCell>
                          <button
                            type="button"
                            onClick={() => r.foto && setFotoAmpliada(r.foto)}
                            disabled={!r.foto}
                            title={r.foto ? "Ver la foto en grande" : "Sin imagen todavía"}
                            className={`detect-frame detect-frame-sm block h-16 w-24 overflow-hidden rounded-md bg-muted ${
                              r.disponible ? "" : "opacity-50 grayscale"
                            } ${r.foto ? "cursor-zoom-in transition-transform hover:scale-105" : "cursor-default"}`}
                          >
                            <span className="detect-corners" aria-hidden="true" />
                            {r.foto ? (
                              <img
                                src={resourcePhotoUrl(r.foto)}
                                alt={`${r.tipo} ${r.numero_equipo}`}
                                className="h-full w-full object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <span className="flex h-full w-full items-center justify-center">
                                <ImageOff className="h-5 w-5 text-muted-foreground/40" />
                              </span>
                            )}
                          </button>
                        </TableCell>

                        {/* Centrado: son dos identificadores cortos, y alineados
                            a la izquierda quedaban pegados a la foto con el
                            resto de la celda vacía. */}
                        <TableCell className="text-center">
                          <p className="mono text-xs font-semibold tabular-nums text-foreground">
                            {r.numero_equipo || "sin N°"}
                          </p>
                          <p className="mono text-xs text-muted-foreground">
                            {r.patente || "sin patente"}
                          </p>
                        </TableCell>

                        <TableCell className="text-xs font-medium">{r.tipo}</TableCell>

                        <TableCell className="text-center">
                          {cap.valor !== null ? (
                            <>
                              <p className="mono text-xs font-semibold tabular-nums text-foreground">
                                {cap.valor}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {cap.unidad === "m³" ? cap.nota : `${cap.unidad} · ${cap.nota}`}
                              </p>
                            </>
                          ) : (
                            <p
                              className={`text-xs ${
                                cap.falta ? "text-warning-strong" : "text-muted-foreground"
                              }`}
                            >
                              {cap.nota}
                            </p>
                          )}
                        </TableCell>

                        {/* Mismo criterio que la autonomía: "sin límite" solo
                            para las familias que pueden declararlo (carga y
                            arrastre), y `—` para las que no, que sugeriría un
                            dato faltante en vez de uno que no aplica. */}
                        <TableCell className="text-center">
                          {r.capacidad_ton != null ? (
                            <p className="mono text-xs font-semibold tabular-nums text-foreground">
                              {(r.capacidad_ton * 1000).toLocaleString("es-CL")}
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              {r.familia === "carga" || r.familia === "arrastre"
                                ? "sin límite"
                                : "—"}
                            </p>
                          )}
                        </TableCell>

                        {/* AC3. "sin límite" solo para los que podrían tenerla:
                            un carro remolcado o una retro no declaran autonomía
                            propia, y decirles "sin límite" sugeriría que es un
                            dato que falta en vez de uno que no aplica. */}
                        <TableCell className="text-center">
                          {r.autonomia_km != null ? (
                            <p className="mono text-xs font-semibold tabular-nums text-foreground">
                              {r.autonomia_km}
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              {r.familia === "carga" ? "sin límite" : "—"}
                            </p>
                          )}
                        </TableCell>

                        <TableCell>
                          <p className="text-xs text-muted-foreground">
                            {[r.marca, r.modelo, r.anio].filter(Boolean).join(" ") || "-"}
                          </p>
                          <p className="text-xs text-muted-foreground/80">{dotacionTexto(r)}</p>
                        </TableCell>

                        {/* "Ver recurso" y la papelera, en ese orden. El lápiz
                            se fue de la fila: editar vive dentro de la ficha,
                            que es donde se ve lo que se va a cambiar. Tener las
                            dos entradas obligaba a decidir por cuál entrar
                            antes de saber qué trae la unidad.

                            La papelera se queda afuera y no entra a la ficha
                            porque borrar no necesita abrir nada, y enterrarla
                            un nivel más adentro convierte una acción de una
                            fila en una de tres pasos. Va visible siempre, igual
                            que en la lista de zonas: escondida hasta pasar el
                            cursor, solo la encuentra quien usa ratón. */}
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            <Button size="sm" onClick={() => setEnDetalle(r)}>
                              <Eye className="mr-1.5 h-3.5 w-3.5" /> Ver recurso
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 w-8 p-0 text-muted-foreground hover:bg-destructive/15 hover:text-destructive-strong"
                              onClick={() => setAEliminar(r)}
                              title="Eliminar recurso"
                              aria-label={`Eliminar ${r.tipo} ${r.numero_equipo}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>

          {/* Los controles solo aparecen cuando hay más de una página. */}
          {visibles.length > porPagina && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
              <p className="text-xs text-muted-foreground">
                Mostrando{" "}
                <span className="mono tabular-nums text-foreground">
                  {desde + 1}-{Math.min(desde + porPagina, visibles.length)}
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

      {/* ── AC1: el tipo, antes de cualquier campo ──
          Sigue siendo una modal porque el criterio pide que "Agregar recurso"
          PREGUNTE el tipo.

          Los nueve tipos van en UNA LISTA PLANA, sin agrupar. Estuvieron
          repartidos en "Transportan carga", "Máquinas, cargan pero no
          transportan", "Se remolcan" y "Apoyo y supervisión", y esa
          clasificación no sale de ningún lado: la planilla de la municipalidad
          no tiene columna de familia, la deduje yo de los nombres. Presentarla
          como encabezados de sección la convertiía en una afirmación sobre qué
          hace cada vehículo, y no está confirmada. Los tipos sí son dato: están
          escritos en la planilla. */}
      <Dialog open={eligiendoTipo} onOpenChange={setEligiendoTipo}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>¿Qué tipo de recurso vas a agregar?</DialogTitle>
          </DialogHeader>
          <p className="text-xs leading-relaxed text-muted-foreground">
            El tipo define qué datos pide el sistema después, así que se elige primero.
          </p>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {[...tipos]
              .sort((a, b) => a.tipo.localeCompare(b.tipo))
              .map((t) => {
                const foto = fotoPorTipo[t.tipo];
                return (
                  <button
                    key={t.tipo}
                    type="button"
                    onClick={() => {
                      setEligiendoTipo(false);
                      setEnEdicion(null);
                      setTipoNuevo(t.tipo);
                    }}
                    className="group cursor-pointer overflow-hidden rounded-lg border border-border/60 bg-background/60 text-left transition-all hover:border-primary hover:bg-primary/5"
                  >
                    <span className="block aspect-[4/3] w-full overflow-hidden bg-muted">
                      {foto ? (
                        <img
                          src={resourcePhotoUrl(foto)}
                          alt={t.tipo}
                          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                          loading="lazy"
                        />
                      ) : (
                        // Cuatro de los nueve tipos no tienen ninguna unidad con
                        // foto en toda la flota. Se dice, en vez de dejar un
                        // hueco gris que parezca una imagen que no cargó.
                        <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
                          <ImageOff className="h-5 w-5 opacity-50" />
                          <span className="text-[0.625rem]">Sin foto de referencia</span>
                        </span>
                      )}
                    </span>
                    <span className="block px-2 py-2 text-center text-xs font-medium leading-tight">
                      {t.tipo}
                    </span>
                  </button>
                );
              })}
          </div>
        </DialogContent>
      </Dialog>

      <ResourceFormDialog
        abierto={tipoNuevo !== null || enEdicion !== null}
        onOpenChange={(a) => {
          if (!a) {
            setTipoNuevo(null);
            setEnEdicion(null);
          }
        }}
        pointId={pointId}
        nombrePunto={punto?.name ?? "el punto"}
        tipoNuevo={tipoNuevo}
        recurso={enEdicion}
        tipos={tipos}
        hermanos={recursos}
        flota={flotaCompleta}
        onGuardado={recargar}
      />

      {/* Ficha del recurso, en solo lectura. Foto grande a la izquierda y los
          datos a la derecha: la misma forma que el formulario, para que ver y
          editar se lean como la misma cosa de dos maneras.
          No agrega ningún dato que la tabla no tenga ya calculado, usa
          capacidadDeFila igual que las filas, así que no afirma nada sobre un
          tipo que la planilla de la municipalidad no diga. */}
      <Dialog
        open={enDetalle !== null}
        onOpenChange={(abierto) => {
          if (!abierto) setEnDetalle(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {enDetalle?.tipo} {enDetalle?.numero_equipo}
              {enDetalle && (
                <span
                  className={`rounded px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide ${
                    enDetalle.disponible
                      ? "bg-success/15 text-success-strong"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {enDetalle.disponible ? "Disponible" : "No disponible"}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          {enDetalle && (
            <div className="grid gap-5 md:grid-cols-[17rem_1fr]">
              <button
                type="button"
                onClick={() => enDetalle.foto && setFotoAmpliada(enDetalle.foto)}
                disabled={!enDetalle.foto}
                title={enDetalle.foto ? "Ver la foto en grande" : "Sin imagen todavía"}
                className={`detect-frame relative block aspect-[16/10] w-full self-start overflow-hidden rounded-lg border border-border bg-muted ${
                  enDetalle.foto ? "cursor-zoom-in" : "cursor-default"
                }`}
              >
                <span className="detect-corners" aria-hidden="true" />
                {enDetalle.foto ? (
                  <img
                    src={resourcePhotoUrl(enDetalle.foto)}
                    alt={`${enDetalle.tipo} ${enDetalle.numero_equipo}`}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                    <ImageOff className="h-8 w-8 opacity-40" />
                    <span className="text-xs">Sin imagen todavía</span>
                  </span>
                )}
              </button>

              <div className="flex flex-col gap-5">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3.5">
                  <Dato etiqueta="N° de equipo" valor={enDetalle.numero_equipo || "sin N°"} />
                  <Dato etiqueta="Patente" valor={enDetalle.patente || "sin patente"} />
                  <Dato etiqueta="Tipo" valor={enDetalle.tipo} />
                  <Dato
                    etiqueta="Vehículo"
                    valor={
                      [enDetalle.marca, enDetalle.modelo, enDetalle.anio]
                        .filter(Boolean)
                        .join(" ") || "sin datos"
                    }
                  />
                  <Dato
                    etiqueta="Capacidad"
                    valor={
                      capacidadDeFila(enDetalle).valor !== null
                        ? `${capacidadDeFila(enDetalle).valor} ${capacidadDeFila(enDetalle).unidad} de ${capacidadDeFila(enDetalle).nota}`
                        : capacidadDeFila(enDetalle).nota
                    }
                    alerta={capacidadDeFila(enDetalle).falta}
                  />
                  {/* El peso máximo, solo cuando la fila de arriba está
                      mostrando OTRA cosa. El AMPLIROLL declara 20 m³ y 15 t: la
                      celda de la tabla y la fila Capacidad muestran el volumen,
                      que es lo que el ruteo usa, así que sin esta fila su
                      límite de peso no se vería en ninguna parte.

                      El CAMION 3/4 PLANO, en cambio, declara SOLO peso, y
                      entonces la fila Capacidad ya dice "1.000 kg de carga":
                      repetirlo acá imprimiría la misma cifra dos veces con dos
                      nombres distintos, que se lee como si fueran dos límites. */}
                  {enDetalle.capacidad_ton != null && enDetalle.capacidad_m3 != null && (
                    <Dato
                      etiqueta="Peso máximo"
                      valor={`${(enDetalle.capacidad_ton * 1000).toLocaleString("es-CL")} kg`}
                    />
                  )}
                  {/* AC3. Solo si está declarada: "sin límite" es el estado
                      normal de esta flota, y una fila que lo repita en las 21
                      unidades es ruido. */}
                  {enDetalle.autonomia_km != null && (
                    <Dato etiqueta="Autonomía" valor={`${enDetalle.autonomia_km} km`} />
                  )}
                  <Dato etiqueta="Dotación requerida" valor={dotacionTexto(enDetalle)} />
                  <Dato etiqueta="Punto" valor={punto?.name ?? "-"} />
                  {/* AC5 de HDU8, dicho donde se mira la unidad. Que un recurso
                      esté "disponible" y que sume a una ruta son dos cosas
                      distintas: lo primero es un estado operativo que el
                      trabajador controla, lo segundo se deriva de la familia y
                      de la capacidad declarada. Sin esta línea había que
                      deducirlo comparando cifras entre dos pantallas. */}
                  <Dato
                    etiqueta="Participa en rutas"
                    valor={
                      motivoFueraDeRuta(enDetalle)
                        ? `No, ${TEXTO_FUERA_DE_RUTA[motivoFueraDeRuta(enDetalle)!]}`
                        : `Sí, aporta ${enDetalle.capacidad_m3} m³`
                    }
                    alerta={motivoFueraDeRuta(enDetalle) === "sin_capacidad"}
                  />
                </dl>

                <div className="flex gap-2 border-t border-border/40 pt-4">
                  <Button
                    className="flex-1"
                    onClick={() => {
                      setTipoNuevo(null);
                      setEnEdicion(enDetalle);
                      setEnDetalle(null);
                    }}
                  >
                    <Pencil className="mr-1.5 h-4 w-4" /> Editar este recurso
                  </Button>
                  <Button variant="secondary" onClick={() => setEnDetalle(null)}>
                    Cerrar
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={fotoAmpliada !== null}
        onOpenChange={(a) => {
          if (!a) setFotoAmpliada(null);
        }}
      >
        <DialogContent className="max-w-3xl overflow-hidden p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>Foto del recurso</DialogTitle>
          </DialogHeader>
          {fotoAmpliada && (
            <img
              src={resourcePhotoUrl(fotoAmpliada)}
              alt="Foto del recurso"
              className="h-auto w-full"
            />
          )}
        </DialogContent>
      </Dialog>

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
              Eliminar recurso
            </AlertDialogTitle>
            <AlertDialogDescription>
              {aEliminar && (
                <>
                  Se va a eliminar {aEliminar.tipo} {aEliminar.numero_equipo || "sin número"}
                  {aEliminar.patente && ` (${aEliminar.patente})`}. No se puede deshacer. Si el
                  vehículo está fuera de servicio de forma temporal, conviene marcarlo como no
                  disponible en vez de borrarlo.
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

/** Una cifra de la franja de cabecera: ícono, etiqueta chica y el número en
 *  .mono, que es donde el sistema pone las magnitudes.
 *
 *  El ícono va SIN pastilla de fondo. Con ella, tres cuadrados de color al hilo
 *  pesaban más que las cifras que acompañan, y la franja se leía como una fila
 *  de botones en vez de como datos. */
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

/** Un dato de la ficha: etiqueta chica arriba, valor debajo. `alerta` lo pinta
 *  en ámbar y es el mismo criterio que la tabla, un hueco real y no algo que
 *  simplemente no sabemos (ver capacidadDe). */
function Dato({
  etiqueta,
  valor,
  alerta = false,
}: {
  etiqueta: string;
  valor: string;
  alerta?: boolean;
}) {
  return (
    <div>
      <dt className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">{etiqueta}</dt>
      <dd className={`mt-0.5 text-xs ${alerta ? "text-warning-strong" : "text-foreground"}`}>
        {valor}
      </dd>
    </div>
  );
}
