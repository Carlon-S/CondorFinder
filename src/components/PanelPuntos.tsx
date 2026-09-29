// =============================================================================
// CONDORFINDER, PANEL DE PUNTOS (HDU6)
// Archivo: src/components/PanelPuntos.tsx
//
// Todo lo que era la vista /recursos: definir un punto haciendo clic en el
// mapa, editarlo, eliminarlo, y la lista de los puntos guardados con acceso a
// la flota de cada uno.
//
// Vive como PANEL y ya no como vista propia porque planificar un retiro y
// administrar desde dónde sale la flota son la misma tarea sobre el mismo
// mapa: antes había que cambiar de pantalla para ver si un punto tenía
// capacidad, y volver para generar la ruta.
//
// NO dibuja el mapa. La vista anfitriona es la dueña del mapa, y este panel le
// publica hacia arriba lo que necesita mostrar (el marcador del punto que se
// está ubicando, el manejador de clic mientras se ubica, y a dónde volar) a
// través de onMapProps. Un solo mapa con dos paneles que le hablan, en vez de
// dos mapas que compiten.
// =============================================================================

// =============================================================================
// CONDORFINDER, RECURSOS DISPONIBLES (HDU6)
// Archivo: src/routes/_authed/recursos.tsx
//
// AC1: botón "Definir punto" habilita el modo de click sobre el mapa. AC2: al
// elegir la ubicación se abre la pantalla de configuración del LUGAR (nombre,
// dirección, comuna, personal). La maquinaria ya no se declara acá: son los
// recursos individuales de HDU8, y viven en /recursos/{id}. AC3: "Guardar
// punto" persiste en el perfil (Mongo, vía lib/resources.ts). AC4: botón
// mapa. AC5: "Editar" reabre el mismo formulario de AC2, pre-llenado, y guarda
// con PUT en vez de POST, no es un modo nuevo, es "configuring" con editingId
// seteado. AC6/AC7: confirmar + eliminar, mismo patrón de AlertDialog que ya
// usa index.tsx para "Eliminar zona".
//
// LAYOUT. Encabezado y franja de cifras a lo ancho, después una fila con el
// aside (el punto) y el mapa de alto acotado, y al pie la tabla de PUNTOS.
//
// La flota de cada punto NO está acá: vive en /recursos/{id}, su propia vista.
// Estuvo un tiempo embebida al pie de esta pantalla y no daba abasto, porque
// una tabla de 21 filas con orden, filtros y páginas necesita el ancho y el
// alto completos, no lo que sobra debajo de un mapa.
//
// El mapa va con lockToMaipu: encuadra la comuna completa al abrir y no deja
// salir de ella. Es la única vista con esa restricción; el mapa de rutas sigue
// libre porque ahí hay que poder ver un recorrido entero.
//
// Máquina de 4 modos con useState simple, no hace falta nada del router.
// =============================================================================

import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRightCircle,
  Boxes,
  Loader2,
  MapPin,
  Pencil,
  Trash2,
  Truck as TruckIcon,
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
} from "@/lib/resources";
import { notify } from "@/lib/notify";
type Mode = "idle" | "placing" | "configuring";

interface FormState {
  name: string;
  address: string;
  comuna: string;
  personalCount: string;
  // HDU5/AC1, si este punto participa como origen al generar una ruta.
  active: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  address: "",
  comuna: "",
  personalCount: "0",
  active: true,
};


export interface PanelPuntosMapProps {
  /** El punto que se está creando o editando, mientras se ubica en el mapa. */
  marker: [number, number] | null;
  /** Con valor solo en los modos que esperan un clic sobre el mapa. Cuando es
   *  null, la anfitriona deja que el clic siga su curso normal. */
  onMapClick: ((lat: number, lng: number) => void) | null;
  /** A dónde volar: un punto recién seleccionado, o el resultado de geocodificar
   *  una dirección escrita a mano. */
  focusPoint: [number, number] | null;
}

export function PanelPuntos({
  deepLinkPointId,
  onMapProps,
  onPuntosCambiaron,
  puntoSeleccionadoId,
  puntoAEditarId,
}: {
  /** ?point=id, para abrir directo en un punto concreto. */
  deepLinkPointId?: string;
  /** Se llama cada vez que cambia lo que el panel quiere que el mapa muestre. */
  onMapProps: (props: PanelPuntosMapProps) => void;
  /** Tras crear, editar o eliminar: la anfitriona vuelve a cargar SUS puntos,
   *  que son los mismos marcadores del mapa y los orígenes de la ruta. */
  onPuntosCambiaron: () => void;
  /** Clic en un marcador de punto en el mapa de la anfitriona: lo muestra. */
  puntoSeleccionadoId?: string | null;
  /** Punto que hay que abrir para EDITAR, desde el lápiz de la tabla de abajo.
   *  Es una prop aparte de la anterior porque son dos intenciones distintas:
   *  mirar un punto y modificarlo. */
  puntoAEditarId?: string | null;
}) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("idle");
  const [pendingPoint, setPendingPoint] = useState<[number, number] | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Geocodificación (HDU6), geocodingAddress cubre tanto la inversa
  // (click en el mapa → completa Dirección/Comuna) como la directa
  // (Dirección editada a mano → mueve el marcador), son mutuamente
  // excluyentes en el tiempo así que comparten un solo indicador.
  // geocodeFlyTarget solo se usa para el vuelo del mapa tras un
  // forwardGeocode exitoso, focusPoint ya cubre el caso de click en un
  // punto guardado, este es el mismo mecanismo para el punto en edición.
  const [geocodingAddress, setGeocodingAddress] = useState(false);
  const [geocodeNotFound, setGeocodeNotFound] = useState(false);
  const [geocodeFlyTarget, setGeocodeFlyTarget] = useState<[number, number] | null>(null);
  // true mientras form.address/comuna tiene texto que todavía no se reflejó
  // en pendingPoint, evita depender de que el usuario haga blur (clickear
  // afuera) antes de guardar: handleSave revisa esto y geocodifica él mismo
  // si hace falta. Ref (no state) porque no necesita re-render, solo lo lee
  // código, nunca el JSX.
  const addressDirtyRef = useRef(false);
  // Promesa del forwardGeocode en curso (si lo hay), si el usuario clickea
  // "Guardar cambios" justo cuando el blur ya disparó una geocodificación,
  // handleSave espera ESA misma promesa en vez de lanzar una segunda
  // llamada duplicada a Nominatim.
  const geocodeInFlightRef = useRef<Promise<[number, number] | null> | null>(null);
  // Se incrementa en cada acción que fija la ubicación de forma autoritativa
  // (click en el mapa, forwardGeocode exitoso). locatePoint compara este
  // valor antes de aplicar su resultado, si cambió mientras su
  // reverseGeocode estaba en vuelo (el usuario ya escribió/geocodificó algo
  // más nuevo), descarta el resultado en vez de pisar el campo con texto
  // desactualizado.
  const locationGenRef = useRef(0);

  // AC5, si está seteado, "configuring" es una edición (PUT) sobre este
  // punto en vez de una creación nueva (POST). Mismo formulario para ambos.
  const [editingId, setEditingId] = useState<string | null>(null);

  // AC4, lista de puntos guardados.
  const [points, setPoints] = useState<ResourcePoint[]>([]);
  const [loadingPoints, setLoadingPoints] = useState(false);

  // Punto seleccionado en el mapa (modo "idle" solamente), su info se
  // muestra en este mismo panel, reemplazando los botones de siempre.
  const [selectedPoint, setSelectedPoint] = useState<ResourcePoint | null>(null);

  // AC6/AC7, mismo patrón que index.tsx: deletingPointDisplay retiene el
  // último target no-nulo mientras el diálogo se cierra, para que el texto
  // no parpadee a vacío durante la animación de salida.
  const [deletingPoint, setDeletingPoint] = useState<ResourcePoint | null>(null);
  const [deletingPointDisplay, setDeletingPointDisplay] = useState<ResourcePoint | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (deletingPoint) setDeletingPointDisplay(deletingPoint);
  }, [deletingPoint]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  // cada creación/edición/eliminación, no solo al entrar a la lista.
  const refreshPoints = async () => {
    setLoadingPoints(true);
    try {
      const puntos = await listResourcePoints();
      setPoints(puntos);
      // El punto seleccionado es una COPIA de la lista, así que hay que
      // volver a tomarlo de la respuesta nueva. Sin esto, cambiar la
      // disponibilidad de un recurso actualizaba la lista pero la ficha
      // abierta seguía mostrando la capacidad anterior, que es justo la cifra
      // que el usuario acaba de modificar. Si el punto desapareció (lo borró
      // alguien más), la ficha se cierra en vez de quedar mostrando algo que
      // ya no existe.
      setSelectedPoint((actual) =>
        actual ? puntos.find((p) => p.id === actual.id) ?? null : null,
      );
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


  // Ubica el punto pendiente en (lat, lng) y refresca Dirección/Comuna por
  // geocodificación inversa, usado tanto al definir la ubicación inicial
  // (mode "placing") como al reposicionarla clickeando de nuevo el mapa
  // mientras el formulario ya está abierto (mode "configuring").
  const locatePoint = (lat: number, lng: number) => {
    const gen = ++locationGenRef.current;
    setPendingPoint([lat, lng]);
    setGeocodeNotFound(false);
    setGeocodingAddress(true);
    // El click ya fija la ubicación exacta, lo que venga de la
    // geocodificación inversa es solo texto descriptivo, no hay nada que
    // resincronizar hacia el mapa.
    addressDirtyRef.current = false;
    reverseGeocode(lat, lng)
      .then((result) => {
        // Si en el tiempo que tardó esta respuesta el usuario ya escribió y
        // geocodificó una dirección distinta a mano (locationGenRef avanzó),
        // este resultado quedó obsoleto, aplicarlo pisaría lo que el
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
      setEditingId(null);
      setMode("configuring");
      // El formulario se abre al toque, la dirección/comuna se completan
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
    // propagación, ver GeoMap.tsx), en modo idle, deselecciona el punto
    // que se estuviera mostrando en el panel.
    if (mode === "idle") setSelectedPoint(null);
  };

  const startEditing = (point: ResourcePoint) => {
    setPendingPoint([point.lat, point.lng]);
    setForm({
      name: point.name,
      address: point.address,
      comuna: point.comuna,
      personalCount: String(point.personal_count),
      active: point.active,
    });
    setEditingId(point.id);
    setGeocodeFlyTarget(null);
    setGeocodeNotFound(false);
    addressDirtyRef.current = false;
    setMode("configuring");
  };

  // Geocodificación directa (HDU6), dispara al perder foco (feedback
  // visual inmediato en el mapa mientras se sigue editando), pero
  // handleSave también la llama directo antes de guardar: así el punto
  // queda al día sin depender de que el usuario haya clickeado afuera del
  // campo primero. geocodeInFlightRef evita lanzar una segunda llamada a
  // Nominatim si las dos rutas (blur y guardar) coinciden en el tiempo ,
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
          // tocar el campo (eso la re-marca dirty en el onChange), sin
          // esto, cada click en "Guardar" repetiría la misma búsqueda
          // fallida contra Nominatim.
          addressDirtyRef.current = false;
          return null;
        }
        // Invalida cualquier reverseGeocode de un click anterior que
        // todavía esté en vuelo, esta dirección escrita a mano es más
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

  const handleSave = async () => {
    if (!pendingPoint || !form.name.trim()) return;

    setSaving(true);
    // Si la dirección se editó y todavía no se reflejó en el mapa (el
    // usuario guardó sin sacar el foco del campo antes), se geocodifica acá
    // mismo antes de armar el payload, pendingPoint (closure de este
    // render) quedaría desactualizado si solo se esperara el side effect,
    // por eso se usan las coordenadas que devuelve directamente.
    const resolvedPoint = (await ensureAddressGeocoded()) ?? pendingPoint;
    const payload = {
      name: form.name.trim(),
      address: form.address.trim(),
      comuna: form.comuna.trim(),
      lat: resolvedPoint[0],
      lng: resolvedPoint[1],
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

  // El punto en edición ya se muestra como el marker "pendiente", sin
  // excluirlo de acá quedaría duplicado, superpuesto en el mapa.
  const mapPoints = points
    .filter((p) => p.id !== editingId)
    .map((p) => ({
      id: p.id,
      position: [p.lat, p.lng] as [number, number],
      label: p.active ? p.name : `${p.name} (inactivo)`,
      muted: !p.active,
    }));

  // Publica hacia arriba lo que el mapa tiene que mostrar. Se recalcula solo
  // cuando cambia algo que el mapa ve, no en cada render: onMapProps escribe
  // estado en la anfitriona, y llamarlo sin condición sería un bucle.
  useEffect(() => {
    onMapProps({
      marker: mode === "configuring" ? pendingPoint : null,
      // El mapa solo escucha clics cuando este panel está esperando uno. En los
      // demás modos la anfitriona conserva su propio comportamiento.
      onMapClick: mode === "placing" || mode === "configuring" ? handleMapClick : null,
      focusPoint: selectedPoint ? [selectedPoint.lat, selectedPoint.lng] : geocodeFlyTarget,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pendingPoint, selectedPoint, geocodeFlyTarget]);

  // Un clic en un marcador del mapa lo recibe la anfitriona, que avisa acá.
  useEffect(() => {
    if (!puntoSeleccionadoId) return;
    const encontrado = points.find((p) => p.id === puntoSeleccionadoId);
    if (encontrado) setSelectedPoint(encontrado);
  }, [puntoSeleccionadoId, points]);

  // El lápiz de la tabla de abajo abre el formulario directo, sin pasar por la
  // ficha de solo lectura: quien aprieta un lápiz ya decidió que va a editar.
  useEffect(() => {
    if (!puntoAEditarId) return;
    const encontrado = points.find((p) => p.id === puntoAEditarId);
    if (encontrado) startEditing(encontrado);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puntoAEditarId, points]);

  return (
    <div className="flex flex-col gap-4">

          <div className="flex flex-col gap-4">

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
                      los Input deshabilitados, es una vista, no se guarda
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

                  {/* Los recursos de este punto NO van acá. Estuvieron un rato
                      y era el problema: 21 vehículos en una columna de 280px
                      donde no se leía ni la patente completa. Van en la tabla a
                      lo ancho, al pie de la vista. Lo que queda en el aside son
                      los datos del lugar, que son cinco campos y sí entran. */}

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">
                      Personal (cantidad de trabajadores)
                    </label>
                    <Input value={selectedPoint.personal_count} disabled className="disabled:cursor-default" />
                  </div>
                </div>
              ) : (
                <div className="animate-in fade-in slide-in-from-left-2 duration-300 flex flex-col gap-5">
                  <div className="flex flex-col gap-2 rounded-lg bg-background/40 p-3">
                    <Button onClick={startPlacing} size="lg" className="btn-cta w-full">
                      <MapPin className="mr-2 h-4 w-4" /> Definir punto
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

            {/* El modo "listing" ya no existe. Era una segunda lista de los
                mismos puntos dentro de un panel angosto, y la de abajo los
                muestra con sus cifras. Para editar uno se hace clic en su
                marcador del mapa o en el lápiz de esa tabla. */}

            {mode === "configuring" && (
              <div className="animate-in fade-in slide-in-from-left-2 duration-300 space-y-5">
                <p className="text-[0.6875rem] text-muted-foreground">
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
                    <p className="text-[0.625rem] text-muted-foreground">
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
                      <span className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">
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
                    <p className="text-[0.625rem] text-muted-foreground">
                      No se encontró esta dirección en el mapa, el punto no se movió.
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

                {/* Acá estaban los contadores de tolvas, retroexcavadoras y
                    camiones. Ya no: con HDU8 la maquinaria son recursos
                    individuales que se agregan desde la ficha del punto, uno por
                    uno y con su patente. Mantener también los contadores dejaba
                    dos formas de declarar lo mismo y ninguna manera de saber
                    cuál manda.

                    Personal se queda: es el único dato de HDU6 sin equivalente
                    en la planilla de flota, que trae la dotación que un vehículo
                    REQUIERE, no los trabajadores que el punto TIENE. */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Personal (cantidad de trabajadores)
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
        {/* La LISTA de puntos no va acá. Vive en la tabla al pie de la vista
            de planificación, con las cifras de cada punto (recursos, capacidad,
            estado), que es lo que se compara. En el panel era una segunda copia
            de la misma lista, sin esas cifras y sin sitio para mostrarlas.

            Este panel se queda con lo que SÍ es del panel: las acciones y la
            ficha del punto que se está viendo o editando. */}

      {/* AC6, confirmación de eliminación, mismo patrón que "Eliminar zona" en index.tsx */}
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
