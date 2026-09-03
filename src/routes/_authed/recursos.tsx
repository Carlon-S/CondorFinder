// =============================================================================
// CONDORFINDER — RECURSOS DISPONIBLES (HDU6)
// Archivo: src/routes/_authed/recursos.tsx
//
// AC1: botón "Definir punto" habilita el modo de click sobre el
// mapa. AC2: al elegir la ubicación se abre la pantalla de configuración
// (tolvas, retroexcavadoras, camiones, personal). AC8: camiones es una
// lista, cada uno con su propia capacidad. AC9: personal es solo cantidad.
// AC3: "Guardar punto" persiste en el perfil (Mongo, vía lib/resources.ts).
// AC4: botón "Modificar puntos" lista todos los puntos guardados
// y los muestra en el mapa. AC5: "Editar" reabre el mismo formulario de
// AC2, pre-llenado, y guarda con PUT en vez de POST — no es un modo nuevo,
// es "configuring" con editingId seteado. AC6/AC7: confirmar + eliminar,
// mismo patrón de AlertDialog que ya usa index.tsx para "Eliminar zona".
//
// Layout de dos columnas (aside + mapa) igual al de analysis.tsx — mismo
// lenguaje visual que el resto de la app. Máquina de 4 modos con useState
// simple, no hace falta nada del router para esto.
// =============================================================================

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Loader2, MapPin, Pencil, Trash2, Truck as TruckIcon, Warehouse, X } from "@/components/icons/Icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { GeoMap, type GeoMapPoint } from "@/components/GeoMap";
import { ResourcesSummaryPanel } from "@/components/ResourcesSummaryPanel";
import { forwardGeocode, reverseGeocode } from "@/lib/geocoding";
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
  createResourcePoint,
  deleteResourcePoint,
  listResourcePoints,
  updateResourcePoint,
  type ResourcePoint,
  type Tolva,
  type Truck,
} from "@/lib/resources";
import { notify } from "@/lib/notify";

interface RecursosSearch {
  point?: string;
}

export const Route = createFileRoute("/_authed/recursos")({
  // ?point=<id> — deep-link desde el accordion de Vista Principal ("Ver en
  // el mapa"): con el id ya en la URL, el efecto de abajo selecciona ese
  // punto apenas se cargan los puntos, sin haber clickeado nada acá.
  // point?: en vez de point: string | undefined — así queda como key
  // realmente opcional (un <Link to="/recursos"> sin search sigue
  // compilando), no una requerida cuyo valor puede ser undefined.
  validateSearch: (search: Record<string, unknown>): RecursosSearch =>
    typeof search.point === "string" ? { point: search.point } : {},
  component: RecursosPage,
});

type Mode = "idle" | "placing" | "configuring" | "listing";

interface FormState {
  name: string;
  address: string;
  comuna: string;
  retroCount: string;
  personalCount: string;
  // HDU5/AC1 — si este punto participa como origen al generar una ruta.
  active: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  address: "",
  comuna: "",
  retroCount: "0",
  personalCount: "0",
  active: true,
};

function RecursosPage() {
  const { point: deepLinkPointId } = Route.useSearch();
  const [mode, setMode] = useState<Mode>("idle");
  const [pendingPoint, setPendingPoint] = useState<[number, number] | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [tolvas, setTolvas] = useState<Tolva[]>([]);
  const [trucks, setTrucks] = useState<Truck[]>([]);
  const [saving, setSaving] = useState(false);

  // Geocodificación (HDU6) — geocodingAddress cubre tanto la inversa
  // (click en el mapa → completa Dirección/Comuna) como la directa
  // (Dirección editada a mano → mueve el marcador), son mutuamente
  // excluyentes en el tiempo así que comparten un solo indicador.
  // geocodeFlyTarget solo se usa para el vuelo del mapa tras un
  // forwardGeocode exitoso — focusPoint ya cubre el caso de click en un
  // punto guardado, este es el mismo mecanismo para el punto en edición.
  const [geocodingAddress, setGeocodingAddress] = useState(false);
  const [geocodeNotFound, setGeocodeNotFound] = useState(false);
  const [geocodeFlyTarget, setGeocodeFlyTarget] = useState<[number, number] | null>(null);
  // true mientras form.address/comuna tiene texto que todavía no se reflejó
  // en pendingPoint — evita depender de que el usuario haga blur (clickear
  // afuera) antes de guardar: handleSave revisa esto y geocodifica él mismo
  // si hace falta. Ref (no state) porque no necesita re-render, solo lo lee
  // código, nunca el JSX.
  const addressDirtyRef = useRef(false);
  // Promesa del forwardGeocode en curso (si lo hay) — si el usuario clickea
  // "Guardar cambios" justo cuando el blur ya disparó una geocodificación,
  // handleSave espera ESA misma promesa en vez de lanzar una segunda
  // llamada duplicada a Nominatim.
  const geocodeInFlightRef = useRef<Promise<[number, number] | null> | null>(null);
  // Se incrementa en cada acción que fija la ubicación de forma autoritativa
  // (click en el mapa, forwardGeocode exitoso). locatePoint compara este
  // valor antes de aplicar su resultado — si cambió mientras su
  // reverseGeocode estaba en vuelo (el usuario ya escribió/geocodificó algo
  // más nuevo), descarta el resultado en vez de pisar el campo con texto
  // desactualizado.
  const locationGenRef = useRef(0);

  // AC5 — si está seteado, "configuring" es una edición (PUT) sobre este
  // punto en vez de una creación nueva (POST). Mismo formulario para ambos.
  const [editingId, setEditingId] = useState<string | null>(null);

  // AC4 — lista de puntos guardados.
  const [points, setPoints] = useState<ResourcePoint[]>([]);
  const [loadingPoints, setLoadingPoints] = useState(false);

  // Punto seleccionado en el mapa (modo "idle" solamente) — su info se
  // muestra en este mismo panel, reemplazando los botones de siempre.
  const [selectedPoint, setSelectedPoint] = useState<ResourcePoint | null>(null);

  // AC6/AC7 — mismo patrón que index.tsx: deletingPointDisplay retiene el
  // último target no-nulo mientras el diálogo se cierra, para que el texto
  // no parpadee a vacío durante la animación de salida.
  const [deletingPoint, setDeletingPoint] = useState<ResourcePoint | null>(null);
  const [deletingPointDisplay, setDeletingPointDisplay] = useState<ResourcePoint | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (deletingPoint) setDeletingPointDisplay(deletingPoint);
  }, [deletingPoint]);

  // Deep-link (?point=id) desde el accordion de Vista Principal — una vez
  // que los puntos están cargados, selecciona el mismo que un click real en
  // el marker seleccionaría (mismo estado, mismo camino hacia el vuelo del
  // mapa vía el focusPoint derivado más abajo).
  useEffect(() => {
    if (!deepLinkPointId || points.length === 0) return;
    const found = points.find((p) => p.id === deepLinkPointId);
    if (found) setSelectedPoint(found);
  }, [deepLinkPointId, points]);

  const backToIdle = () => {
    setMode("idle");
    setPendingPoint(null);
    setEditingId(null);
    setGeocodeFlyTarget(null);
    setGeocodeNotFound(false);
  };

  const startPlacing = () => setMode("placing");

  // Los puntos ahora se ven siempre en el mapa (no solo en modo "listing"),
  // así que este fetch corre al montar la página y se reusa después de
  // cada creación/edición/eliminación — no solo al entrar a la lista.
  const refreshPoints = async () => {
    setLoadingPoints(true);
    try {
      setPoints(await listResourcePoints());
    } catch (err) {
      notify.error(
        "No se pudieron cargar los puntos",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
    } finally {
      setLoadingPoints(false);
    }
  };

  useEffect(() => {
    refreshPoints();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startListing = () => setMode("listing");

  // Ubica el punto pendiente en (lat, lng) y refresca Dirección/Comuna por
  // geocodificación inversa — usado tanto al definir la ubicación inicial
  // (mode "placing") como al reposicionarla clickeando de nuevo el mapa
  // mientras el formulario ya está abierto (mode "configuring").
  const locatePoint = (lat: number, lng: number) => {
    const gen = ++locationGenRef.current;
    setPendingPoint([lat, lng]);
    setGeocodeNotFound(false);
    setGeocodingAddress(true);
    // El click ya fija la ubicación exacta — lo que venga de la
    // geocodificación inversa es solo texto descriptivo, no hay nada que
    // resincronizar hacia el mapa.
    addressDirtyRef.current = false;
    reverseGeocode(lat, lng)
      .then((result) => {
        // Si en el tiempo que tardó esta respuesta el usuario ya escribió y
        // geocodificó una dirección distinta a mano (locationGenRef avanzó),
        // este resultado quedó obsoleto — aplicarlo pisaría lo que el
        // usuario ya confirmó con texto más nuevo.
        if (result && locationGenRef.current === gen) {
          setForm((f) => ({ ...f, address: result.address || f.address, comuna: result.comuna || f.comuna }));
        }
      })
      .finally(() => setGeocodingAddress(false));
  };

  const handleMapClick = (lat: number, lng: number) => {
    if (mode === "placing") {
      setForm(EMPTY_FORM);
      setTolvas([]);
      setTrucks([]);
      setEditingId(null);
      setMode("configuring");
      // El formulario se abre al toque — la dirección/comuna se completan
      // solas un instante después, sin bloquear la apertura del modo
      // "configuring".
      locatePoint(lat, lng);
      return;
    }
    if (mode === "configuring") {
      // Reposicionar: el usuario ya está definiendo el punto y clickea otro
      // lugar del mapa para corregirlo, sin salir del formulario.
      locatePoint(lat, lng);
      return;
    }
    // Click en el mapa fuera de cualquier marker (esos ya cortan su propia
    // propagación, ver GeoMap.tsx) — en modo idle, deselecciona el punto
    // que se estuviera mostrando en el panel.
    if (mode === "idle") setSelectedPoint(null);
  };

  const handlePointClick = (point: GeoMapPoint) => {
    if (mode !== "idle") return;
    setSelectedPoint(points.find((p) => p.id === point.id) ?? null);
  };

  const startEditing = (point: ResourcePoint) => {
    setPendingPoint([point.lat, point.lng]);
    setForm({
      name: point.name,
      address: point.address,
      comuna: point.comuna,
      retroCount: String(point.retroexcavadoras_count),
      personalCount: String(point.personal_count),
      active: point.active,
    });
    setTolvas(point.tolvas);
    setTrucks(point.trucks);
    setEditingId(point.id);
    setGeocodeFlyTarget(null);
    setGeocodeNotFound(false);
    addressDirtyRef.current = false;
    setMode("configuring");
  };

  // Geocodificación directa (HDU6) — dispara al perder foco (feedback
  // visual inmediato en el mapa mientras se sigue editando), pero
  // handleSave también la llama directo antes de guardar: así el punto
  // queda al día sin depender de que el usuario haya clickeado afuera del
  // campo primero. geocodeInFlightRef evita lanzar una segunda llamada a
  // Nominatim si las dos rutas (blur y guardar) coinciden en el tiempo —
  // ambas esperan la misma promesa.
  const ensureAddressGeocoded = (): Promise<[number, number] | null> => {
    if (geocodeInFlightRef.current) return geocodeInFlightRef.current;
    if (!addressDirtyRef.current || form.address.trim().length <= 3) return Promise.resolve(null);

    const promise = (async (): Promise<[number, number] | null> => {
      setGeocodingAddress(true);
      setGeocodeNotFound(false);
      try {
        const result = await forwardGeocode(`${form.address}, ${form.comuna || "Maipú"}, Chile`);
        if (!result) {
          setGeocodeNotFound(true);
          // No hay nada más que reintentar hasta que el usuario vuelva a
          // tocar el campo (eso la re-marca dirty en el onChange) — sin
          // esto, cada click en "Guardar" repetiría la misma búsqueda
          // fallida contra Nominatim.
          addressDirtyRef.current = false;
          return null;
        }
        // Invalida cualquier reverseGeocode de un click anterior que
        // todavía esté en vuelo — esta dirección escrita a mano es más
        // nueva y no debe ser pisada por esa respuesta tardía.
        locationGenRef.current++;
        const coords: [number, number] = [result.lat, result.lng];
        setPendingPoint(coords);
        setGeocodeFlyTarget(coords);
        addressDirtyRef.current = false;
        return coords;
      } finally {
        setGeocodingAddress(false);
        geocodeInFlightRef.current = null;
      }
    })();

    geocodeInFlightRef.current = promise;
    return promise;
  };

  const addTolva = () => setTolvas((prev) => [...prev, { capacity_m3: 0 }]);
  const updateTolvaCapacity = (index: number, capacity: number) =>
    setTolvas((prev) => prev.map((t, i) => (i === index ? { capacity_m3: capacity } : t)));
  const removeTolva = (index: number) => setTolvas((prev) => prev.filter((_, i) => i !== index));

  const addTruck = () => setTrucks((prev) => [...prev, { capacity_m3: 0 }]);
  const updateTruckCapacity = (index: number, capacity: number) =>
    setTrucks((prev) => prev.map((t, i) => (i === index ? { capacity_m3: capacity } : t)));
  const removeTruck = (index: number) => setTrucks((prev) => prev.filter((_, i) => i !== index));

  const handleSave = async () => {
    if (!pendingPoint || !form.name.trim()) return;
    setSaving(true);
    // Si la dirección se editó y todavía no se reflejó en el mapa (el
    // usuario guardó sin sacar el foco del campo antes), se geocodifica acá
    // mismo antes de armar el payload — pendingPoint (closure de este
    // render) quedaría desactualizado si solo se esperara el side effect,
    // por eso se usan las coordenadas que devuelve directamente.
    const resolvedPoint = (await ensureAddressGeocoded()) ?? pendingPoint;
    const payload = {
      name: form.name.trim(),
      address: form.address.trim(),
      comuna: form.comuna.trim(),
      lat: resolvedPoint[0],
      lng: resolvedPoint[1],
      tolvas,
      retroexcavadoras_count: Number(form.retroCount) || 0,
      trucks,
      personal_count: Number(form.personalCount) || 0,
      active: form.active,
    };
    try {
      if (editingId) {
        await updateResourcePoint(editingId, payload);
        notify.success("Punto actualizado", `Los cambios en "${payload.name}" quedaron guardados.`);
      } else {
        await createResourcePoint(payload);
        notify.success("Punto guardado", `"${payload.name}" quedó guardado en tu perfil.`);
      }
      await refreshPoints();
      backToIdle();
    } catch (err) {
      notify.error(
        editingId ? "No se pudo actualizar el punto" : "No se pudo guardar el punto",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deletingPoint) return;
    setDeleting(true);
    try {
      await deleteResourcePoint(deletingPoint.id);
      notify.success("Punto eliminado", `"${deletingPoint.name}" se borró de tu perfil.`);
      setDeletingPoint(null);
      await refreshPoints();
    } catch (err) {
      notify.error(
        "No se pudo eliminar el punto",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
    } finally {
      setDeleting(false);
    }
  };

  // El punto en edición ya se muestra como el marker "pendiente" — sin
  // excluirlo de acá quedaría duplicado, superpuesto en el mapa.
  const mapPoints = points
    .filter((p) => p.id !== editingId)
    .map((p) => ({
      id: p.id,
      position: [p.lat, p.lng] as [number, number],
      label: p.active ? p.name : `${p.name} (inactivo)`,
      muted: !p.active,
    }));

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <main className="grid min-h-0 flex-1 grid-cols-[clamp(240px,22vw,360px)_1fr]">
        <aside className="overflow-y-auto border-r border-border/35 p-5">
          <div className="flex flex-col gap-4">
            <div>
              <h1 className="font-rubik text-3xl font-semibold tracking-normal text-foreground md:text-4xl">
                Recursos disponibles
              </h1>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Define puntos y los recursos disponibles en cada uno
                para planificar rutas de recolección.
              </p>
            </div>

            {mode === "idle" && (
              selectedPoint ? (
                <div className="animate-in fade-in slide-in-from-left-2 duration-300 space-y-5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-foreground">Punto</p>
                    <button
                      type="button"
                      onClick={() => setSelectedPoint(null)}
                      aria-label="Cerrar"
                      className="flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Mismo layout que el formulario de AC2 (para que "verlo"
                      se sienta consistente con "editarlo"), pero con todos
                      los Input deshabilitados — es una vista, no se guarda
                      nada desde acá. */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Nombre del punto</label>
                    <Input value={selectedPoint.name} disabled className="disabled:cursor-default" />
                  </div>

                  <div className="flex items-center justify-between rounded-lg bg-background/40 p-3">
                    <span className="text-xs font-medium text-foreground">Punto activo</span>
                    <Switch checked={selectedPoint.active} disabled className="disabled:cursor-default disabled:opacity-100" />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Dirección</label>
                    <Input value={selectedPoint.address} disabled className="disabled:cursor-default" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Comuna</label>
                    <Input value={selectedPoint.comuna} disabled className="disabled:cursor-default" />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Tolvas</label>
                    {selectedPoint.tolvas.length === 0 ? (
                      <p className="rounded-md border border-dashed border-border/50 py-3 text-center text-xs text-muted-foreground">
                        Sin tolvas agregadas
                      </p>
                    ) : (
                      <ul className="space-y-2">
                        {selectedPoint.tolvas.map((tolva, i) => (
                          <li key={i} className="flex items-center gap-2">
                            <Warehouse className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                            <Input value={tolva.capacity_m3} disabled className="h-8 disabled:cursor-default" />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">
                      Retroexcavadoras — cantidad
                    </label>
                    <Input value={selectedPoint.retroexcavadoras_count} disabled className="disabled:cursor-default" />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Camiones</label>
                    {selectedPoint.trucks.length === 0 ? (
                      <p className="rounded-md border border-dashed border-border/50 py-3 text-center text-xs text-muted-foreground">
                        Sin camiones agregados
                      </p>
                    ) : (
                      <ul className="space-y-2">
                        {selectedPoint.trucks.map((truck, i) => (
                          <li key={i} className="flex items-center gap-2">
                            <TruckIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                            <Input value={truck.capacity_m3} disabled className="h-8 disabled:cursor-default" />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">
                      Personal — cantidad de trabajadores
                    </label>
                    <Input value={selectedPoint.personal_count} disabled className="disabled:cursor-default" />
                  </div>
                </div>
              ) : (
                <div className="animate-in fade-in slide-in-from-left-2 duration-300 flex flex-col gap-5">
                  <ResourcesSummaryPanel points={points} loading={loadingPoints} />
                  <div className="flex flex-col gap-2 rounded-lg bg-background/40 p-3">
                    <Button onClick={startPlacing} size="lg" className="btn-cta w-full">
                      <MapPin className="mr-2 h-4 w-4" /> Definir punto
                    </Button>
                    <Button onClick={startListing} variant="secondary" className="w-full">
                      <Pencil className="mr-2 h-4 w-4" /> Modificar puntos
                    </Button>
                  </div>
                </div>
              )
            )}

            {mode === "placing" && (
              <div className="animate-in fade-in slide-in-from-left-2 duration-300 rounded-lg border border-primary/30 bg-primary/5 p-4 text-center">
                <MapPin className="mx-auto mb-2 h-6 w-6 text-primary" />
                <p className="text-sm font-medium">Haz clic en el mapa para ubicar el punto</p>
                <Button variant="ghost" size="sm" onClick={backToIdle} className="mt-3">
                  Cancelar
                </Button>
              </div>
            )}

            {mode === "listing" && (
              <div className="animate-in fade-in slide-in-from-left-2 duration-300 space-y-3">
                <button
                  type="button"
                  onClick={backToIdle}
                  className="cursor-pointer text-xs text-primary hover:underline"
                >
                  ← Volver
                </button>

                {loadingPoints ? (
                  <div className="flex justify-center py-6">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : points.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border/50 py-6 text-center text-xs text-muted-foreground">
                    Todavía no hay puntos guardados.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {points.map((p) => (
                      <li
                        key={p.id}
                        className={`flex items-center gap-2 rounded-md border border-border/60 bg-background/60 p-2 animate-in fade-in duration-200 ${p.active ? "" : "opacity-45"}`}
                      >
                        <MapPin className="h-3.5 w-3.5 flex-shrink-0 text-primary/70" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {p.name}
                          {!p.active && <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">(inactivo)</span>}
                        </span>
                        <button
                          type="button"
                          onClick={() => startEditing(p)}
                          aria-label="Modificar"
                          className="flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingPoint(p)}
                          aria-label="Eliminar"
                          className="flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {mode === "configuring" && (
              <div className="animate-in fade-in slide-in-from-left-2 duration-300 space-y-5">
                <p className="text-[11px] text-muted-foreground">
                  ¿La ubicación no quedó bien? Haz clic en otro lugar del mapa para corregirla.
                </p>

                <div className="space-y-1.5">
                  <label htmlFor="point-name" className="text-xs font-medium text-muted-foreground">
                    Nombre del punto
                  </label>
                  <Input
                    id="point-name"
                    autoFocus
                    placeholder="Ej: Patio municipal Maipú"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg bg-background/40 p-3">
                  <div>
                    <label htmlFor="point-active" className="text-xs font-medium text-foreground">
                      Punto activo
                    </label>
                    <p className="text-[10px] text-muted-foreground">
                      Participa como origen al generar una ruta.
                    </p>
                  </div>
                  <Switch
                    id="point-active"
                    checked={form.active}
                    onCheckedChange={(checked) => setForm((f) => ({ ...f, active: checked }))}
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label htmlFor="point-address" className="text-xs font-medium text-muted-foreground">
                      Dirección
                    </label>
                    {geocodingAddress && (
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Buscando dirección…
                      </span>
                    )}
                  </div>
                  <Input
                    id="point-address"
                    placeholder="Ej: Av. Pajaritos 1234"
                    value={form.address}
                    onChange={(e) => {
                      addressDirtyRef.current = true;
                      setForm((f) => ({ ...f, address: e.target.value }));
                    }}
                    onBlur={ensureAddressGeocoded}
                  />
                  {geocodeNotFound && (
                    <p className="text-[10px] text-muted-foreground">
                      No se encontró esta dirección en el mapa — el punto no se movió.
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="point-comuna" className="text-xs font-medium text-muted-foreground">
                    Comuna
                  </label>
                  <Input
                    id="point-comuna"
                    placeholder="Ej: Maipú"
                    value={form.comuna}
                    onChange={(e) => {
                      addressDirtyRef.current = true;
                      setForm((f) => ({ ...f, comuna: e.target.value }));
                    }}
                    onBlur={ensureAddressGeocoded}
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Tolvas</label>
                    <button
                      type="button"
                      onClick={addTolva}
                      className="cursor-pointer text-[10px] text-primary hover:underline"
                    >
                      + Agregar tolva
                    </button>
                  </div>
                  {tolvas.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border/50 py-3 text-center text-xs text-muted-foreground">
                      Sin tolvas agregadas
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {tolvas.map((tolva, i) => (
                        <li
                          key={i}
                          className="flex items-center gap-2 animate-in fade-in zoom-in-95 duration-200"
                        >
                          <Warehouse className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                          <Input
                            type="number"
                            min={0}
                            placeholder="Capacidad (m³)"
                            value={tolva.capacity_m3 || ""}
                            onChange={(e) => updateTolvaCapacity(i, Number(e.target.value))}
                            className="h-8"
                          />
                          <button
                            type="button"
                            onClick={() => removeTolva(i)}
                            aria-label="Eliminar tolva"
                            className="flex h-8 w-8 flex-shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Retroexcavadoras — cantidad
                  </label>
                  <Input
                    type="number"
                    min={0}
                    value={form.retroCount}
                    onChange={(e) => setForm((f) => ({ ...f, retroCount: e.target.value }))}
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Camiones</label>
                    <button
                      type="button"
                      onClick={addTruck}
                      className="cursor-pointer text-[10px] text-primary hover:underline"
                    >
                      + Agregar camión
                    </button>
                  </div>
                  {trucks.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border/50 py-3 text-center text-xs text-muted-foreground">
                      Sin camiones agregados
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {trucks.map((truck, i) => (
                        <li
                          key={i}
                          className="flex items-center gap-2 animate-in fade-in zoom-in-95 duration-200"
                        >
                          <TruckIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                          <Input
                            type="number"
                            min={0}
                            placeholder="Capacidad (m³)"
                            value={truck.capacity_m3 || ""}
                            onChange={(e) => updateTruckCapacity(i, Number(e.target.value))}
                            className="h-8"
                          />
                          <button
                            type="button"
                            onClick={() => removeTruck(i)}
                            aria-label="Eliminar camión"
                            className="flex h-8 w-8 flex-shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Personal — cantidad de trabajadores
                  </label>
                  <Input
                    type="number"
                    min={0}
                    value={form.personalCount}
                    onChange={(e) => setForm((f) => ({ ...f, personalCount: e.target.value }))}
                  />
                </div>

                <div className="flex gap-2 pt-2">
                  <Button variant="ghost" onClick={backToIdle} className="flex-1" disabled={saving}>
                    Cancelar
                  </Button>
                  <Button onClick={handleSave} className="flex-1" disabled={saving || !form.name.trim()}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {editingId ? "Guardar cambios" : "Guardar punto"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </aside>

        <section className="relative min-w-0 overflow-hidden bg-background animate-in fade-in duration-500">
          <GeoMap
            className="h-full w-full"
            marker={mode === "configuring" ? pendingPoint : null}
            points={mapPoints}
            focusPoint={selectedPoint ? [selectedPoint.lat, selectedPoint.lng] : geocodeFlyTarget}
            onMapClick={handleMapClick}
            onPointClick={handlePointClick}
          />
          {/* Sin esto, mientras listResourcePoints() todavía no resuelve el
              mapa se ve simplemente vacío -- indistinguible de "no hay
              puntos guardados todavía" para quien lo mira. */}
          {loadingPoints && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/60">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </section>
      </main>

      {/* AC6 — confirmación de eliminación, mismo patrón que "Eliminar zona" en index.tsx */}
      <AlertDialog
        open={deletingPoint !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingPoint(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar punto</AlertDialogTitle>
            <AlertDialogDescription>
              Esto elimina permanentemente "{deletingPointDisplay?.name}" y sus recursos asociados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeletingPoint(null)} disabled={deleting}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={deleting}>
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
