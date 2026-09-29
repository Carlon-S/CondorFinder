// =============================================================================
// CONDORFINDER, FORMULARIO DE UN RECURSO (HDU8)
// Archivo: src/routes/_authed/recursos_.$pointId_.recurso.tsx
//
// Vista propia y no un diálogo. El formulario tiene foto, datos del vehículo y
// dotación: dentro de una modal quedaba o apretado o tan alto que había que
// desplazarlo, y en los dos casos compite con el listado que hay detrás.
//
// DOS guiones bajos en el nombre del archivo, y los dos importan:
//
//   recursos_   saca la ruta de debajo de /recursos, que es una ruta hoja y no
//               un layout.
//   $pointId_   la saca de debajo de /recursos/{id}, el listado.
//
// El segundo faltaba y el síntoma era desconcertante: elegir un tipo o apretar
// editar navegaba, la URL cambiaba, y en pantalla seguía el listado. El
// formulario se había generado como HIJO del listado, y como el listado no
// renderiza un <Outlet>, el hijo no tenía dónde aparecer.
//
// Dos modos, distinguidos por los parámetros de búsqueda:
//   ?tipo=TOLVA  -> alta. El tipo ya viene elegido, que es el AC1 de HDU8: la
//                   modal de tipos lo preguntó antes de traer hasta acá.
//   ?id=<id>     -> edición (AC3).
//
// El campo "observaciones" del Excel NO está en este formulario. Doce de las 21
// unidades lo traían y nueve de esas doce repetían en texto la capacidad que el
// parser ya extrajo a su propio campo ("Capacidad 10 M3"), así que como campo
// editable era ruido: el dato de verdad es la capacidad volumétrica. El valor
// original se conserva en la base para no perder la trazabilidad con la
// planilla.
//
// LAYOUT: migas, título con las acciones a la derecha, y UNA tarjeta centrada
// con todo adentro, empezando por la zona de carga de la foto. Los campos van
// apilados a lo ancho de la tarjeta, no en dos columnas: un formulario de alta
// se recorre de arriba abajo una sola vez, y repartirlo en columnas obliga a
// zigzaguear sin ganar nada cuando la tarjeta ya es angosta.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { ImageOff, ImagePlus } from "lucide-react";
import { Loader2 } from "@/components/icons/Icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { notify } from "@/lib/notify";
import {
  camposDeFamilia,
  createResource,
  getResourcePoint,
  listResourceTypes,
  listResources,
  recursoVacio,
  resourcePhotoUrl,
  updateResource,
  uploadResourcePhoto,
  type ResourceFamily,
  type ResourceInput,
  type ResourcePoint,
  type ResourceType,
} from "@/lib/resources";

interface Busqueda {
  tipo?: string;
  id?: string;
}

export const Route = createFileRoute("/_authed/recursos_/$pointId_/recurso")({
  validateSearch: (search: Record<string, unknown>): Busqueda => ({
    tipo: typeof search.tipo === "string" ? search.tipo : undefined,
    id: typeof search.id === "string" ? search.id : undefined,
  }),
  component: RecursoFormPage,
});

function RecursoFormPage() {
  const { pointId } = Route.useParams();
  const { tipo, id } = Route.useSearch();
  const navigate = useNavigate();

  const [punto, setPunto] = useState<ResourcePoint | null>(null);
  const [tipos, setTipos] = useState<ResourceType[]>([]);
  const [form, setForm] = useState<ResourceInput | null>(null);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [subiendoFoto, setSubiendoFoto] = useState(false);
  const [arrastrando, setArrastrando] = useState(false);
  const [fotoAmpliada, setFotoAmpliada] = useState<string | null>(null);
  // Los demás recursos del punto, solo para avisar de un N° de equipo repetido
  // antes de enviar: el índice único de Mongo devuelve un error que no dice qué
  // campo lo causó.
  const [hermanos, setHermanos] = useState<{ id: string; numero_equipo: string; tipo: string }[]>(
    [],
  );
  const inputFoto = useRef<HTMLInputElement>(null);

  const volverAlListado = () => navigate({ to: "/recursos/$pointId", params: { pointId } });

  useEffect(() => {
    let cancelado = false;
    (async () => {
      setCargando(true);
      try {
        const [p, ts, recursos] = await Promise.all([
          getResourcePoint(pointId),
          listResourceTypes(),
          listResources(pointId),
        ]);
        if (cancelado) return;
        setPunto(p);
        setTipos(ts);
        setHermanos(
          recursos.map((r) => ({ id: r.id, numero_equipo: r.numero_equipo, tipo: r.tipo })),
        );

        if (id) {
          const existente = recursos.find((r) => r.id === id);
          if (!existente) {
            notify.error("Ese recurso ya no existe", "Puede haberlo eliminado alguien más.");
            volverAlListado();
            return;
          }
          // Solo los campos de entrada: id, owner, created_at y familia son del
          // backend y devolverlos no tendría sentido.
          setForm({
            tipo: existente.tipo,
            numero_equipo: existente.numero_equipo,
            patente: existente.patente,
            marca: existente.marca,
            modelo: existente.modelo,
            anio: existente.anio,
            capacidad_m3: existente.capacidad_m3,
            capacidad_balde_m3: existente.capacidad_balde_m3,
            conductores_requeridos: existente.conductores_requeridos,
            peonetas_requeridas: existente.peonetas_requeridas,
            operadores_requeridos: existente.operadores_requeridos,
            observaciones: existente.observaciones,
            foto: existente.foto,
            disponible: existente.disponible,
            point_id: pointId,
          });
        } else if (tipo && ts.some((t) => t.tipo === tipo)) {
          setForm(recursoVacio(tipo, pointId));
        } else {
          // Llegar acá sin tipo ni id significa una URL escrita a mano o un
          // enlace viejo. Se devuelve al listado en vez de mostrar un
          // formulario que no sabe qué está creando.
          notify.error("Falta el tipo de recurso", "Elígelo desde Agregar recurso.");
          volverAlListado();
          return;
        }
      } catch (err) {
        if (!cancelado) {
          notify.error("No se pudo cargar", err instanceof Error ? err.message : "");
          volverAlListado();
        }
      } finally {
        if (!cancelado) setCargando(false);
      }
    })();
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointId, tipo, id]);

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
      (h) => h.id !== id && h.numero_equipo && h.numero_equipo.trim() === form.numero_equipo.trim(),
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
      if (id) {
        await updateResource(id, form);
        notify.success("Recurso actualizado");
      } else {
        await createResource(form);
        notify.success("Recurso agregado", `${form.tipo} en ${punto?.name ?? "el punto"}.`);
      }
      volverAlListado();
    } catch (err) {
      notify.error(
        id ? "No se pudo actualizar el recurso" : "No se pudo guardar el recurso",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <div className="px-6 pt-5">
        {/* Migas. Es el camino de vuelta y a la vez dice dónde está uno: una
            vista a la que se llega desde otras dos (el listado y el botón de
            agregar) necesita decirlo, y un solo enlace "Volver" no lo dice. */}
        <nav className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <Link to="/recursos" className="transition-colors hover:text-foreground">
            Puntos
          </Link>
          <ChevronRight className="h-3 w-3" />
          <Link
            to="/recursos/$pointId"
            params={{ pointId }}
            className="transition-colors hover:text-foreground"
          >
            {punto?.name ?? "Recursos"}
          </Link>
          <ChevronRight className="h-3 w-3" />
          <span className="font-medium text-foreground">
            {id ? "Editar recurso" : "Nuevo recurso"}
          </span>
        </nav>

        {/* Título y acciones en la misma fila, como en la referencia: guardar y
            cancelar están arriba y siempre visibles, sin tener que llegar al
            pie del formulario para encontrarlos. */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-b border-border/25 pb-5">
          <div className="min-w-0">
            <h1 className="font-rubik text-3xl font-semibold tracking-normal text-foreground">
              {id ? "Editar recurso" : "Nuevo recurso"}
            </h1>
            {form && (
              <p className="mt-1 text-xs text-muted-foreground">
                {form.tipo}
                {punto && ` · ${punto.name}`}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" disabled={guardando} onClick={volverAlListado}>
              Cancelar
            </Button>
            <Button onClick={guardar} disabled={guardando || cargando}>
              {guardando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {id ? "Guardar cambios" : "Agregar recurso"}
            </Button>
          </div>
        </div>
      </div>

      <main className="flex-1 px-6 py-6">
        {cargando || !form || !campos ? (
          <div className="mx-auto max-w-2xl space-y-3 rounded-xl border border-border bg-card p-6">
            <Skeleton className="h-24 w-full rounded-lg" />
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-5 rounded-xl border border-border bg-card p-6">
            {/* ── Foto: miniatura más zona de arrastre, como en la referencia ── */}
            <div className="flex items-stretch gap-3">
              <button
                type="button"
                onClick={() => form.foto && setFotoAmpliada(form.foto)}
                disabled={!form.foto}
                title={form.foto ? "Ver la foto en grande" : "Sin imagen todavía"}
                className={`detect-frame detect-frame-sm h-20 w-24 flex-shrink-0 overflow-hidden rounded-lg border border-border bg-muted ${
                  form.foto ? "cursor-zoom-in" : "cursor-default"
                }`}
              >
                <span className="detect-corners" aria-hidden="true" />
                {form.foto ? (
                  <img
                    src={resourcePhotoUrl(form.foto)}
                    alt="Foto del recurso"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center">
                    <ImageOff className="h-5 w-5 text-muted-foreground/50" />
                  </span>
                )}
              </button>

              {/* Arrastrar y soltar además del clic: es el gesto natural cuando
                  la foto viene de una carpeta abierta al lado, que es como
                  llegan las de la flota. */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setArrastrando(true);
                }}
                onDragLeave={() => setArrastrando(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setArrastrando(false);
                  elegirFoto(e.dataTransfer.files?.[0]);
                }}
                onClick={() => inputFoto.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") inputFoto.current?.click();
                }}
                className={`flex flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-3 text-center transition-colors ${
                  arrastrando
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/60 hover:bg-muted/40"
                }`}
              >
                {subiendoFoto ? (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                ) : (
                  <ImagePlus className="h-5 w-5 text-muted-foreground" />
                )}
                <p className="text-xs">
                  <span className="font-semibold text-primary">
                    {form.foto ? "Cambiar imagen" : "Haz clic para subir"}
                  </span>{" "}
                  <span className="text-muted-foreground">o arrastra el archivo</span>
                </p>
                <p className="text-[0.6875rem] text-muted-foreground">
                  {form.foto
                    ? "La imagen actual se reemplaza"
                    : "Opcional. JPG o PNG, se reduce automáticamente"}
                </p>
              </div>

              {form.foto && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={subiendoFoto}
                  onClick={() => setForm({ ...form, foto: null })}
                  className="self-center"
                >
                  Quitar
                </Button>
              )}
            </div>

            <input
              ref={inputFoto}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => elegirFoto(e.target.files?.[0])}
            />

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
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  Una máquina carga pero no transporta, así que esta capacidad no suma a la
                  de las rutas.
                </p>
              </Campo>
            )}

            {campos.dotacion && (
              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  Dotación requerida
                </p>
                <div className="grid gap-4 sm:grid-cols-3">
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
                        onChange={(e) => setForm({ ...form, [clave]: Number(e.target.value) || 0 })}
                      />
                    </Campo>
                  ))}
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  Es lo que este vehículo <strong>requiere</strong> para operar, distinto del
                  personal que el punto tiene.
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
          </div>
        )}
      </main>

      {/* Ver la foto en grande, el mismo gesto que en el listado. */}
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
    </div>
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

/** Campo numérico con la unidad pegada a la izquierda, como en la referencia.
 *  La unidad deja de ser parte de la etiqueta y pasa a estar donde se escribe
 *  el número, que es donde importa saber en qué se está midiendo. */
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
