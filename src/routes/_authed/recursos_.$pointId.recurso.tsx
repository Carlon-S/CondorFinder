// =============================================================================
// CONDORFINDER, FORMULARIO DE UN RECURSO (HDU8)
// Archivo: src/routes/_authed/recursos_.$pointId.recurso.tsx
//
// Vista propia y no un diálogo. El formulario tiene foto grande, datos del
// vehículo y dotación: dentro de una modal quedaba o apretado o tan alto que
// había que desplazarlo, y en los dos casos compite con el listado que hay
// detrás. Con vista propia entra completo, se puede volver, y la URL identifica
// lo que se está editando.
//
// El guion bajo de "recursos_" saca esta ruta de debajo de /recursos: esa es
// una ruta hoja, no un layout, así que anidar bajo ella exigiría un <Outlet>
// que no tiene. Ver la convención de TanStack Router para rutas no anidadas.
//
// Dos modos, distinguidos por los parámetros de búsqueda:
//   ?tipo=TOLVA  -> alta. El tipo ya viene elegido, que es el AC1 de HDU8: la
//                   modal de tipos lo preguntó antes de traer hasta acá.
//   ?id=<id>     -> edición (AC3).
//
// El campo "observaciones" del Excel NO está en este formulario. Doce de las 21
// unidades lo traían y nueve de esas doce repetían en texto la capacidad que el
// parser ya extrajo a su propio campo ("Capacidad 10 M3"), así que como campo
// editable era ruido: el dato de verdad es la capacidad volumétrica, que sí
// está. El valor original se conserva en la base para no perder la trazabilidad
// con la planilla.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ImageOff, ImagePlus } from "lucide-react";
import { ArrowRightCircle, Loader2, Truck, X } from "@/components/icons/Icons";
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

export const Route = createFileRoute("/_authed/recursos_/$pointId/recurso")({
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
  const [fotoAmpliada, setFotoAmpliada] = useState<string | null>(null);
  // Los demás recursos del punto, solo para avisar de un N° de equipo repetido
  // antes de enviar: el índice único de Mongo devuelve un error que no dice qué
  // campo lo causó.
  const [hermanos, setHermanos] = useState<{ id: string; numero_equipo: string; tipo: string }[]>([]);
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
        setHermanos(recursos.map((r) => ({ id: r.id, numero_equipo: r.numero_equipo, tipo: r.tipo })));

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
        h.id !== id &&
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
      <div className="border-b border-border/25 px-6 py-5">
        {/* Camino de vuelta explícito. La vista se abre desde el listado de un
            punto y tiene que poder devolverse ahí sin usar el botón del
            navegador. */}
        <Link
          to="/recursos/$pointId"
          params={{ pointId }}
          className="mb-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowRightCircle className="h-3.5 w-3.5 rotate-180" />
          Volver a los recursos{punto ? ` de ${punto.name}` : ""}
        </Link>
        <p className="eyebrow">{id ? "Editar recurso" : "Nuevo recurso"}</p>
        <h1 className="font-rubik text-3xl font-semibold tracking-normal text-foreground md:text-4xl">
          {form?.tipo ?? "Recurso"}
        </h1>
      </div>

      <main className="flex-1 p-6">
        {cargando || !form || !campos ? (
          <div className="mx-auto grid max-w-4xl gap-6 md:grid-cols-[18rem_1fr]">
            <Skeleton className="aspect-[4/3] w-full rounded-xl" />
            <div className="space-y-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-10 w-full rounded-md" />
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto grid max-w-4xl gap-6 md:grid-cols-[18rem_1fr]">
            {/* ── Foto ── */}
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => form.foto && setFotoAmpliada(form.foto)}
                disabled={!form.foto}
                className={`detect-frame relative block aspect-[4/3] w-full overflow-hidden rounded-xl border border-border bg-card ${
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
                  // Se DICE que no hay imagen. Un marco vacío se lee como que la
                  // foto no cargó, no como que no existe.
                  <span className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                    <ImageOff className="h-8 w-8 opacity-50" />
                    <span className="text-xs">Sin imagen todavía</span>
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
                  {form.foto ? "Cambiar imagen" : "Subir imagen"}
                </Button>
                {form.foto && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={subiendoFoto}
                    onClick={() => setForm({ ...form, foto: null })}
                    title="Quitar la imagen"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>

              <p className="text-xs leading-relaxed text-muted-foreground">
                La imagen es opcional. Se reduce automáticamente antes de guardarla.
              </p>

              <div className="flex items-center justify-between rounded-lg border border-border bg-card p-3">
                <span className="text-xs font-medium text-foreground">Disponible</span>
                <Switch
                  checked={form.disponible}
                  onCheckedChange={(v) => setForm({ ...form, disponible: v })}
                />
              </div>
            </div>

            {/* ── Campos ── */}
            <div className="space-y-5">
              <Bloque titulo="Identificación">
                <div className="grid gap-3 sm:grid-cols-2">
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
                </div>
              </Bloque>

              {campos.motorizado && (
                <Bloque titulo="Vehículo">
                  <div className="grid gap-3 sm:grid-cols-3">
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
                  </div>
                </Bloque>
              )}

              {(campos.capacidadCarga || campos.capacidadBalde) && (
                <Bloque titulo="Capacidad volumétrica">
                  {campos.capacidadCarga && (
                    <Campo etiqueta="Capacidad de carga (m³)">
                      <Input
                        type="number"
                        step="0.1"
                        value={form.capacidad_m3 ?? ""}
                        // `|| null` y no un ternario sobre el texto: escribir 0
                        // manda 0, y el backend exige > 0 porque una capacidad
                        // de cero no es un dato, es la ausencia de uno.
                        onChange={(e) =>
                          setForm({ ...form, capacidad_m3: Number(e.target.value) || null })
                        }
                        placeholder="10"
                      />
                      {form.capacidad_m3 == null && (
                        <p className="mt-1 text-xs leading-relaxed text-warning-strong">
                          Sin capacidad declarada el recurso se guarda igual, pero no suma
                          para las rutas: no se puede asignar volumen a un vehículo que no
                          declara cuánto lleva.
                        </p>
                      )}
                    </Campo>
                  )}
                  {campos.capacidadBalde && (
                    <Campo etiqueta="Capacidad del balde (m³)">
                      <Input
                        type="number"
                        step="0.1"
                        value={form.capacidad_balde_m3 ?? ""}
                        onChange={(e) =>
                          setForm({ ...form, capacidad_balde_m3: Number(e.target.value) || null })
                        }
                        placeholder="1"
                      />
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Una máquina carga pero no transporta, así que esta capacidad no
                        suma a la de las rutas.
                      </p>
                    </Campo>
                  )}
                </Bloque>
              )}

              {campos.dotacion && (
                <Bloque titulo="Dotación requerida">
                  <div className="grid gap-3 sm:grid-cols-3">
                    {([
                      ["conductores_requeridos", "Conductores"],
                      ["peonetas_requeridas", "Peonetas"],
                      ["operadores_requeridos", "Operadores"],
                    ] as const).map(([clave, etiqueta]) => (
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
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Es lo que este vehículo <strong>requiere</strong> para operar, distinto
                    del personal que el punto tiene.
                  </p>
                </Bloque>
              )}

              <div className="flex gap-2 border-t border-border/40 pt-4">
                <Button onClick={guardar} disabled={guardando} className="flex-1">
                  {guardando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {id ? "Guardar cambios" : "Agregar recurso"}
                </Button>
                <Button variant="secondary" disabled={guardando} onClick={volverAlListado}>
                  Cancelar
                </Button>
              </div>
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

/** Grupo de campos con su título. Es lo que da la simetría del formulario de
 *  referencia: bloques del mismo ancho, separados, en vez de una columna de
 *  campos sueltos de alturas distintas. */
function Bloque({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2.5 border-l-2 border-primary/50 pl-3">
        <Truck className="h-3.5 w-3.5 text-foreground/70" />
        <h2 className="text-sm font-semibold tracking-tight text-foreground">{titulo}</h2>
      </div>
      {children}
    </section>
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
