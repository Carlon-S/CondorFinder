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
import {
  detalleDeSugerencia,
  forwardGeocode,
  reverseGeocode,
  sugerirDirecciones,
  type SugerenciaDireccion,
} from "@/lib/geocoding";
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
// Dos modos, no tres. "placing" (esperar un clic en el mapa con el panel
// vacío) desapareció junto con el botón "Definir punto": el formulario está
// desde el principio, y ubicar el punto es un campo más de ese formulario,
// no un paso previo que haya que desbloquear.
//
//   configuring -> creando un punto nuevo (editingId null) o editando uno
//   idle        -> mostrando la ficha de solo lectura de un punto del mapa
type Mode = "idle" | "configuring";

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
  onIntencionAtendida,
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
  /** Aviso de que el panel ya atendió la intención, para que la anfitriona la
   *  borre. Las dos props de arriba son ÓRDENES de un solo uso, no estado.
   *
   *  Sin esto eran estado: la anfitriona ponía el id y no lo sacaba nunca, y el
   *  efecto que las lee depende también de la lista de puntos, así que volvía a
   *  ejecutarse en CADA recarga de puntos (guardar, borrar, o mover el
   *  interruptor de cualquier fila). El panel entraba de nuevo, sin avisar, a
   *  editar el punto de aquel lápiz apretado hacía rato; lo que se escribía
   *  después se guardaba con PUT contra ese id viejo. Si ese punto ya no
   *  existía daba 404 "Punto no encontrado", y si existía sobrescribía otro
   *  punto en vez de crear el nuevo. Recargar la página lo "arreglaba" porque
   *  el id se perdía, que es lo que lo hacía parecer intermitente. */
  onIntencionAtendida?: () => void;
}) {
  const navigate = useNavigate();
  // Arranca en el formulario, no en una pantalla de espera. Crear un punto es
  // lo que se viene a hacer acá, y tenerlo detrás de un botón obligaba a
  // descubrir primero que el botón existe.
  const [mode, setMode] = useState<Mode>("configuring");
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
  /** Sugerencias de dirección mientras se escribe. Vacío cuando no hay clave
   *  de Google configurada, y entonces el campo se comporta como el texto libre
   *  de siempre: el autocompletado es una ayuda, no un requisito. */
  const [sugerencias, setSugerencias] = useState<SugerenciaDireccion[]>([]);
  const [eligiendoSugerencia, setEligiendoSugerencia] = useState(false);

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

  useEffect(() => {
    if (!deepLinkPointId || points.length === 0) return;
    const found = points.find((p) => p.id === deepLinkPointId);
    if (found) setSelectedPoint(found);
  }, [deepLinkPointId, points]);

  /** Deja el panel como recién abierto: formulario en blanco para un punto
   *  nuevo. Es a donde se vuelve al guardar, al cancelar y al cerrar la ficha
   *  de un punto, porque no hay ningún estado "sin nada" al que regresar. */
  const nuevoPunto = () => {
    setMode("configuring");
    setForm(EMPTY_FORM);
    setPendingPoint(null);
    setEditingId(null);
    setSelectedPoint(null);
    setGeocodeFlyTarget(null);
    setGeocodeNotFound(false);
    addressDirtyRef.current = false;
  };

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
        actual ? (puntos.find((p) => p.id === actual.id) ?? null) : null,
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
          setForm((f) => ({
            ...f,
            address: result.address || f.address,
            comuna: result.comuna || f.comuna,
          }));
        }
      })
      .finally(() => setGeocodingAddress(false));
  };

  const handleMapClick = (lat: number, lng: number) => {
    if (mode === "configuring") {
      // Reposicionar: el usuario ya está definiendo el punto y clickea otro
      // lugar del mapa para corregirlo, sin salir del formulario.
      locatePoint(lat, lng);
      return;
    }
    // Click en el mapa fuera de cualquier marker (esos ya cortan su propia
    // propagación, ver GeoMap.tsx), en modo idle, deselecciona el punto
    // que se estuviera mostrando en el panel.
    // Clic en el mapa con una ficha abierta: la cierra y devuelve el panel al
    // formulario, que es su estado normal.
    if (mode === "idle") nuevoPunto();
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
        // La comuna viene en la MISMA respuesta cuando contesta Google, así que
        // llenarla no cuesta una solicitud más. Antes solo la llenaba el click
        // en el mapa, y escribir la dirección a mano dejaba al trabajador
        // corrigiendo un dato que el servicio ya sabía.
        //
        // `|| f.comuna` por lo mismo que la dirección en el click: con el
        // respaldo de Nominatim estos campos no vienen, y pisar con vacío sería
        // peor que no tocar nada.
        if (result.address || result.comuna) {
          setForm((f) => ({
            ...f,
            address: result.address || f.address,
            comuna: result.comuna || f.comuna,
          }));
        }
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

  // ── Sugerencias de dirección ──
  //
  // El antirrebote de 350 ms NO es pulido: Autocomplete se cobra POR SOLICITUD
  // y no por sesión, así que sin él sería una petición por tecla. Con él, una
  // dirección completa cuesta unas cinco.
  //
  // Solo busca cuando el campo está `dirty`, o sea cuando lo escribió una
  // persona. Un click en el mapa también llena este campo, y ahí pedir
  // sugerencias sería gastar para ofrecerle al trabajador que corrija una
  // dirección que el sistema acaba de deducir de su propio click.
  useEffect(() => {
    if (!addressDirtyRef.current || form.address.trim().length < 3) {
      setSugerencias([]);
      return;
    }
    let cancelado = false;
    const t = setTimeout(async () => {
      const r = await sugerirDirecciones(form.address);
      if (!cancelado) setSugerencias(r);
    }, 350);
    return () => {
      cancelado = true;
      clearTimeout(t);
    };
  }, [form.address]);

  /** Aplica una sugerencia elegida: dirección, comuna y marcador de una sola
   *  vez. Es UNA llamada a Place Details, y evita la geocodificación directa
   *  que el `onBlur` haría si no, porque ya trae la coordenada. */
  const elegirSugerencia = async (s: SugerenciaDireccion) => {
    setSugerencias([]);
    setEligiendoSugerencia(true);
    try {
      const d = await detalleDeSugerencia(s.placeId);
      if (!d) {
        // Sin detalle queda el texto de la sugerencia, que ya es mejor que lo
        // escrito a mano, y el `onBlur` de siempre se encarga de ubicarlo.
        setForm((f) => ({ ...f, address: s.texto }));
        addressDirtyRef.current = true;
        return;
      }
      // Mismo orden que ensureAddressGeocoded: invalidar primero cualquier
      // reverseGeocode de un click anterior que siga en vuelo, para que su
      // respuesta tardía no pise lo que el trabajador acaba de elegir.
      locationGenRef.current++;
      const coords: [number, number] = [d.lat, d.lng];
      setForm((f) => ({
        ...f,
        address: d.address || s.texto,
        comuna: d.comuna || f.comuna,
      }));
      setPendingPoint(coords);
      setGeocodeFlyTarget(coords);
      setGeocodeNotFound(false);
      // Ya está ubicado: sin esto, el onBlur del campo volvería a geocodificar
      // la misma dirección y gastaría una solicitud de más.
      addressDirtyRef.current = false;
    } finally {
      setEligiendoSugerencia(false);
    }
  };

  /** Qué falta para poder guardar, o null si no falta nada. Es una sola
   *  función y no una condición repetida, porque el botón la usa para
   *  deshabilitarse Y para decir el motivo: separadas, terminaba deshabilitado
   *  por una razón y explicando otra. */
  const loQueFalta = (): string | null => {
    if (!form.name.trim()) return "Falta el nombre del punto";
    if (!pendingPoint) return "Falta ubicar el punto en el mapa";
    if (!form.address.trim()) return "Falta la dirección";
    if (!form.comuna.trim()) return "Falta la comuna";
    return null;
  };

  const handleSave = async () => {
    if (loQueFalta() || !pendingPoint) return;

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
        // Un punto recién creado no tiene flota, y sin flota no participa de
        // ninguna ruta: es lo primero que hay que hacerle. Así que en vez de
        // dejar el formulario en blanco, se entra a su flota con el diálogo de
        // agregar recurso ya abierto.
        //
        // Se navega DESPUÉS de crear, y por eso los recursos no se retienen en
        // este formulario: cada uno se guarda contra un punto que ya existe.
        // Reteniéndolos habría que crear el punto y luego N recursos, y decidir
        // qué hacer cuando el punto entra y el tercer recurso no.
        const creado = await createResourcePoint(payload);
        notify.success("Punto guardado", `Ahora agrega los recursos de "${payload.name}".`);
        onPuntosCambiaron();
        nuevoPunto();
        navigate({
          to: "/planificacion/recursos/$pointId",
          params: { pointId: creado.id },
          search: { agregar: true },
        });
        return;
      }
      await refreshPoints();
      // La anfitriona tiene SUS puntos: los marcadores del mapa y las filas de
      // la tabla de abajo. Sin avisarle, el punto recién creado no aparecía en
      // ninguno de los dos hasta recargar la página.
      onPuntosCambiaron();
      nuevoPunto();
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
      onPuntosCambiaron();
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
      // El mapa escucha siempre: con el formulario abierto desde el principio,
      // un clic ubica o recoloca el punto, y con una ficha abierta la cierra.
      onMapClick: handleMapClick,
      focusPoint: selectedPoint ? [selectedPoint.lat, selectedPoint.lng] : geocodeFlyTarget,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pendingPoint, selectedPoint, geocodeFlyTarget]);

  /** ¿El formulario está en blanco? Decide si un clic en un marcador puede
   *  tomarse el panel. Ahora que el formulario está abierto desde el principio,
   *  sin esta pregunta un clic en el mapa borraría un punto a medio escribir. */
  const formularioVacio = !editingId && !pendingPoint && !form.name.trim();

  // Un clic en un marcador del mapa lo recibe la anfitriona, que avisa acá.
  useEffect(() => {
    if (!puntoSeleccionadoId) return;
    const encontrado = points.find((p) => p.id === puntoSeleccionadoId);
    // Sin encontrar todavía: los puntos aún no llegaron. La intención se guarda
    // para el render en que sí estén, en vez de perderse acá.
    if (!encontrado) return;
    onIntencionAtendida?.();
    if (!formularioVacio) return;
    setSelectedPoint(encontrado);
    setMode("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puntoSeleccionadoId, points]);

  // El modo "idle" existe solo mientras haya una ficha que mostrar. Si el punto
  // abierto desaparece (lo borró este mismo panel, o la papelera de la tabla de
  // abajo), refreshPoints deja selectedPoint en null y el panel se quedaría sin
  // nada que dibujar: antes ahí abajo estaba el botón "Definir punto" tapando el
  // hueco. Ahora se vuelve al formulario, que es el estado normal.
  useEffect(() => {
    if (mode === "idle" && !selectedPoint) nuevoPunto();
  }, [mode, selectedPoint]);

  // El lápiz de la tabla de abajo abre el formulario directo, sin pasar por la
  // ficha de solo lectura: quien aprieta un lápiz ya decidió que va a editar.
  useEffect(() => {
    if (!puntoAEditarId) return;
    const encontrado = points.find((p) => p.id === puntoAEditarId);
    if (!encontrado) return;
    onIntencionAtendida?.();
    startEditing(encontrado);
    // onIntencionAtendida queda fuera de las dependencias a propósito: la
    // anfitriona la pasa como función anónima, así que cambia de identidad en
    // cada render y el efecto se dispararía sin parar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puntoAEditarId, points]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4">
        {mode === "idle" &&
          (selectedPoint ? (
            <div className="animate-in fade-in slide-in-from-left-2 duration-300 space-y-5">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-foreground">Punto</p>
                <button
                  type="button"
                  onClick={nuevoPunto}
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
                <label className="text-xs font-medium text-muted-foreground">
                  Nombre del punto
                </label>
                <Input value={selectedPoint.name} disabled className="disabled:cursor-default" />
              </div>

              <div className="flex items-center justify-between rounded-lg bg-background/40 p-3">
                <span className="text-xs font-medium text-foreground">Punto activo</span>
                <Switch
                  checked={selectedPoint.active}
                  disabled
                  className="disabled:cursor-default disabled:opacity-100"
                />
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
            </div>
          ) : null)}

        {/* El modo "listing" ya no existe. Era una segunda lista de los
                mismos puntos dentro de un panel angosto, y la de abajo los
                muestra con sus cifras. Para editar uno se hace clic en su
                marcador del mapa o en el lápiz de esa tabla. */}

        {mode === "configuring" && (
          <div className="animate-in fade-in slide-in-from-left-2 duration-300 space-y-5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">
                {editingId ? "Editar punto" : "Nuevo punto"}
              </p>
              {/* La leyenda del asterisco. Sin ella el símbolo es una
                  convención que hay que dar por sabida. */}
              <p className="text-[0.625rem] text-muted-foreground">
                <span className="text-destructive-strong">*</span> obligatorio
              </p>
            </div>

            {/* La ubicación es un campo más, con su estado a la vista. Antes
                    era un paso previo: se apretaba "Definir punto", se clickeaba
                    el mapa y recién ahí aparecía el formulario. Acá se dice qué
                    falta, en vez de esconder el formulario hasta que no falte. */}
            <div
              className={`flex items-start gap-2.5 rounded-lg border p-3 ${
                pendingPoint ? "border-border bg-background/40" : "border-primary/30 bg-primary/5"
              }`}
            >
              <MapPin
                className={`mt-0.5 h-4 w-4 flex-shrink-0 ${
                  pendingPoint ? "text-muted-foreground" : "text-primary"
                }`}
              />
              <span className="text-[0.6875rem] leading-relaxed">
                {pendingPoint ? (
                  <>
                    <span className="block font-medium text-foreground">Ubicación marcada</span>
                    <span className="block text-muted-foreground">
                      Para moverla, marca otro lugar en el mapa. Para más precisión, escribe la
                      dirección en el campo de abajo.
                    </span>
                  </>
                ) : (
                  <>
                    <span className="block font-medium text-foreground">Falta ubicar el punto</span>
                    <span className="block text-muted-foreground">
                      Márcalo en el mapa, o escribe la dirección en el campo de abajo si necesitas
                      más precisión.
                    </span>
                  </>
                )}
              </span>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="point-name" className="text-xs font-medium text-muted-foreground">
                Nombre del punto <Obligatorio />
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
                <label
                  htmlFor="point-address"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Dirección <Obligatorio />
                </label>
                {(geocodingAddress || eligiendoSugerencia) && (
                  <span className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Buscando dirección…
                  </span>
                )}
              </div>
              {/* El campo y su lista de sugerencias, en un contenedor relativo
                  para que la lista flote encima del formulario en vez de
                  empujar los campos de abajo cada vez que alguien escribe. */}
              <div className="relative">
                <Input
                  id="point-address"
                  placeholder="Ej: Av. Pajaritos 1234"
                  value={form.address}
                  autoComplete="off"
                  onChange={(e) => {
                    addressDirtyRef.current = true;
                    setForm((f) => ({ ...f, address: e.target.value }));
                  }}
                  onBlur={ensureAddressGeocoded}
                />
                {sugerencias.length > 0 && (
                  // onMouseDown con preventDefault y NO onClick: el clic sobre
                  // la lista dispararía antes el onBlur del campo, que
                  // geocodificaría el texto a medio escribir y gastaría una
                  // solicitud para un resultado que la sugerencia ya trae. Al
                  // frenar el mousedown, el campo no pierde el foco.
                  <ul
                    onMouseDown={(e) => e.preventDefault()}
                    className="panel absolute top-full right-0 left-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-card py-1"
                  >
                    {sugerencias.map((s) => (
                      <li key={s.placeId}>
                        <button
                          type="button"
                          onClick={() => elegirSugerencia(s)}
                          className="block w-full cursor-pointer px-3 py-2 text-left text-xs leading-snug text-foreground hover:bg-muted"
                        >
                          {s.texto}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {geocodeNotFound && (
                <p className="text-[0.625rem] text-muted-foreground">
                  No se encontró esta dirección en el mapa, el punto no se movió.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="point-comuna" className="text-xs font-medium text-muted-foreground">
                Comuna <Obligatorio />
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
                camiones, y también el personal del punto. Ya no queda ninguno.

                La maquinaria se fue con HDU8: son recursos individuales, con su
                patente, y mantener además los contadores dejaba dos formas de
                declarar lo mismo sin manera de saber cuál manda.

                El personal se va ahora, y por una razón distinta: la pregunta
                no es cuánta gente TIENE el punto, es quién va en cada tramo de
                la ruta, que es lo que pide HDU5.1. Un número suelto en el punto
                no contesta eso y, puesto acá, se lee como si sí lo contestara.
                El campo sigue existiendo en el backend y su valor se conserva
                al editar (ver handleSave), así que nada de lo ya guardado se
                pierde mientras se decide dónde va de verdad. */}

            {/* "Cancelar" solo cuando hay algo que cancelar. Con el
                    formulario siempre abierto y en blanco, cancelar no tiene
                    qué deshacer y queda como un botón que no hace nada. */}
            <div className="flex gap-2 pt-2">
              {!formularioVacio && (
                <Button variant="ghost" onClick={nuevoPunto} className="flex-1" disabled={saving}>
                  {editingId ? "Cancelar" : "Limpiar"}
                </Button>
              )}
              <Button
                onClick={handleSave}
                className="flex-1"
                disabled={saving || loQueFalta() !== null}
                title={loQueFalta() ?? undefined}
              >
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

/** El asterisco de campo obligatorio. Lleva su propio texto para lectores de
 *  pantalla: el símbolo solo no se anuncia. */
function Obligatorio() {
  return (
    <span className="text-destructive-strong" title="Campo obligatorio">
      *<span className="sr-only"> (obligatorio)</span>
    </span>
  );
}
