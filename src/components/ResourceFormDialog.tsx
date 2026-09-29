// =============================================================================
// CONDORFINDER, FORMULARIO DE UN RECURSO (HDU8)
// Archivo: src/components/ResourceFormDialog.tsx
//
// Alta (AC1/AC2) y edición (AC3) de un recurso, en una modal sobre el listado.
//
// Estuvo un rato como vista propia, con su ruta. Se volvió acá porque el
// formulario es corto (entre seis y nueve campos según el tipo) y una vista
// entera para eso obliga a perder de vista el listado, que es el contexto:
// se edita un vehículo MIENTRAS se mira la flota. La modal conserva ese
// contexto detrás.
//
// El campo "observaciones" del Excel NO está acá. Doce de las 21 unidades lo
// traían y nueve de esas doce repetían en texto la capacidad que el parser ya
// extrajo a su propio campo ("Capacidad 10 M3"), así que como campo editable
// era ruido: el dato de verdad es la capacidad volumétrica. El valor original
// se conserva en la base para no perder la trazabilidad con la planilla.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { ImageOff, ImagePlus } from "lucide-react";
import { Loader2, Trash2 } from "@/components/icons/Icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { notify } from "@/lib/notify";
import {
  camposDeFamilia,
  createResource,
  recursoVacio,
  resourcePhotoUrl,
  updateResource,
  uploadResourcePhoto,
  type Resource,
  type ResourceFamily,
  type ResourceInput,
  type ResourceType,
} from "@/lib/resources";

export function ResourceFormDialog({
  abierto,
  onOpenChange,
  pointId,
  nombrePunto,
  /** Tipo elegido para un alta. Ignorado cuando viene `recurso`. */
  tipoNuevo,
  /** Recurso a editar, o null para un alta. */
  recurso,
  tipos,
  /** Los demás recursos del punto, solo para avisar de un N° de equipo
   *  repetido antes de enviar: el índice único de Mongo devuelve un error que
   *  no dice qué campo lo causó. */
  hermanos,
  onGuardado,
}: {
  abierto: boolean;
  onOpenChange: (abierto: boolean) => void;
  pointId: string;
  nombrePunto: string;
  tipoNuevo: string | null;
  recurso: Resource | null;
  tipos: ResourceType[];
  hermanos: Resource[];
  onGuardado: () => void;
}) {
  const [form, setForm] = useState<ResourceInput | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [subiendoFoto, setSubiendoFoto] = useState(false);
  const [confirmandoQuitarFoto, setConfirmandoQuitarFoto] = useState(false);
  const inputFoto = useRef<HTMLInputElement>(null);

  // El borrador se arma al abrir, no al montar: la modal vive siempre en el
  // árbol y se abre varias veces con recursos distintos.
  useEffect(() => {
    if (!abierto) return;
    if (recurso) {
      // Solo los campos de entrada: id, owner, created_at y familia son del
      // backend y devolverlos no tendría sentido.
      setForm({
        tipo: recurso.tipo,
        numero_equipo: recurso.numero_equipo,
        patente: recurso.patente,
        marca: recurso.marca,
        modelo: recurso.modelo,
        anio: recurso.anio,
        capacidad_m3: recurso.capacidad_m3,
        capacidad_balde_m3: recurso.capacidad_balde_m3,
        conductores_requeridos: recurso.conductores_requeridos,
        peonetas_requeridas: recurso.peonetas_requeridas,
        operadores_requeridos: recurso.operadores_requeridos,
        observaciones: recurso.observaciones,
        foto: recurso.foto,
        disponible: recurso.disponible,
        point_id: pointId,
      });
    } else if (tipoNuevo) {
      setForm(recursoVacio(tipoNuevo, pointId));
    }
  }, [abierto, recurso, tipoNuevo, pointId]);

  const familiaDe = (t: string): ResourceFamily =>
    tipos.find((x) => x.tipo === t)?.familia ?? "apoyo";
  const campos = form ? camposDeFamilia(familiaDe(form.tipo)) : null;

  const elegirFoto = async (archivo: File | undefined) => {
    if (!archivo || !form) return;
    if (!archivo.type.startsWith("image/")) {
      notify.error("Ese archivo no es una imagen");
      return;
    }
    setSubiendoFoto(true);
    try {
      const nombre = await uploadResourcePhoto(archivo);
      setForm({ ...form, foto: nombre });
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
    if (!form) return;

    const repetido = hermanos.find(
      (h) =>
        h.id !== recurso?.id &&
        h.numero_equipo &&
        h.numero_equipo.trim() === form.numero_equipo.trim(),
    );
    if (form.numero_equipo.trim() && repetido) {
      notify.error(
        "N° de equipo repetido",
        `Este punto ya tiene el equipo ${repetido.numero_equipo} (${repetido.tipo}). Es el identificador con el que la municipalidad nombra sus vehículos, así que no puede repetirse.`,
      );
      return;
    }

    setGuardando(true);
    try {
      if (recurso) {
        await updateResource(recurso.id, form);
        notify.success("Recurso actualizado");
      } else {
        await createResource(form);
        notify.success("Recurso agregado", `${form.tipo} en ${nombrePunto}.`);
      }
      onOpenChange(false);
      onGuardado();
    } catch (err) {
      notify.error(
        recurso ? "No se pudo actualizar el recurso" : "No se pudo guardar el recurso",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
    } finally {
      setGuardando(false);
    }
  };

  return (
    <>
      <Dialog
        open={abierto}
        onOpenChange={(a) => {
          if (!a && guardando) return;
          onOpenChange(a);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{recurso ? "Editar recurso" : "Nuevo recurso"}</DialogTitle>
          </DialogHeader>

          {form && campos && (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                {form.tipo} · {nombrePunto}
              </p>

              {/* ── Imagen ──
                  Grande y sola: es lo que permite reconocer la unidad en patio,
                  y la zona de arrastre con sus dos líneas de instrucciones
                  ocupaba más alto que la propia foto. Las acciones van DENTRO
                  de la imagen (la papelera) y justo debajo (adjuntar), no en un
                  bloque aparte. */}
              <div className="detect-frame relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-border bg-muted">
                <span className="detect-corners" aria-hidden="true" />
                {form.foto ? (
                  <img
                    src={resourcePhotoUrl(form.foto)}
                    alt="Foto del recurso"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  // Se DICE que no hay imagen. Un marco vacío se lee como que la
                  // foto no cargó, no como que no existe.
                  <span className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                    <ImageOff className="h-8 w-8 opacity-50" />
                    <span className="text-xs">Sin imagen todavía</span>
                  </span>
                )}

                {form.foto && (
                  <button
                    type="button"
                    onClick={() => setConfirmandoQuitarFoto(true)}
                    disabled={subiendoFoto}
                    title="Quitar la imagen"
                    aria-label="Quitar la imagen"
                    className="absolute right-2 top-2 flex h-8 w-8 cursor-pointer items-center justify-center rounded-md bg-card/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-destructive/15 hover:text-destructive-strong"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}

                {subiendoFoto && (
                  <span className="absolute inset-0 flex items-center justify-center bg-background/70">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </span>
                )}
              </div>

              <input
                ref={inputFoto}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => elegirFoto(e.target.files?.[0])}
              />

              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={subiendoFoto}
                onClick={() => inputFoto.current?.click()}
              >
                <ImagePlus className="mr-1.5 h-4 w-4" />
                {form.foto ? "Cambiar imagen" : "Adjuntar imagen"}
              </Button>

              <Campo etiqueta="N° de equipo">
                <Input
                  value={form.numero_equipo}
                  onChange={(e) => setForm({ ...form, numero_equipo: e.target.value })}
                  placeholder="1143"
                />
              </Campo>

              <Campo etiqueta="Patente">
                <Input
                  value={form.patente}
                  onChange={(e) => setForm({ ...form, patente: e.target.value })}
                  placeholder="JXZS-91"
                />
              </Campo>

              {campos.motorizado && (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Campo etiqueta="Marca">
                      <Input
                        value={form.marca}
                        onChange={(e) => setForm({ ...form, marca: e.target.value })}
                        placeholder="FORD"
                      />
                    </Campo>
                    <Campo etiqueta="Modelo">
                      <Input
                        value={form.modelo}
                        onChange={(e) => setForm({ ...form, modelo: e.target.value })}
                        placeholder="CARGO 1723"
                      />
                    </Campo>
                  </div>
                  <Campo etiqueta="Año">
                    <Input
                      type="number"
                      value={form.anio ?? ""}
                      onChange={(e) =>
                        setForm({ ...form, anio: e.target.value ? Number(e.target.value) : null })
                      }
                      placeholder="2018"
                    />
                  </Campo>
                </>
              )}

              {campos.capacidadCarga && (
                <Campo etiqueta="Capacidad de carga">
                  <ConUnidad unidad="m³">
                    <Input
                      type="number"
                      step="0.1"
                      value={form.capacidad_m3 ?? ""}
                      // `|| null` y no un ternario sobre el texto: escribir 0
                      // manda 0, y el backend exige > 0 porque una capacidad de
                      // cero no es un dato, es la ausencia de uno.
                      onChange={(e) =>
                        setForm({ ...form, capacidad_m3: Number(e.target.value) || null })
                      }
                      placeholder="10"
                      className="border-0 shadow-none focus-visible:ring-0"
                    />
                  </ConUnidad>
                  {form.capacidad_m3 == null && (
                    <p className="mt-1.5 text-xs leading-relaxed text-warning-strong">
                      Sin capacidad declarada el recurso se guardará igual, pero no sumará
                      para las rutas.
                    </p>
                  )}
                </Campo>
              )}

              {campos.capacidadBalde && (
                <Campo etiqueta="Capacidad del balde">
                  <ConUnidad unidad="m³">
                    <Input
                      type="number"
                      step="0.1"
                      value={form.capacidad_balde_m3 ?? ""}
                      onChange={(e) =>
                        setForm({ ...form, capacidad_balde_m3: Number(e.target.value) || null })
                      }
                      placeholder="1"
                      className="border-0 shadow-none focus-visible:ring-0"
                    />
                  </ConUnidad>
                </Campo>
              )}

              {campos.dotacion && (
                <div>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    Dotación requerida
                  </p>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {(
                      [
                        ["conductores_requeridos", "Conductores"],
                        ["peonetas_requeridas", "Peonetas"],
                        ["operadores_requeridos", "Operadores"],
                      ] as const
                    ).map(([clave, etiqueta]) => (
                      <Campo key={clave} etiqueta={etiqueta}>
                        <Input
                          type="number"
                          min={0}
                          value={form[clave] || ""}
                          onChange={(e) =>
                            setForm({ ...form, [clave]: Number(e.target.value) || 0 })
                          }
                        />
                      </Campo>
                    ))}
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    Es lo que este vehículo <strong>requiere</strong> para operar, distinto
                    del personal que el punto tiene.
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between rounded-lg bg-background/40 p-3">
                <div>
                  <p className="text-xs font-medium text-foreground">Disponible</p>
                  <p className="text-[0.6875rem] text-muted-foreground">
                    Un recurso no disponible queda fuera al armar una ruta.
                  </p>
                </div>
                <Switch
                  checked={form.disponible}
                  onCheckedChange={(v) => setForm({ ...form, disponible: v })}
                />
              </div>

              <div className="flex gap-2 border-t border-border/40 pt-4">
                <Button onClick={guardar} disabled={guardando} className="flex-1">
                  {guardando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {recurso ? "Guardar cambios" : "Agregar recurso"}
                </Button>
                <Button variant="secondary" disabled={guardando} onClick={() => onOpenChange(false)}>
                  Cancelar
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Quitar la imagen se confirma: en una unidad que ya la tenía es un dato
          que no se recupera solo, hay que volver a conseguir la foto. */}
      <AlertDialog open={confirmandoQuitarFoto} onOpenChange={setConfirmandoQuitarFoto}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Quitar la imagen</AlertDialogTitle>
            <AlertDialogDescription>
              El recurso queda sin imagen. El cambio se aplica al guardar, así que si
              cancelas el formulario la imagen sigue como estaba.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (form) setForm({ ...form, foto: null });
                setConfirmandoQuitarFoto(false);
              }}
            >
              Quitar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function Campo({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{etiqueta}</label>
      {children}
    </div>
  );
}

/** Campo numérico con la unidad pegada a la izquierda. La unidad deja de ser
 *  parte de la etiqueta y pasa a estar donde se escribe el número, que es donde
 *  importa saber en qué se está midiendo. */
function ConUnidad({ unidad, children }: { unidad: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring/30">
      <span className="mono flex h-9 items-center border-r border-input px-3 text-xs text-muted-foreground">
        {unidad}
      </span>
      <div className="flex-1">{children}</div>
    </div>
  );
}
