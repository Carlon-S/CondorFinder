// =============================================================================
// CONDORFINDER, ALTA Y EDICIÓN DE UN PUNTO PERMANENTE (HDU14)
// Archivo: src/components/PuntoPermanenteDialog.tsx
//
// Un punto permanente ES una zona (`kind: "permanente"`), así que este
// formulario crea y edita zonas. Los criterios piden nombre, dirección y una
// imagen opcional; los otros tres campos (barrio, tipo, frecuencia) vienen de
// la planilla municipal y son lo que después deja ordenar el catálogo.
//
// **La dirección se geocodifica, no se guarda como texto suelto.** La planilla
// trae direcciones referenciales ("CAMINO LA FARFANA CON ALBERTO PEREZ") que no
// resuelven en ningún mapa; acá se escribe una real con el autocompletado y
// queda con su coordenada. Esa coordenada es lo que después permite dibujar el
// punto y meterlo en una ruta.
//
// Reusa el mismo autocompletado que `PanelPuntos`, con su antirrebote de
// 350 ms, porque Google cobra Autocomplete POR SOLICITUD y sin esperar sería
// una petición por tecla.
// =============================================================================

import { useEffect, useRef, useState } from "react";
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
import { ImageIcon, Loader2, MapPin, Trash2 } from "@/components/icons/Icons";
import { Obligatorio } from "@/components/Obligatorio";
import { notify } from "@/lib/notify";
import {
  detalleDeSugerencia,
  forwardGeocode,
  sugerirDirecciones,
  type SugerenciaDireccion,
} from "@/lib/geocoding";
import { resourcePhotoUrl, uploadResourcePhoto } from "@/lib/resources";
import {
  createZone,
  updateZone,
  FRECUENCIAS,
  TIPOS_PUNTO,
  type ZoneInput,
  type ZoneRecord,
} from "@/lib/analysisStore";

const ANTIRREBOTE_MS = 350;

/** El valor que usa el Select para "ninguno".
 *
 *  Radix no admite un `SelectItem` con valor vacío, así que el centinela viaja
 *  por la interfaz y se traduce a `null` al guardar. */
const SIN_VALOR = "__sin__";

export function PuntoPermanenteDialog({
  open,
  onOpenChange,
  punto,
  onGuardado,
}: {
  open: boolean;
  onOpenChange: (abierto: boolean) => void;
  /** `null` para crear, la zona para editar. */
  punto: ZoneRecord | null;
  onGuardado: (zona: ZoneRecord) => void;
}) {
  const [nombre, setNombre] = useState("");
  const [direccion, setDireccion] = useState("");
  const [barrio, setBarrio] = useState("");
  const [tipo, setTipo] = useState<string>(SIN_VALOR);
  const [frecuencia, setFrecuencia] = useState<string>(SIN_VALOR);
  const [foto, setFoto] = useState<string | null>(null);
  const [coord, setCoord] = useState<{ lat: number; lng: number } | null>(null);

  const [sugerencias, setSugerencias] = useState<SugerenciaDireccion[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [subiendo, setSubiendo] = useState(false);

  // Solo se piden sugerencias cuando escribió una persona. Rellenar el campo
  // desde el punto que se está editando también lo cambia, y pedir
  // sugerencias ahí sería gastar una solicitud para ofrecerle corregir una
  // dirección que el sistema acaba de cargar.
  const escribioRef = useRef(false);
  const archivoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    escribioRef.current = false;
    setSugerencias([]);
    setNombre(punto?.name ?? "");
    setDireccion(punto?.address ?? "");
    setBarrio(punto?.barrio ?? "");
    setTipo(punto?.tipo ?? SIN_VALOR);
    setFrecuencia(punto?.frecuencia ?? SIN_VALOR);
    setFoto(punto?.photoUrl ?? null);
    setCoord(punto?.lat != null && punto?.lng != null ? { lat: punto.lat, lng: punto.lng } : null);
  }, [open, punto]);

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
    const detalle = await detalleDeSugerencia(s.placeId);
    if (!detalle) return;
    setDireccion(detalle.address);
    setCoord({ lat: detalle.lat, lng: detalle.lng });
  };

  const subirImagen = async (file: File) => {
    setSubiendo(true);
    try {
      setFoto(await uploadResourcePhoto(file));
    } catch (e) {
      notify.error("No se pudo subir la imagen", (e as Error).message);
    } finally {
      setSubiendo(false);
    }
  };

  const guardar = async () => {
    const n = nombre.trim();
    if (!n) {
      notify.warning("Falta el nombre", "Un punto sin nombre no se puede reconocer en la grilla.");
      return;
    }

    setGuardando(true);
    try {
      // Si escribió la dirección a mano y nunca eligió una sugerencia, se
      // geocodifica al guardar. Sin coordenada el punto existe igual, pero no
      // se puede dibujar ni rutear, así que vale el viaje.
      let destino = coord;
      if (!destino && direccion.trim()) {
        const g = await forwardGeocode(`${direccion}, Maipú, Chile`);
        if (g) destino = { lat: g.lat, lng: g.lng };
      }

      const datos: ZoneInput = {
        name: n,
        kind: "permanente",
        address: direccion.trim() || null,
        barrio: barrio.trim() || null,
        tipo: tipo === SIN_VALOR ? null : tipo,
        frecuencia: frecuencia === SIN_VALOR ? null : frecuencia,
        photoUrl: foto,
        lat: destino?.lat ?? null,
        lng: destino?.lng ?? null,
      };

      const zona = punto ? await updateZone(punto.id, datos) : await createZone(datos);
      onGuardado(zona);
      onOpenChange(false);

      // Un punto sin coordenada se registra igual, pero no se puede dibujar en
      // ningún mapa. Vale avisarlo en el momento, no cuando alguien lo busque.
      if (datos.lat == null) {
        notify.warning(
          "Punto guardado, pero sin ubicar",
          "No se encontró esa dirección en el mapa. El punto queda registrado y se puede usar en el itinerario, pero no se dibuja hasta que tenga una ubicación.",
        );
      } else {
        notify.success(punto ? "Punto actualizado" : "Punto creado", zona.name);
      }
    } catch (e) {
      // El diálogo queda abierto con lo escrito: cerrarlo perdería el
      // formulario justo cuando hay que reintentar.
      notify.error("No se pudo guardar", (e as Error).message);
    } finally {
      setGuardando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{punto ? "Editar punto permanente" : "Crear punto permanente"}</DialogTitle>
          <DialogDescription>
            Los campos con <span className="text-destructive-strong">*</span> son obligatorios.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="pp-nombre">
              Nombre <Obligatorio />
            </Label>
            <Input
              id="pp-nombre"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="Camino La Farfana con Alberto Pérez"
            />
          </div>

          <div className="relative grid gap-1.5">
            <Label htmlFor="pp-direccion">Dirección</Label>
            <Input
              id="pp-direccion"
              value={direccion}
              onChange={(e) => {
                escribioRef.current = true;
                setDireccion(e.target.value);
                setCoord(null);
              }}
              placeholder="Av. Pajaritos 1234"
              autoComplete="off"
            />
            {sugerencias.length > 0 && (
              // onMouseDown y no onClick: un clic sobre la lista dispararía
              // antes el blur del campo, que geocodificaría el texto a medio
              // escribir y gastaría una solicitud por un resultado que la
              // sugerencia ya trae.
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
              <Label htmlFor="pp-barrio">Barrio</Label>
              <Input
                id="pp-barrio"
                value={barrio}
                onChange={(e) => setBarrio(e.target.value)}
                placeholder="La Farfana"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Tipo</Label>
              <Select value={tipo} onValueChange={setTipo}>
                <SelectTrigger>
                  <SelectValue placeholder="Sin definir" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SIN_VALOR}>Sin definir</SelectItem>
                  {TIPOS_PUNTO.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Frecuencia de atención</Label>
            <Select value={frecuencia} onValueChange={setFrecuencia}>
              <SelectTrigger>
                <SelectValue placeholder="Sin definir" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SIN_VALOR}>Sin definir</SelectItem>
                {FRECUENCIAS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label>Imagen (opcional)</Label>
            {foto ? (
              <div className="flex items-center gap-3">
                <img
                  src={resourcePhotoUrl(foto)}
                  alt=""
                  className="h-16 w-24 rounded-md border border-border object-cover"
                />
                <Button variant="ghost" size="sm" onClick={() => setFoto(null)}>
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Quitar
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                onClick={() => archivoRef.current?.click()}
                disabled={subiendo}
                className="justify-start"
              >
                {subiendo ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ImageIcon className="mr-2 h-4 w-4" />
                )}
                Subir una foto del lugar
              </Button>
            )}
            <input
              ref={archivoRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void subirImagen(f);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={guardando}>
            Cancelar
          </Button>
          <Button onClick={guardar} disabled={guardando || subiendo}>
            {guardando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {punto ? "Guardar cambios" : "Crear punto"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
