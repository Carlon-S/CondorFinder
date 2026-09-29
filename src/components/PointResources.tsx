// =============================================================================
// CONDORFINDER, RECURSOS DE UN PUNTO (HDU8)
// Archivo: src/components/PointResources.tsx
//
// Los cuatro criterios de HDU8 que se ven en pantalla viven acá:
//
//   AC1  "Agregar recurso" pide el TIPO antes de cualquier otra cosa.
//   AC2  Al elegir el tipo, el formulario pide los campos de su familia.
//   AC3  "Editar" sobre un recurso registrado permite modificar su registro.
//   AC4  El interruptor alterna disponible / no disponible.
//
// El AC5 (un recurso no disponible queda excluido al armar una ruta) es del
// backend, en capacidad_de_carga_por_punto. Lo que aporta esta vista es que se
// VEA por qué un recurso no cuenta, para que el criterio sea observable y no un
// acto de fe.
//
// Componente aparte y no más código dentro de recursos.tsx, que ya pasaba las
// 870 líneas. Vive junto al punto porque un recurso no existe sin un punto de
// salida: una lista global de 21 vehículos sin decir de dónde salen no sirve
// para planificar nada.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { ImageOff, ImagePlus } from "lucide-react";
import {
  AlertTriangle,
  Boxes,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Truck,
  X,
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
import { notify } from "@/lib/notify";
import {
  camposDeFamilia,
  createResource,
  deleteResource,
  listResourceTypes,
  listResources,
  recursoVacio,
  resourcePhotoUrl,
  setResourceAvailability,
  updateResource,
  uploadResourcePhoto,
  type Resource,
  type ResourceFamily,
  type ResourceInput,
  type ResourcePoint,
  type ResourceType,
} from "@/lib/resources";

/** Qué dice cada familia sobre su capacidad. "Sin capacidad declarada" solo
 *  tiene sentido donde debería haberla: un carro de arrastre no transporta, no
 *  es que le falte un dato, y mostrar lo mismo en los dos casos haría parecer
 *  incompleta una planilla que está completa. */
function textoCapacidad(r: Resource): {
  /** La cifra sola, para que la columna alinee. null cuando no hay. */
  valor: string | null;
  /** Qué decir en su lugar cuando no hay cifra. */
  texto: string;
  /** true solo cuando el dato DEBERÍA estar y no está, que es lo que se pinta
   *  en color de advertencia. Una máquina sin capacidad de carga no es un dato
   *  faltante: es que no transporta. */
  falta: boolean;
} {
  if (r.familia === "carga") {
    return r.capacidad_m3 != null
      ? { valor: `${r.capacidad_m3}`, texto: "", falta: false }
      : { valor: null, texto: "sin declarar", falta: true };
  }
  if (r.familia === "maquina") {
    return r.capacidad_balde_m3 != null
      ? { valor: `balde ${r.capacidad_balde_m3}`, texto: "", falta: false }
      : { valor: null, texto: "balde sin declarar", falta: true };
  }
  if (r.familia === "arrastre") return { valor: null, texto: "se remolca", falta: false };
  return { valor: null, texto: "no transporta", falta: false };
}

/** Encabezado de la tabla. Una sola definición para la tabla real y su
 *  esqueleto: mantener dos copias ya derivó una vez en anchos distintos, y
 *  cualquier diferencia mueve las columnas justo cuando llegan los datos.
 *
 *  La unidad va acá y no en cada celda, igual que en el listado de zonas de
 *  Vista Principal. */
/** Dotación que el vehículo REQUIERE para operar, no el personal que el punto
 *  tiene. Son magnitudes distintas y cruzarlas es trabajo de HDU5.1. */
function dotacionTexto(r: ResourceInput): string {
  const partes = [
    r.conductores_requeridos && `${r.conductores_requeridos} conductor${r.conductores_requeridos > 1 ? "es" : ""}`,
    r.peonetas_requeridas && `${r.peonetas_requeridas} peoneta${r.peonetas_requeridas > 1 ? "s" : ""}`,
    r.operadores_requeridos && `${r.operadores_requeridos} operador${r.operadores_requeridos > 1 ? "es" : ""}`,
  ].filter(Boolean);
  return partes.length > 0 ? partes.join(" + ") : "sin dotación declarada";
}

/** Anchos de las columnas, declarados en porcentaje y en un solo lugar.
 *
 *  Van con `table-fixed` en la tabla: con el ancho automático del navegador
 *  cada columna mide lo que mide su contenido más largo, así que "Vehículo" se
 *  comía el espacio con un "CATERPILLAR 416F2 2018" y "Capacidad (m³)" quedaba
 *  tan angosta que el encabezado se partía en dos líneas. Con anchos fijos las
 *  columnas quedan parejas y el encabezado entra entero. */
const ANCHOS = {
  estado: "w-[15%]",
  foto: "w-[9%]",
  equipo: "w-[15%]",
  tipo: "w-[17%]",
  capacidad: "w-[14%]",
  vehiculo: "w-[22%]",
  acciones: "w-[8%]",
} as const;

function EncabezadoRecursos() {
  return (
    <TableRow className="bg-muted/50 hover:bg-muted/50">
      <TableHead className={ANCHOS.estado}>Estado</TableHead>
      <TableHead className={ANCHOS.foto}></TableHead>
      <TableHead className={ANCHOS.equipo}>Equipo</TableHead>
      <TableHead className={ANCHOS.tipo}>Tipo</TableHead>
      {/* whitespace-nowrap: la unidad es parte del nombre de la columna y
          partida en dos líneas deja de leerse como tal. */}
      <TableHead className={`${ANCHOS.capacidad} whitespace-nowrap text-right`}>
        Capacidad <span className="mono opacity-70">(m³)</span>
      </TableHead>
      <TableHead className={ANCHOS.vehiculo}>Vehículo</TableHead>
      <TableHead className={ANCHOS.acciones}></TableHead>
    </TableRow>
  );
}

export function PointResources({
  point,
  onChanged,
}: {
  point: ResourcePoint;
  /** Se llama tras cualquier escritura para que el padre refresque los puntos:
   *  su resumen (capacidad, disponibles) lo calcula el backend, así que no se
   *  puede recalcular acá sin arriesgar que las dos cifras discrepen. */
  onChanged: () => void;
}) {
  const [recursos, setRecursos] = useState<Resource[]>([]);
  const [tipos, setTipos] = useState<ResourceType[]>([]);
  const [cargando, setCargando] = useState(true);
  const [alternando, setAlternando] = useState<string | null>(null);

  // AC1: elegir el tipo es un paso PREVIO al formulario, no un campo dentro de
  // él. Es lo que decide qué se pregunta después, así que preguntarlo al medio
  // de un formulario ya abierto obligaría a rearmar los campos bajo el cursor.
  const [eligiendoTipo, setEligiendoTipo] = useState(false);
  const [borrador, setBorrador] = useState<ResourceInput | null>(null);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [aEliminar, setAEliminar] = useState<Resource | null>(null);
  // Foto que se está mirando en grande. Es su propio estado y no un booleano
  // porque se abre desde dos lugares (la tabla y el formulario) y cada uno
  // muestra una imagen distinta.
  const [fotoAmpliada, setFotoAmpliada] = useState<string | null>(null);
  const [subiendoFoto, setSubiendoFoto] = useState(false);
  const inputFoto = useRef<HTMLInputElement>(null);
  const [eliminando, setEliminando] = useState(false);

  const recargar = () => {
    setCargando(true);
    listResources(point.id)
      .then(setRecursos)
      .catch((err) =>
        notify.error("No se pudieron cargar los recursos", err instanceof Error ? err.message : ""),
      )
      .finally(() => setCargando(false));
  };

  useEffect(() => {
    recargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point.id]);

  useEffect(() => {
    listResourceTypes().then(setTipos).catch(() => {});
  }, []);

  const familiaDe = (tipo: string): ResourceFamily =>
    tipos.find((t) => t.tipo === tipo)?.familia ?? "apoyo";

  // Buscar y filtrar. Con 21 unidades no es un lujo: encontrar "la 2184" o
  // "las que están en taller" significaba leer la tabla entera. Vive en el
  // componente y no en la URL porque es un filtro de trabajo momentáneo, no un
  // estado que tenga sentido compartir por link.
  const [busqueda, setBusqueda] = useState("");
  const [filtroEstado, setFiltroEstado] = useState<"todos" | "disponibles" | "no">("todos");

  // Ordenados por tipo y después por N° de equipo. Con la columna "Tipo" a la
  // vista no hace falta agrupar con encabezados intermedios: sería repetir el
  // mismo dato dos veces, una en el separador y otra en cada fila.
  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return recursos
      .filter((r) => {
        if (filtroEstado === "disponibles" && !r.disponible) return false;
        if (filtroEstado === "no" && r.disponible) return false;
        if (!q) return true;
        // Se busca por todo lo que identifica a una unidad en la conversación
        // real: "la 2184", "la KZRB-69", "las tolvas", "las Hino".
        return [r.numero_equipo, r.patente, r.tipo, r.marca, r.modelo]
          .filter(Boolean)
          .some((campo) => campo.toLowerCase().includes(q));
      })
      .sort(
        (a, b) =>
          a.tipo.localeCompare(b.tipo) ||
          a.numero_equipo.localeCompare(b.numero_equipo, undefined, { numeric: true }),
      );
  }, [recursos, busqueda, filtroEstado]);

  const noDisponibles = recursos.filter((r) => !r.disponible).length;

  // Paginación. Con 21 unidades la tabla entera empujaba el resto de la página
  // hacia abajo y obligaba a desplazarse para volver a los filtros; con
  // páginas, la vista mide siempre lo mismo.
  const POR_PAGINA = 10;
  const [pagina, setPagina] = useState(1);
  const totalPaginas = Math.max(1, Math.ceil(visibles.length / POR_PAGINA));

  // Filtrar deja la página actual fuera de rango (estabas en la 3 y ahora hay
  // una): sin esto la tabla se ve vacía aunque haya resultados.
  useEffect(() => {
    setPagina((p) => Math.min(p, totalPaginas));
  }, [totalPaginas]);

  const pagina_actual = Math.min(pagina, totalPaginas);
  const desde = (pagina_actual - 1) * POR_PAGINA;
  const enPagina = visibles.slice(desde, desde + POR_PAGINA);

  const abrirNuevo = (tipo: string) => {
    setEligiendoTipo(false);
    setEditandoId(null);
    setBorrador(recursoVacio(tipo, point.id));
  };

  const abrirEdicion = (r: Resource) => {
    setEditandoId(r.id);
    // Se copian solo los campos de entrada: id, owner, created_at y familia son
    // del backend y mandarlos de vuelta no tendría sentido.
    setBorrador({
      tipo: r.tipo,
      numero_equipo: r.numero_equipo,
      patente: r.patente,
      marca: r.marca,
      modelo: r.modelo,
      anio: r.anio,
      capacidad_m3: r.capacidad_m3,
      capacidad_balde_m3: r.capacidad_balde_m3,
      conductores_requeridos: r.conductores_requeridos,
      peonetas_requeridas: r.peonetas_requeridas,
      operadores_requeridos: r.operadores_requeridos,
      observaciones: r.observaciones,
      foto: r.foto,
      disponible: r.disponible,
      point_id: point.id,
    });
  };

  /** Cambiar el tipo LIMPIA los campos de la familia anterior.
   *
   *  Sin esto, pasar de TOLVA a RETRO conservaba la capacidad de carga, y el
   *  backend rechaza ese campo en una máquina (no lo ignora: una capacidad de
   *  carga en una retroexcavadora la haría aparecer como transporte disponible
   *  en el ruteo). El resultado era un 422 y nadie podía adivinar qué campo
   *  sobraba, porque ya no estaba en pantalla. */
  const cambiarTipo = (tipo: string) => {
    if (!borrador) return;
    const limpio = recursoVacio(tipo, point.id);
    setBorrador({
      ...limpio,
      // Lo que no depende de la familia se conserva: si alguien se equivocó de
      // tipo, no tiene por qué volver a escribir la patente.
      numero_equipo: borrador.numero_equipo,
      patente: borrador.patente,
      observaciones: borrador.observaciones,
      foto: borrador.foto,
      disponible: borrador.disponible,
    });
  };

  const alternarDisponible = async (r: Resource) => {
    setAlternando(r.id);
    try {
      const actualizado = await setResourceAvailability(r.id, !r.disponible);
      setRecursos((prev) => prev.map((x) => (x.id === r.id ? actualizado : x)));
      onChanged();
    } catch (err) {
      notify.error(
        "No se pudo cambiar la disponibilidad",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
    } finally {
      setAlternando(null);
    }
  };

  const elegirFoto = async (archivo: File | undefined) => {
    if (!archivo || !borrador) return;
    setSubiendoFoto(true);
    try {
      // Se sube en el momento, no al guardar el formulario: así la miniatura se
      // ve de inmediato y no hay que cargar el archivo en memoria hasta que
      // alguien apriete Guardar. El costo es que una foto subida y después
      // cancelada queda huérfana en disco; son unos 60 kB y el caso es poco
      // frecuente, mucho menos malo que una carga que falla recién al final.
      const nombre = await uploadResourcePhoto(archivo);
      setBorrador({ ...borrador, foto: nombre });
    } catch (err) {
      notify.error(
        "No se pudo subir la imagen",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
    } finally {
      setSubiendoFoto(false);
      // Sin esto, volver a elegir EL MISMO archivo no dispara onChange.
      if (inputFoto.current) inputFoto.current.value = "";
    }
  };

  const guardar = async () => {
    if (!borrador) return;

    // El N° de equipo es único por punto (índice parcial en Mongo). Se avisa
    // acá antes de enviar: el índice devuelve un error de duplicado que no dice
    // qué campo lo causó.
    const repetido = recursos.find(
      (r) =>
        r.id !== editandoId &&
        r.numero_equipo &&
        r.numero_equipo.trim() === borrador.numero_equipo.trim(),
    );
    if (borrador.numero_equipo.trim() && repetido) {
      notify.error(
        "N° de equipo repetido",
        `Este punto ya tiene el equipo ${repetido.numero_equipo} (${repetido.tipo}). Es el identificador con el que la municipalidad nombra sus vehículos, así que no puede repetirse.`,
      );
      return;
    }

    // La patente sí puede chocar entre puntos, y se avisa sin bloquear:
    // bloquear impediría corregir un tipeo pasando por un estado intermedio.
    const patenteRepetida = recursos.find(
      (r) => r.id !== editandoId && r.patente && r.patente.trim() === borrador.patente.trim(),
    );
    if (borrador.patente.trim() && patenteRepetida) {
      notify.warning(
        "Patente repetida",
        `El equipo ${patenteRepetida.numero_equipo || "sin número"} ya tiene la patente ${patenteRepetida.patente}. Se guarda igual, pero conviene revisarlo.`,
      );
    }

    setGuardando(true);
    try {
      if (editandoId) {
        await updateResource(editandoId, borrador);
        notify.success("Recurso actualizado");
      } else {
        await createResource(borrador);
        notify.success("Recurso agregado", `${borrador.tipo} en ${point.name}.`);
      }
      setBorrador(null);
      setEditandoId(null);
      recargar();
      onChanged();
    } catch (err) {
      notify.error(
        editandoId ? "No se pudo actualizar el recurso" : "No se pudo guardar el recurso",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
    } finally {
      setGuardando(false);
    }
  };

  const confirmarEliminar = async () => {
    if (!aEliminar) return;
    setEliminando(true);
    try {
      await deleteResource(aEliminar.id);
      notify.success("Recurso eliminado");
      setAEliminar(null);
      recargar();
      onChanged();
    } catch (err) {
      notify.error("No se pudo eliminar", err instanceof Error ? err.message : "");
    } finally {
      setEliminando(false);
    }
  };

  const campos = borrador ? camposDeFamilia(familiaDe(borrador.tipo)) : null;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {/* Encabezado de la tarjeta, mismo tratamiento que el listado de zonas de
          Vista Principal: título, las dos cifras que deciden, y la acción. */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-2.5 border-l-2 border-primary/50 pl-3">
          <Truck className="h-3.5 w-3.5 text-foreground/70" />
          <h3 className="text-sm font-semibold tracking-tight text-foreground">
            Recursos de {point.name}
          </h3>
        </div>

        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Boxes className="h-3.5 w-3.5 text-primary/70" />
            Capacidad
            <span className="mono font-semibold tabular-nums text-foreground">
              {point.capacity_m3} m³
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            Disponibles
            <span className="mono font-semibold tabular-nums text-foreground">
              {point.available_count} de {point.resource_count}
            </span>
          </span>
        </div>

        <Button size="sm" className="ml-auto" variant="secondary" onClick={() => setEligiendoTipo(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Agregar recurso
        </Button>
      </div>

      {/* Buscar y filtrar. El artículo de Volpis lo pone como "filters as
          first-class citizens", y acá se gana de verdad: con 21 unidades,
          encontrar "la 2184" o ver cuáles están en taller significaba leer la
          tabla entera. Lo que NO se tomó de ahí es la búsqueda global por tipo
          de entidad ("Sara" devuelve el conductor): no existen conductores ni
          viajes como entidades en este sistema todavía. */}
      {recursos.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por número, patente, tipo o marca"
              className="h-8 pl-8 text-xs"
            />
          </div>

          {/* Tres estados y no un interruptor: "ver solo las que están en
              taller" es una pregunta tan frecuente como "ver las que puedo
              usar", y con un interruptor una de las dos queda sin atajo. */}
          <div className="flex items-center gap-1 rounded-md bg-background/60 p-0.5">
            {([
              ["todos", `Todos (${recursos.length})`],
              ["disponibles", `Disponibles (${recursos.length - noDisponibles})`],
              ["no", `En taller (${noDisponibles})`],
            ] as const).map(([valor, etiqueta]) => (
              <button
                key={valor}
                type="button"
                onClick={() => setFiltroEstado(valor)}
                className={`cursor-pointer rounded px-2.5 py-1 text-[0.6875rem] font-medium transition-colors ${
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
      )}

      {/* El punto inactivo es el caso que mas desconcierta: se pueden activar
          recursos uno por uno y la ruta sigue sin considerarlos, porque el ruteo
          descarta el punto entero antes de mirar sus unidades. */}
      {!point.active && point.resource_count > 0 && (
        <p className="border-b border-warning/40 bg-warning/10 px-5 py-2.5 text-xs leading-relaxed">
          El punto está inactivo, así que sus recursos no participan de ninguna ruta
          aunque estén disponibles.
        </p>
      )}

      <div className="px-5 pb-5">
        {cargando ? (
          <Table className="table-fixed">
            <TableHeader>
              <EncabezadoRecursos />
            </TableHeader>
            <TableBody>
              {[0, 1, 2, 3].map((n) => (
                <TableRow key={n} className="hover:bg-transparent">
                  <TableCell><Skeleton className="h-11 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="ml-auto h-4 w-12" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-9" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-16" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : recursos.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <Truck className="h-10 w-10 text-muted-foreground/30" />
            <div>
              <p className="text-sm font-semibold text-foreground">Este punto no tiene recursos</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Sin al menos un vehículo con capacidad de transporte no puede participar
                de una ruta.
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setEligiendoTipo(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Agregar el primero
            </Button>
          </div>
        ) : visibles.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Ninguna unidad coincide con la búsqueda.
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
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
              <EncabezadoRecursos />
            </TableHeader>
            <TableBody>
              {enPagina.map((r) => {
                const cap = textoCapacidad(r);
                return (
                  <TableRow
                    key={r.id}
                    className="group animate-in fade-in duration-300 fill-mode-both hover:bg-card/60"
                  >
                    {/* ESTADO PRIMERO, antes de la identidad. La disponibilidad
                        es lo que decide si esta unidad entra o no en una ruta, y
                        estaba en la novena columna: había que recorrer la fila
                        entera para saber lo único accionable de ella.

                        El interruptor va junto a la etiqueta y no en el extremo
                        opuesto: leer el estado y cambiarlo son el mismo gesto.
                        AC4 de HDU8. */}
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
                          // El color dice el estado, y usa la variante -strong
                          // porque como TEXTO sobre el cuerpo claro las de
                          // relleno no llegan al contraste mínimo.
                          <span
                            className={`text-[0.6875rem] font-semibold ${
                              r.disponible ? "text-success-strong" : "text-muted-foreground"
                            }`}
                          >
                            {r.disponible ? "Disponible" : "En taller"}
                          </span>
                        )}
                      </div>
                    </TableCell>

                    <TableCell>
                      {/* Foto cuando existe, marcador cuando no. 8 de los 21
                          vehiculos de la flota real no tienen, asi que no es un
                          caso raro. */}
                      {/* Clickeable cuando hay foto: la miniatura mide 11x16 y
                          no alcanza para reconocer una unidad en patio. Cuando
                          no hay, DICE que no hay en vez de dejar un hueco. */}
                      <button
                        type="button"
                        onClick={() => r.foto && setFotoAmpliada(r.foto)}
                        disabled={!r.foto}
                        title={r.foto ? "Ver la foto en grande" : "Sin imagen todavía"}
                        aria-label={r.foto ? `Ver la foto de ${r.tipo} ${r.numero_equipo}` : undefined}
                        className={`detect-frame detect-frame-sm block h-11 w-16 overflow-hidden rounded-md bg-muted ${
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
                            <ImageOff className="h-4 w-4 text-muted-foreground/40" />
                          </span>
                        )}
                      </button>
                    </TableCell>

                    {/* Numero y patente en dos lineas, mismo patron que la lista
                        de zonas detectadas: identifican a la misma unidad, no
                        son dos datos que se comparen entre filas. Eso libera una
                        columna. */}
                    <TableCell>
                      <p className="mono text-xs font-semibold tabular-nums text-foreground">
                        {r.numero_equipo || "sin N°"}
                      </p>
                      <p className="mono text-[0.6875rem] text-muted-foreground">
                        {r.patente || "sin patente"}
                      </p>
                    </TableCell>

                    <TableCell className="font-medium">{r.tipo}</TableCell>

                    {/* La unidad va en el encabezado y no en cada celda, igual
                        que en el listado de zonas: repetida por fila desalinea
                        las cifras de su propia columna. */}
                    <TableCell className="mono text-right tabular-nums">
                      {cap.valor !== null ? (
                        cap.valor
                      ) : (
                        <span
                          title={cap.texto}
                          className={`text-[0.6875rem] ${cap.falta ? "text-warning" : "text-muted-foreground"}`}
                        >
                          {cap.texto}
                        </span>
                      )}
                    </TableCell>

                    {/* Marca, modelo, ano y dotacion en dos lineas. Son datos de
                        referencia, no de decision: ocupaban dos columnas propias
                        y empujaban fuera de la vista lo que si se decide. */}
                    <TableCell>
                      <p className="text-xs text-muted-foreground">
                        {[r.marca, r.modelo, r.anio].filter(Boolean).join(" ") || "-"}
                      </p>
                      <p className="text-[0.6875rem] text-muted-foreground/80">
                        {dotacionTexto(r)}
                      </p>
                    </TableCell>

                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => abrirEdicion(r)}
                          title="Editar recurso"
                          aria-label={`Editar ${r.tipo} ${r.numero_equipo}`}
                          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setAEliminar(r)}
                          title="Eliminar recurso"
                          aria-label={`Eliminar ${r.tipo} ${r.numero_equipo}`}
                          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-destructive/15 hover:text-destructive-strong focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {/* Los controles solo aparecen cuando hay más de una página: con 8
            unidades, una paginación de una sola página es ruido que ocupa
            espacio y no hace nada. */}
        {visibles.length > POR_PAGINA && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
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
                disabled={pagina_actual === 1}
                onClick={() => setPagina(pagina_actual - 1)}
              >
                Anterior
              </Button>
              {Array.from({ length: totalPaginas }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setPagina(n)}
                  aria-current={n === pagina_actual ? "page" : undefined}
                  className={`mono h-8 w-8 cursor-pointer rounded-md text-xs tabular-nums transition-colors ${
                    n === pagina_actual
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
                disabled={pagina_actual === totalPaginas}
                onClick={() => setPagina(pagina_actual + 1)}
              >
                Siguiente
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── AC1: el tipo, antes de cualquier campo ── */}
      <Dialog open={eligiendoTipo} onOpenChange={setEligiendoTipo}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>¿Qué tipo de recurso vas a agregar?</DialogTitle>
          </DialogHeader>
          <p className="text-xs leading-relaxed text-muted-foreground">
            El tipo define qué datos pide el sistema después, así que se elige primero.
          </p>
          <div className="max-h-[22rem] space-y-3 overflow-y-auto pr-1">
            {(["carga", "maquina", "arrastre", "apoyo"] as ResourceFamily[]).map((familia) => {
              const deEsta = tipos.filter((t) => t.familia === familia);
              if (deEsta.length === 0) return null;
              return (
                <div key={familia}>
                  <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                    {familia === "carga" && "Transportan carga"}
                    {familia === "maquina" && "Máquinas, cargan pero no transportan"}
                    {familia === "arrastre" && "Se remolcan"}
                    {familia === "apoyo" && "Apoyo y supervisión"}
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {deEsta.map((t) => (
                      <button
                        key={t.tipo}
                        type="button"
                        onClick={() => abrirNuevo(t.tipo)}
                        className="cursor-pointer rounded-md border border-border/60 bg-background/60 px-2.5 py-2 text-left text-xs font-medium transition-all hover:border-primary hover:bg-primary/5"
                      >
                        {t.tipo}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── AC2 y AC3: el formulario, con los campos de la familia del tipo ── */}
      <Dialog
        open={borrador !== null}
        onOpenChange={(abierto) => {
          if (!abierto && !guardando) {
            setBorrador(null);
            setEditandoId(null);
          }
        }}
      >
        <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {editandoId ? "Editar recurso" : "Nuevo recurso"}
              {borrador && (
                <>
                  <span className="text-xs font-normal text-muted-foreground">
                    {borrador.tipo}
                  </span>
                  {/* El estado como insignia junto al título, igual que en la
                      ficha de vehículo de la referencia: se lee antes que
                      cualquier campo. */}
                  <span
                    className={`rounded px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide ${
                      borrador.disponible
                        ? "bg-success/15 text-success-strong"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {borrador.disponible ? "Disponible" : "En taller"}
                  </span>
                </>
              )}
            </DialogTitle>
          </DialogHeader>

          {borrador && campos && (
            <div className="grid gap-5 md:grid-cols-[15rem_1fr]">
              {/* ── Panel de la foto ──
                  A la izquierda y grande, como en la ficha de vehículo de la
                  referencia: la foto es lo que permite reconocer la unidad en
                  patio, y en una lista solo entra como miniatura. */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => borrador.foto && setFotoAmpliada(borrador.foto)}
                  disabled={!borrador.foto}
                  className={`detect-frame relative block aspect-[4/3] w-full overflow-hidden rounded-lg border border-border bg-muted ${
                    borrador.foto ? "cursor-zoom-in" : "cursor-default"
                  }`}
                >
                  <span className="detect-corners" aria-hidden="true" />
                  {borrador.foto ? (
                    <img
                      src={resourcePhotoUrl(borrador.foto)}
                      alt="Foto del recurso"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    // Se DICE que no hay imagen, no se deja un hueco: un marco
                    // vacío se lee como que la foto no cargó.
                    <span className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
                      <ImageOff className="h-7 w-7 opacity-50" />
                      <span className="text-[0.6875rem]">Sin imagen todavía</span>
                    </span>
                  )}
                  {subiendoFoto && (
                    <span className="absolute inset-0 flex items-center justify-center bg-background/70">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </span>
                  )}
                </button>

                <input
                  ref={inputFoto}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => elegirFoto(e.target.files?.[0])}
                />

                <div className="flex gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="flex-1"
                    disabled={subiendoFoto}
                    onClick={() => inputFoto.current?.click()}
                  >
                    <ImagePlus className="mr-1.5 h-3.5 w-3.5" />
                    {borrador.foto ? "Cambiar" : "Subir imagen"}
                  </Button>
                  {borrador.foto && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={subiendoFoto}
                      onClick={() => setBorrador({ ...borrador, foto: null })}
                      title="Quitar la imagen de este recurso"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>

                <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                  La imagen es opcional. Se reduce automáticamente y se guarda en
                  el servidor.
                </p>

                <div className="flex items-center justify-between rounded-lg bg-background/40 p-3">
                  <span className="text-xs font-medium text-foreground">Disponible</span>
                  <Switch
                    checked={borrador.disponible}
                    onCheckedChange={(v) => setBorrador({ ...borrador, disponible: v })}
                  />
                </div>
              </div>

              {/* ── Campos ── */}
              <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Tipo</label>
                {/* Se puede cambiar al editar, y al hacerlo se limpian los
                    campos de la familia anterior (ver cambiarTipo). */}
                <select
                  value={borrador.tipo}
                  onChange={(e) => cambiarTipo(e.target.value)}
                  className="h-9 w-full cursor-pointer rounded-md border border-input bg-background px-3 text-sm"
                >
                  {tipos.map((t) => (
                    <option key={t.tipo} value={t.tipo}>
                      {t.tipo}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">N° de equipo</label>
                  <Input
                    value={borrador.numero_equipo}
                    onChange={(e) => setBorrador({ ...borrador, numero_equipo: e.target.value })}
                    placeholder="1143"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Patente</label>
                  <Input
                    value={borrador.patente}
                    onChange={(e) => setBorrador({ ...borrador, patente: e.target.value })}
                    placeholder="JXZS-91"
                  />
                </div>
              </div>

              {campos.motorizado && (
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Marca</label>
                    <Input
                      value={borrador.marca}
                      onChange={(e) => setBorrador({ ...borrador, marca: e.target.value })}
                      placeholder="FORD"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Modelo</label>
                    <Input
                      value={borrador.modelo}
                      onChange={(e) => setBorrador({ ...borrador, modelo: e.target.value })}
                      placeholder="CARGO 1723"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Año</label>
                    <Input
                      type="number"
                      value={borrador.anio ?? ""}
                      onChange={(e) =>
                        setBorrador({
                          ...borrador,
                          anio: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      placeholder="2018"
                    />
                  </div>
                </div>
              )}

              {campos.capacidadCarga && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Capacidad de carga (m³)
                  </label>
                  <Input
                    type="number"
                    step="0.1"
                    value={borrador.capacidad_m3 ?? ""}
                    onChange={(e) =>
                      setBorrador({
                        ...borrador,
                        // `|| null` y no un ternario sobre el texto: escribir 0
                        // manda 0, y el backend exige > 0 porque una capacidad
                        // de cero no es un dato, es la ausencia de uno. Con el
                        // ternario simple eso daba un 422 incomprensible.
                        capacidad_m3: Number(e.target.value) || null,
                      })
                    }
                    placeholder="10"
                  />
                  {/* Se puede dejar vacía: cuatro vehículos de carga de la flota
                      real no la declaran, y exigirla obligaría a inventar un
                      número operacional. Pero hay que decir qué implica. */}
                  {borrador.capacidad_m3 == null && (
                    <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                      Sin capacidad declarada el recurso se guarda igual, pero no suma para
                      las rutas: no se puede asignar volumen a un vehículo que no declara
                      cuánto lleva.
                    </p>
                  )}
                </div>
              )}

              {campos.capacidadBalde && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Capacidad del balde (m³)
                  </label>
                  <Input
                    type="number"
                    step="0.1"
                    value={borrador.capacidad_balde_m3 ?? ""}
                    onChange={(e) =>
                      setBorrador({
                        ...borrador,
                        // `|| null` y no un ternario sobre el texto: escribir 0
                        // manda 0, y el backend exige > 0 porque una capacidad
                        // de cero no es un dato, es la ausencia de uno. Con el
                        // ternario simple eso daba un 422 incomprensible.
                        capacidad_balde_m3: Number(e.target.value) || null,
                      })
                    }
                    placeholder="1"
                  />
                  <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                    Una máquina carga pero no transporta, así que esta capacidad no suma a
                    la de las rutas.
                  </p>
                </div>
              )}

              {campos.dotacion && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Dotación requerida
                  </label>
                  <div className="grid grid-cols-3 gap-3">
                    {([
                      ["conductores_requeridos", "Conductores"],
                      ["peonetas_requeridas", "Peonetas"],
                      ["operadores_requeridos", "Operadores"],
                    ] as const).map(([clave, etiqueta]) => (
                      <div key={clave} className="space-y-1">
                        <span className="text-[0.6875rem] text-muted-foreground">{etiqueta}</span>
                        <Input
                          type="number"
                          min={0}
                          value={borrador[clave] || ""}
                          onChange={(e) =>
                            setBorrador({ ...borrador, [clave]: Number(e.target.value) || 0 })
                          }
                          className="h-8"
                        />
                      </div>
                    ))}
                  </div>
                  <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                    Es lo que este vehículo <strong>requiere</strong> para operar, distinto
                    del personal que el punto tiene.
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Observaciones</label>
                <Input
                  value={borrador.observaciones}
                  onChange={(e) => setBorrador({ ...borrador, observaciones: e.target.value })}
                />
              </div>

              <div className="flex gap-2 pt-1">
                <Button onClick={guardar} disabled={guardando} className="flex-1">
                  {guardando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {editandoId ? "Guardar cambios" : "Agregar recurso"}
                </Button>
                <Button
                  variant="secondary"
                  disabled={guardando}
                  onClick={() => {
                    setBorrador(null);
                    setEditandoId(null);
                  }}
                >
                  <X className="mr-1.5 h-3.5 w-3.5" /> Cancelar
                </Button>
              </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Ver la foto en grande. La miniatura de la tabla mide 11x16 y no
          alcanza para reconocer una unidad en patio, que es justamente para lo
          que sirve tener la foto. */}
      <Dialog open={fotoAmpliada !== null} onOpenChange={(a) => { if (!a) setFotoAmpliada(null); }}>
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
                  Se va a eliminar {aEliminar.tipo}{" "}
                  {aEliminar.numero_equipo || "sin número"}
                  {aEliminar.patente && ` (${aEliminar.patente})`} de {point.name}. No se
                  puede deshacer. Si el vehículo está fuera de servicio de forma temporal,
                  conviene marcarlo como no disponible en vez de borrarlo.
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
