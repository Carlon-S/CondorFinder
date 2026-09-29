// =============================================================================
// CONDORFINDER — RECURSOS DE UN PUNTO (HDU8)
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

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Truck,
  X,
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
function textoCapacidad(r: Resource): { texto: string; falta: boolean } {
  if (r.familia === "carga") {
    return r.capacidad_m3 != null
      ? { texto: `${r.capacidad_m3} m³`, falta: false }
      : { texto: "sin capacidad declarada", falta: true };
  }
  if (r.familia === "maquina") {
    return r.capacidad_balde_m3 != null
      ? { texto: `balde ${r.capacidad_balde_m3} m³`, falta: false }
      : { texto: "sin balde declarado", falta: true };
  }
  if (r.familia === "arrastre") return { texto: "se remolca", falta: false };
  return { texto: "sin capacidad de carga", falta: false };
}

function dotacionTexto(r: ResourceInput): string {
  const partes = [
    r.conductores_requeridos && `${r.conductores_requeridos} conductor${r.conductores_requeridos > 1 ? "es" : ""}`,
    r.peonetas_requeridas && `${r.peonetas_requeridas} peoneta${r.peonetas_requeridas > 1 ? "s" : ""}`,
    r.operadores_requeridos && `${r.operadores_requeridos} operador${r.operadores_requeridos > 1 ? "es" : ""}`,
  ].filter(Boolean);
  return partes.length > 0 ? partes.join(" + ") : "sin dotación declarada";
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

  // Agrupados por tipo: con 21 unidades en un punto, una lista plana obliga a
  // leer las 21 para saber cuántas tolvas hay.
  const porTipo = useMemo(() => {
    const mapa = new Map<string, Resource[]>();
    for (const r of recursos) {
      mapa.set(r.tipo, [...(mapa.get(r.tipo) ?? []), r]);
    }
    return [...mapa.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    );
  }, [recursos]);

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
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">Recursos de este punto</p>
        <Button size="sm" variant="secondary" onClick={() => setEligiendoTipo(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Agregar recurso
        </Button>
      </div>

      {/* Capacidad y unidades disponibles, tal como las calcula el backend. Es
          la misma cifra que decide si este punto puede participar de una ruta. */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md bg-background/40 p-2.5">
          <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
            <Boxes className="h-3.5 w-3.5 text-primary/70" /> Capacidad
          </span>
          <p className="mono mt-1 text-sm font-semibold tabular-nums text-foreground">
            {point.capacity_m3} m³
          </p>
        </div>
        <div className="rounded-md bg-background/40 p-2.5">
          <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
            <Truck className="h-3.5 w-3.5 text-primary/70" /> Disponibles
          </span>
          <p className="mono mt-1 text-sm font-semibold tabular-nums text-foreground">
            {point.available_count} de {point.resource_count}
          </p>
        </div>
      </div>

      {/* El punto inactivo es el caso que más desconcierta: se pueden activar
          recursos uno por uno y la ruta sigue sin considerarlos, porque el ruteo
          descarta el punto entero antes de mirar sus unidades. */}
      {!point.active && point.resource_count > 0 && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-[0.6875rem] leading-relaxed">
          El punto está inactivo, así que sus recursos no participan de ninguna ruta
          aunque estén disponibles.
        </p>
      )}

      {cargando ? (
        <div className="space-y-1.5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-md" />
          ))}
        </div>
      ) : recursos.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/50 px-3 py-4 text-center text-xs leading-relaxed text-muted-foreground">
          Este punto todavía no tiene recursos. Sin al menos uno con capacidad de
          transporte no puede participar de una ruta.
        </p>
      ) : (
        <div className="space-y-3">
          {porTipo.map(([tipo, unidades]) => (
            <div key={tipo}>
              <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                {tipo} ({unidades.filter((u) => u.disponible).length} de {unidades.length})
              </p>
              <ul className="space-y-1">
                {unidades.map((r) => {
                  const cap = textoCapacidad(r);
                  return (
                    <li
                      key={r.id}
                      className={`group flex items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-muted/40 ${
                        r.disponible ? "" : "opacity-60"
                      }`}
                    >
                      {/* Foto cuando existe; marcador cuando no. 8 de los 21
                          vehículos de la flota real no tienen foto, así que este
                          no es un caso raro. */}
                      <div className="detect-frame detect-frame-sm h-9 w-12 flex-shrink-0 overflow-hidden rounded bg-muted">
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
                            <Truck className="h-3.5 w-3.5 text-muted-foreground/50" />
                          </span>
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-foreground">
                          {r.numero_equipo || "Sin N°"}
                          {r.patente && (
                            <span className="mono ml-1.5 font-normal text-muted-foreground">
                              {r.patente}
                            </span>
                          )}
                        </p>
                        <p className="truncate text-[0.6875rem] text-muted-foreground">
                          <span className={cap.falta ? "text-warning" : ""}>{cap.texto}</span>
                          {r.marca && ` · ${r.marca}`}
                          {r.anio && ` ${r.anio}`}
                        </p>
                      </div>

                      {/* AC4. El interruptor va en la fila y no dentro de un
                          formulario: es la acción más frecuente de esta vista,
                          un camión entra y sale de taller. */}
                      <div className="flex flex-shrink-0 items-center gap-1">
                        {alternando === r.id && (
                          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                        )}
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
                        <button
                          type="button"
                          onClick={() => abrirEdicion(r)}
                          title="Editar recurso"
                          aria-label={`Editar ${r.tipo} ${r.numero_equipo}`}
                          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setAEliminar(r)}
                          title="Eliminar recurso"
                          aria-label={`Eliminar ${r.tipo} ${r.numero_equipo}`}
                          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-destructive/15 hover:text-destructive-strong focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

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
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editandoId ? "Editar recurso" : "Nuevo recurso"}
              {borrador && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {borrador.tipo}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          {borrador && campos && (
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

              <div className="flex items-center justify-between rounded-lg bg-background/40 p-3">
                <span className="text-xs font-medium text-foreground">Disponible</span>
                <Switch
                  checked={borrador.disponible}
                  onCheckedChange={(v) => setBorrador({ ...borrador, disponible: v })}
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
