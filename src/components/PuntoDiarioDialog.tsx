// =============================================================================
// CONDORFINDER, PUNTOS DIARIOS DE RETIRO (HDU15)
// Archivo: src/components/PuntoDiarioDialog.tsx
//
// Tres pantallas encadenadas, que son los tres primeros criterios de la
// historia:
//
//   1. La selección entre "escombros" y "extras" (AC1).
//   2. El formulario de escombros (AC2): tipo de residuo y cantidad.
//   3. El formulario de extras (AC3): solicitud y solicitante.
//
// Van en un solo diálogo que cambia de paso y no en tres componentes, porque
// la mitad de los campos son los mismos (dirección, barrio, teléfono,
// coordenada) y partirlos significaría mantener dos copias de esa mitad.
//
// **Lo que se pide es lo DECLARADO, no lo retirado.** La planilla municipal
// tiene las dos columnas y en sus hojas coinciden porque las llenan al final
// del día, pero son dos hechos distintos: lo que el vecino dijo que hay y lo
// que la cuadrilla efectivamente sacó. Capturar el segundo es otra historia;
// mezclarlos acá haría imposible después comparar uno con otro.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  ChevronDown,
  Construction,
  Loader2,
  MapPin,
  Plus,
  Search,
  Trash2,
} from "@/components/icons/Icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ConfirmarBorrado } from "@/components/ConfirmarBorrado";
import { Obligatorio } from "@/components/Obligatorio";
import { notify } from "@/lib/notify";
import {
  detalleDeSugerencia,
  forwardGeocode,
  sugerirDirecciones,
  type SugerenciaDireccion,
} from "@/lib/geocoding";
import {
  TIPOS_ESCOMBRO,
  crearPuntoDiario,
  crearSolicitud,
  eliminarSolicitud,
  editarPuntoDiario,
  hoy,
  listarSolicitudes,
  type ClasePunto,
  type PuntoDiario,
  type Solicitud,
} from "@/lib/puntosDiarios";

const ANTIRREBOTE_MS = 350;
const SIN_VALOR = "__sin__";

export function PuntoDiarioDialog({
  open,
  onOpenChange,
  punto,
  onGuardado,
}: {
  open: boolean;
  onOpenChange: (abierto: boolean) => void;
  /** `null` para crear (arranca en la selección de clase), el punto para editar
   *  (entra directo a su formulario: la clase ya está decidida). */
  punto: PuntoDiario | null;
  onGuardado: () => void;
}) {
  const [clase, setClase] = useState<ClasePunto | null>(null);
  const [direccion, setDireccion] = useState("");
  const [barrio, setBarrio] = useState("");
  const [telefono, setTelefono] = useState("");
  const [volumen, setVolumen] = useState("");
  const [tipoResiduo, setTipoResiduo] = useState<string>(SIN_VALOR);
  const [solicitud, setSolicitud] = useState<string>(SIN_VALOR);
  const [solicitante, setSolicitante] = useState("");
  const [coord, setCoord] = useState<{ lat: number; lng: number } | null>(null);

  const [solicitudes, setSolicitudes] = useState<Solicitud[]>([]);
  const [nuevaSolicitud, setNuevaSolicitud] = useState("");
  const [filtroSolicitud, setFiltroSolicitud] = useState("");
  const [solicitudAbierta, setSolicitudAbierta] = useState(false);
  /** Solicitud en espera de confirmación de borrado, o null. */
  const [solicitudABorrar, setSolicitudABorrar] = useState<Solicitud | null>(null);
  const [agregandoSolicitud, setAgregandoSolicitud] = useState(false);
  const [sugerencias, setSugerencias] = useState<SugerenciaDireccion[]>([]);
  const [guardando, setGuardando] = useState(false);

  const escribioRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    escribioRef.current = false;
    setSugerencias([]);
    setNuevaSolicitud("");
    setClase(punto?.clase ?? null);
    setDireccion(punto?.address ?? "");
    setBarrio(punto?.barrio ?? "");
    setTelefono(punto?.telefono ?? "");
    setVolumen(punto?.volumenM3 != null ? String(punto.volumenM3) : "");
    setTipoResiduo(punto?.tipoResiduo ?? SIN_VALOR);
    setSolicitud(punto?.solicitud ?? SIN_VALOR);
    setSolicitante(punto?.solicitante ?? "");
    setCoord(punto?.lat != null && punto?.lng != null ? { lat: punto.lat, lng: punto.lng } : null);
  }, [open, punto]);

  // Las solicitudes se piden una vez al abrir y solo cuando hacen falta: con
  // "escombros" ese desplegable no existe.
  useEffect(() => {
    if (!open || clase !== "extras" || solicitudes.length > 0) return;
    listarSolicitudes()
      .then(setSolicitudes)
      .catch(() => {});
  }, [open, clase, solicitudes.length]);

  useEffect(() => {
    if (!escribioRef.current) return;
    const t = setTimeout(async () => {
      setSugerencias(await sugerirDirecciones(direccion));
    }, ANTIRREBOTE_MS);
    return () => clearTimeout(t);
  }, [direccion]);

  const elegirSugerencia = async (s: SugerenciaDireccion) => {
    setSugerencias([]);
    escribioRef.current = false;
    const d = await detalleDeSugerencia(s.placeId);
    if (!d) return;
    setDireccion(d.address);
    setCoord({ lat: d.lat, lng: d.lng });
  };

  const agregarSolicitud = async () => {
    const n = nuevaSolicitud.trim();
    if (!n) return;
    setAgregandoSolicitud(true);
    try {
      const creada = await crearSolicitud(n);
      setSolicitudes((prev) => [...prev, creada].sort((a, b) => a.nombre.localeCompare(b.nombre)));
      setSolicitud(creada.nombre);
      setNuevaSolicitud("");
    } catch (e) {
      notify.error("No se pudo agregar", (e as Error).message);
    } finally {
      setAgregandoSolicitud(false);
    }
  };

  const abrirSolicitudes = (abierto: boolean) => {
    if (abierto) setFiltroSolicitud("");
    setSolicitudAbierta(abierto);
  };

  const solicitudesFiltradas = useMemo(() => {
    const q = filtroSolicitud.trim().toLowerCase();
    if (!q) return solicitudes;
    return solicitudes.filter((s) => s.nombre.toLowerCase().includes(q));
  }, [solicitudes, filtroSolicitud]);

  const borrarSolicitud = async (s: Solicitud) => {
    try {
      await eliminarSolicitud(s.id);
      setSolicitudes((prev) => prev.filter((x) => x.id !== s.id));
      // Si era la elegida, el campo queda sin valor en vez de apuntando a algo
      // que ya no existe.
      if (solicitud === s.nombre) setSolicitud(SIN_VALOR);
    } catch (e) {
      notify.error("No se pudo eliminar", (e as Error).message);
    }
  };

  const guardar = async () => {
    if (!clase) return;
    if (!direccion.trim()) {
      notify.warning("Falta la dirección", "Sin dirección no hay a dónde ir a retirar.");
      return;
    }

    setGuardando(true);
    try {
      let destino = coord;
      if (!destino) {
        const g = await forwardGeocode(`${direccion}, Maipú, Chile`);
        // `preciso === false` es Google devolviendo el centroide de la comuna
        // porque no encontró la dirección. Aceptarlo ubicaría el punto en el
        // medio de Maipú, que es peor que dejarlo sin ubicar: parecería
        // correcto. `undefined` es Nominatim, que no manda la señal.
        if (g && g.preciso !== false) destino = { lat: g.lat, lng: g.lng };
      }

      const datos = {
        clase,
        fecha: punto?.fecha ?? hoy(),
        address: direccion.trim(),
        barrio: barrio.trim() || null,
        lat: destino?.lat ?? null,
        lng: destino?.lng ?? null,
        telefono: telefono.trim() || null,
        volumenM3: volumen.trim() ? Number(volumen) : null,
        tipoResiduo: clase === "escombros" && tipoResiduo !== SIN_VALOR ? tipoResiduo : null,
        solicitud: clase === "extras" && solicitud !== SIN_VALOR ? solicitud : null,
        solicitante: clase === "extras" ? solicitante.trim() || null : null,
      };

      if (punto) await editarPuntoDiario(punto.id, datos);
      else await crearPuntoDiario(datos);

      onGuardado();
      onOpenChange(false);

      // Sin coordenada el punto existe pero NO se dibuja en el mapa. Decirlo
      // acá y no dejarlo en silencio: un "Punto creado" seguido de un mapa sin
      // marcador se lee como que el guardado falló, cuando lo que falló fue
      // encontrar la dirección.
      if (datos.lat == null) {
        notify.warning(
          "Punto creado, pero sin ubicar",
          "No se encontró esa dirección en el mapa, así que el punto no aparece como marcador. Edítalo y elige una sugerencia del buscador.",
        );
      } else {
        notify.success(punto ? "Punto actualizado" : "Punto creado", datos.address);
      }
    } catch (e) {
      notify.error("No se pudo guardar", (e as Error).message);
    } finally {
      setGuardando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {clase === null ? (
          // ── AC1: la selección entre las dos clases ──
          <>
            <DialogHeader>
              <DialogTitle>Crear punto diario</DialogTitle>
              <DialogDescription>Elige el tipo de retiro.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <OpcionClase
                titulo="Escombros"
                detalle="Fono escombros: escombros, ramas o voluminosos que el vecino pide retirar."
                onClick={() => setClase("escombros")}
              />
              <OpcionClase
                titulo="Extras"
                detalle="Retiros a requerimiento: alcaldía, emergencias, operativos y organizaciones."
                onClick={() => setClase("extras")}
              />
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {/* Volver a la selección solo al CREAR: editando, la clase ya
                    está decidida y cambiarla convertiría el registro en otro. */}
                {!punto && (
                  <button
                    type="button"
                    onClick={() => setClase(null)}
                    className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label="Volver a elegir el tipo"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                )}
                {clase === "escombros" ? "Retiro de escombros" : "Retiro extra"}
              </DialogTitle>
              <DialogDescription>
                Los campos con <span className="text-destructive-strong">*</span> son obligatorios.
                {clase === "escombros" ? " La cantidad es la que declara quien llama." : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4">
              <div className="relative grid gap-1.5">
                <Label htmlFor="pd-dir">
                  Dirección <Obligatorio />
                </Label>
                <Input
                  id="pd-dir"
                  value={direccion}
                  onChange={(e) => {
                    escribioRef.current = true;
                    setDireccion(e.target.value);
                    setCoord(null);
                  }}
                  placeholder="Luis Hernández Parker 706"
                  autoComplete="off"
                />
                {sugerencias.length > 0 && (
                  <ul className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-popover shadow-lg">
                    {sugerencias.map((s) => (
                      <li key={s.placeId}>
                        <button
                          type="button"
                          className="w-full cursor-pointer px-3 py-2 text-left text-xs hover:bg-accent"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            void elegirSugerencia(s);
                          }}
                        >
                          {s.texto}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {coord && (
                  <p className="flex items-center gap-1 text-[0.6875rem] text-success-strong">
                    <MapPin className="h-3 w-3" />
                    Ubicado en {coord.lat.toFixed(5)}, {coord.lng.toFixed(5)}
                  </p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="pd-barrio">Barrio</Label>
                  <Input
                    id="pd-barrio"
                    value={barrio}
                    onChange={(e) => setBarrio(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="pd-tel">Teléfono</Label>
                  <Input
                    id="pd-tel"
                    value={telefono}
                    onChange={(e) => setTelefono(e.target.value)}
                    placeholder="966249881"
                  />
                </div>
              </div>

              {clase === "escombros" ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label>Tipo de residuo</Label>
                    <Select value={tipoResiduo} onValueChange={setTipoResiduo}>
                      <SelectTrigger>
                        <SelectValue placeholder="Sin definir" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SIN_VALOR}>Sin definir</SelectItem>
                        {TIPOS_ESCOMBRO.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <CampoVolumen
                    valor={volumen}
                    onChange={setVolumen}
                    etiqueta="Cantidad declarada"
                  />
                </div>
              ) : (
                <>
                  <div className="grid gap-1.5">
                    <Label>Solicitud</Label>
                    {/* DESPLEGABLE CON `Popover` DE RADIX, en z-[1200].
                        Tres intentos, cada uno fallando por algo distinto, asi
                        que conviene dejar escrito que pasa aca:

                        1. `Popover` con `z-[60]` quedaba DETRAS del dialogo. No
                           era el orden del DOM: `DialogContent` de este
                           proyecto es `z-[1100]`, no el `z-50` de shadcn.
                        2. Una lista `absolute` dentro del formulario quedaba
                           por delante pero la recortaba el `overflow-y-auto`
                           del dialogo, asi que no podia sobresalir.
                        3. Un portal propio a `body` no se recortaba, pero el
                           scroll de la lista no respondia: con un dialogo modal
                           abierto, Radix bloquea la rueda en todo lo que este
                           fuera de su subarbol.

                        `Popover` resuelve los tres: portaliza (no lo recorta
                        nadie) y Radix lo registra como parte del dialogo, asi
                        que el bloqueo de scroll lo deja pasar. Lo unico que
                        habia que corregir era el numero del z-index. */}
                    <Popover open={solicitudAbierta} onOpenChange={abrirSolicitudes}>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="flex h-9 w-full cursor-pointer items-center justify-between rounded-md border border-input bg-transparent px-3 text-sm"
                        >
                          <span
                            className={`truncate ${solicitud === SIN_VALOR ? "text-muted-foreground" : "text-foreground"}`}
                          >
                            {solicitud === SIN_VALOR ? "Sin definir" : solicitud}
                          </span>
                          <ChevronDown
                            className={`ml-2 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${solicitudAbierta ? "rotate-180" : ""}`}
                          />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        align="start"
                        className="z-[1200] w-[var(--radix-popover-trigger-width)] overflow-hidden p-0"
                      >
                        <div className="relative border-b border-border">
                          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            value={filtroSolicitud}
                            onChange={(e) => setFiltroSolicitud(e.target.value)}
                            placeholder="Buscar solicitud"
                            className="h-9 border-0 pl-8 text-xs focus-visible:ring-0"
                          />
                        </div>
                        <ul className="max-h-64 overflow-y-auto p-1">
                          <li>
                            <button
                              type="button"
                              onClick={() => {
                                setSolicitud(SIN_VALOR);
                                setSolicitudAbierta(false);
                              }}
                              className={`w-full cursor-pointer rounded px-2 py-1.5 text-left text-xs hover:bg-accent ${
                                solicitud === SIN_VALOR ? "bg-accent font-medium" : ""
                              }`}
                            >
                              Sin definir
                            </button>
                          </li>
                          {solicitudesFiltradas.map((s) => (
                            <li key={s.id} className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  setSolicitud(s.nombre);
                                  setSolicitudAbierta(false);
                                }}
                                className={`min-w-0 flex-1 cursor-pointer truncate rounded px-2 py-1.5 text-left text-xs hover:bg-accent ${
                                  solicitud === s.nombre ? "bg-accent font-medium" : ""
                                }`}
                              >
                                {s.nombre}
                              </button>
                              {/* Las 17 de la planilla no se borran: son el
                                  vocabulario que entrego la municipalidad. La
                                  papelera va SIEMPRE visible: escondida tras el
                                  puntero, nadie sabe que se puede eliminar. */}
                              {!s.base && (
                                <button
                                  type="button"
                                  onClick={() => setSolicitudABorrar(s)}
                                  className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:text-destructive-strong"
                                  aria-label={`Eliminar ${s.nombre}`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              )}
                            </li>
                          ))}
                          {solicitudesFiltradas.length === 0 && (
                            <li className="px-2 py-3 text-center text-[0.625rem] text-muted-foreground">
                              Ninguna coincide.
                            </li>
                          )}
                        </ul>
                      </PopoverContent>
                    </Popover>
                    {/* El vocabulario es de la municipalidad, no del sistema:
                        se puede ampliar sin un despliegue. */}
                    <div className="mt-1 flex gap-2">
                      <Input
                        value={nuevaSolicitud}
                        onChange={(e) => setNuevaSolicitud(e.target.value)}
                        placeholder="Agregar un tipo de solicitud nuevo"
                        className="h-8 text-xs"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 shrink-0"
                        disabled={!nuevaSolicitud.trim() || agregandoSolicitud}
                        onClick={agregarSolicitud}
                      >
                        {agregandoSolicitud ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Plus className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="pd-sol">Solicitante</Label>
                      <Input
                        id="pd-sol"
                        value={solicitante}
                        onChange={(e) => setSolicitante(e.target.value)}
                        placeholder="Jessica Sotelo"
                      />
                    </div>
                    <CampoVolumen
                      valor={volumen}
                      onChange={setVolumen}
                      etiqueta="Volumen estimado"
                    />
                  </div>
                </>
              )}
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={guardando}>
                Cancelar
              </Button>
              <Button onClick={guardar} disabled={guardando}>
                {guardando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {punto ? "Guardar cambios" : "Crear punto"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>

      {/* Va como hermano del contenido y no adentro: anidado, cerrarlo
          arrastraría el foco del diálogo que lo contiene. */}
      <ConfirmarBorrado
        abierto={solicitudABorrar !== null}
        onOpenChange={(a) => !a && setSolicitudABorrar(null)}
        titulo="Eliminar tipo de solicitud"
        descripcion={
          solicitudABorrar
            ? `Se eliminará "${solicitudABorrar.nombre}" de la lista. Esto no se puede deshacer.`
            : ""
        }
        onConfirmar={async () => {
          if (solicitudABorrar) await borrarSolicitud(solicitudABorrar);
        }}
      />
    </Dialog>
  );
}

function OpcionClase({
  titulo,
  detalle,
  onClick,
}: {
  titulo: string;
  detalle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex cursor-pointer flex-col gap-1.5 rounded-lg border border-border p-4 text-left transition-colors hover:border-cta hover:bg-accent"
    >
      <Construction className="h-5 w-5 text-primary" />
      <span className="text-sm font-medium text-foreground">{titulo}</span>
      <span className="text-[0.6875rem] leading-relaxed text-muted-foreground">{detalle}</span>
    </button>
  );
}

/** El volumen en m³, que es como lo anota la planilla y lo que después usa el
 *  reparto por capacidad. Sin él, el punto se dibuja pero no entra a ninguna
 *  ruta, igual que una zona sin medición. */
function CampoVolumen({
  valor,
  onChange,
  etiqueta,
}: {
  valor: string;
  onChange: (v: string) => void;
  etiqueta: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="pd-vol">{etiqueta} (m³)</Label>
      <Input
        id="pd-vol"
        type="number"
        min="0"
        step="0.5"
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        placeholder="3.5"
      />
    </div>
  );
}
