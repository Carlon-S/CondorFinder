// =============================================================================
// CONDORFINDER, VISOR DE UNA ZONA
// Archivo: src/components/ZoneZoomDialog.tsx
//
// El mapa unificado real de una zona con sus basurales dibujados encima, sus
// tres totales y el detalle por detección.
//
// Vive acá y no dentro de /rutas porque lo abren DOS vistas: el círculo de una
// zona en el mapa de rutas y el de la misma zona en el mapa de recursos. Con una
// copia por vista, el visor de recursos nació como una versión pobre (la imagen
// y dos cifras, sin recuadros de detección ni el detalle por tipo), que es
// exactamente la divergencia que un componente compartido evita: la pregunta
// "cuál es esta zona y qué hay en ella" se responde igual desde las dos.
//
// El tamaño natural de la imagen se mide acá, con `onLoad`, y no lo recibe de
// afuera: los recuadros se posicionan sobre los píxeles de la imagen, así que el
// `viewBox` del SVG tiene que ser esa medición y no una estimación. Mientras no
// está, la imagen se mantiene oculta y se muestra un cargador, porque un PNG
// grande apareciendo de arriba hacia abajo antes que su overlay se lee como si
// el mapa estuviera roto.
// =============================================================================

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Boxes,
  Crosshair,
  Loader2,
  Map as MapIcon,
  MapPin,
  Scale,
  TriangleAlert,
} from "@/components/icons/Icons";
import { classColor } from "@/components/zone-colors";

/** Una detección ya lista para dibujar: su recuadro en píxeles de la imagen y
 *  sus tres magnitudes. */
export interface ZoneZoomDetection {
  id: number | string;
  wasteClass: string;
  volumeM3: number | null;
  weightKg: number | null;
  areaM2: number | null;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
}

export interface ZoneZoomData {
  id: string;
  /** El nombre de la ZONA, que es el terreno. */
  name: string;
  mapUrl: string;
  detections: ZoneZoomDetection[];
  summary: { totalVolumeM3: number; totalWeightKg: number; totalAreaM2: number };
  /** true si el análisis original tenía detecciones que no se pudieron ubicar.
   *  Solo lo sabe /rutas, que las reproyecta; /recursos manda false. */
  partial?: boolean;
}

export function ZoneZoomDialog({
  zona,
  onOpenChange,
  direccion,
  insignia,
  onVerAnalisis,
}: {
  /** La zona abierta, o null con el diálogo cerrado. */
  zona: ZoneZoomData | null;
  onOpenChange: (abierto: boolean) => void;
  /** Dirección resuelta por geocodificación inversa, si la hay. Es el dato que
   *  permite reconocer la zona en terreno, que el nombre no da. */
  direccion?: string;
  /** Etiqueta de estado junto al título. La usa /rutas para decir si la zona
   *  está en la ruta; /recursos no tiene ningún estado que mostrar. */
  insignia?: { texto: string; activa: boolean };
  /** Ir a la vista de análisis de esta zona. Sin esto la imagen no es un botón:
   *  un control que no hace nada es peor que ninguno. */
  onVerAnalisis?: (id: string) => void;
}) {
  const [tamano, setTamano] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState(false);

  // Se reinicia al cambiar de zona: el tamaño medido es de la imagen anterior y
  // con él los recuadros caerían en el lugar equivocado por un frame.
  useEffect(() => {
    setTamano(null);
    setError(false);
  }, [zona?.id]);

  return (
    <Dialog open={zona !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>{zona?.name}</DialogTitle>
            {insignia && (
              <span
                className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${
                  insignia.activa ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                }`}
              >
                {insignia.texto}
              </span>
            )}
          </div>
          <DialogDescription>
            {direccion ? (
              <span className="flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 flex-shrink-0 text-primary/70" />
                {direccion}
              </span>
            ) : (
              "Mapa unificado real de esta zona, con los basurales detectados."
            )}
          </DialogDescription>
        </DialogHeader>

        {zona && (
          // Dos columnas parejas (imagen | información) para que el diálogo
          // quede cerca de un cuadrado en vez de una franja angosta y muy alta.
          <div className="grid grid-cols-2 gap-4">
            {/* group y detect-frame en ESTE contenedor, no en el <img> ni en el
                <button>: la etiqueta de hover tiene que pintar por encima del
                <svg> de recuadros, que en el DOM viene después, y así queda
                arriba por orden de pintado sin depender de z-index. Las esquinas
                decorativas, además, se recortarían contra el rounded-md de la
                imagen. */}
            <div className="group relative detect-frame">
              <span className="detect-corners" aria-hidden="true" />
              {error ? (
                <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/50 bg-muted/30 p-6 text-center">
                  <TriangleAlert className="h-6 w-6 flex-shrink-0 text-warning" />
                  <p className="text-xs text-muted-foreground">
                    No se pudo cargar el mapa de esta zona, puede que se haya eliminado desde otra
                    pestaña o sesión.
                  </p>
                </div>
              ) : (
                <>
                  {!tamano && (
                    <div className="flex aspect-square w-full items-center justify-center rounded-md border border-border/40 bg-muted/20">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  )}
                  {/* Un <button> real y no un <img> con onClick, para que el
                      cursor y el hover los garantice un control nativo. Cuando
                      no hay a dónde ir, es un <div>. */}
                  {onVerAnalisis ? (
                    <button
                      type="button"
                      onClick={() => onVerAnalisis(zona.id)}
                      className={`block w-full cursor-pointer ${tamano ? "" : "hidden"}`}
                      title="Ver análisis de esta zona"
                    >
                      <ImagenDeLaZona zona={zona} onMedida={setTamano} onError={setError} />
                    </button>
                  ) : (
                    <div className={tamano ? "" : "hidden"}>
                      <ImagenDeLaZona zona={zona} onMedida={setTamano} onError={setError} />
                    </div>
                  )}
                </>
              )}

              {!error && tamano && (
                <svg
                  viewBox={`0 0 ${tamano.w} ${tamano.h}`}
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  preserveAspectRatio="xMidYMid meet"
                >
                  {zona.detections.map((d) => {
                    const color = classColor(d.wasteClass);
                    return (
                      <g key={d.id}>
                        <rect
                          x={d.bbox.minx}
                          y={d.bbox.miny}
                          width={d.bbox.maxx - d.bbox.minx}
                          height={d.bbox.maxy - d.bbox.miny}
                          fill={color}
                          fillOpacity={0.35}
                          stroke={color}
                          strokeWidth={Math.max(2, tamano.w / 400)}
                          strokeLinejoin="round"
                        />
                        <text
                          x={d.bbox.minx}
                          y={d.bbox.miny - tamano.w / 200}
                          fontSize={Math.max(20, tamano.w / 60)}
                          fill={color}
                          fontFamily="monospace"
                          fontWeight="700"
                          paintOrder="stroke"
                          stroke="rgba(0,0,0,0.75)"
                          strokeWidth={tamano.w / 300}
                          strokeLinejoin="round"
                        >
                          {d.wasteClass}
                          {d.volumeM3 ? ` — ${d.volumeM3} m³` : ""}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              )}

              {!error && tamano && onVerAnalisis && (
                // Último hijo, así pinta sobre el <svg> sin z-index.
                // pointer-events-none para no robarle el clic al botón.
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
                  <div className="flex items-center gap-2 rounded-md bg-background/85 px-4 py-2 shadow-xl backdrop-blur">
                    <MapIcon className="h-4 w-4 text-primary" />
                    <span className="text-sm font-semibold text-foreground">
                      Ver análisis de detección
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="flex min-h-0 flex-col gap-3">
              {zona.partial && (
                <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-[0.625rem] text-muted-foreground">
                  <TriangleAlert className="h-3.5 w-3.5 flex-shrink-0 text-warning" />
                  <span>
                    Algunas zonas de este análisis no se pudieron ubicar en el mapa y no aparecen
                    abajo.
                  </span>
                </div>
              )}

              <div className="space-y-1.5">
                <Total
                  icono={<Boxes className="h-4 w-4 flex-shrink-0 text-primary/70" />}
                  etiqueta="Volumen total"
                  valor={`${zona.summary.totalVolumeM3} m³`}
                />
                <Total
                  icono={<Scale className="h-4 w-4 flex-shrink-0 text-primary/70" />}
                  etiqueta="Peso total"
                  valor={`${zona.summary.totalWeightKg} kg`}
                />
                <Total
                  icono={<Crosshair className="h-4 w-4 flex-shrink-0 text-primary/70" />}
                  etiqueta="Área total"
                  valor={`${zona.summary.totalAreaM2} m²`}
                />
              </div>

              {/* max-h fijo y no flex-1: las filas de una grilla se ajustan a su
                  contenido, así que un flex-1 no tenía contra qué resolver y con
                  muchos tipos el scroll pasaba al diálogo completo, imagen
                  incluida, en vez de quedar en esta lista. */}
              <div className="flex flex-col">
                <p className="mb-2 text-xs font-semibold text-muted-foreground">Zonas detectadas</p>
                <ul className="max-h-[17.5rem] space-y-1.5 overflow-y-auto pr-0.5">
                  {zona.detections.map((d) => (
                    <li
                      key={d.id}
                      className="rounded-md border border-border/60 bg-background/60 p-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: classColor(d.wasteClass) }}
                        />
                        <span className="min-w-0 flex-1 truncate font-medium">{d.wasteClass}</span>
                      </div>
                      <p className="mt-1 pl-4.5 text-muted-foreground">
                        {d.volumeM3 != null ? `${d.volumeM3} m³` : "—"}
                        {" · "}
                        {d.weightKg != null ? `${d.weightKg} kg` : "—"}
                        {" · "}
                        {d.areaM2 != null ? `${d.areaM2} m²` : "—"}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ImagenDeLaZona({
  zona,
  onMedida,
  onError,
}: {
  zona: ZoneZoomData;
  onMedida: (t: { w: number; h: number }) => void;
  onError: (v: boolean) => void;
}) {
  return (
    <img
      src={zona.mapUrl}
      alt={`Mapa unificado de ${zona.name}`}
      className="w-full rounded-md transition-opacity group-hover:opacity-80"
      decoding="async"
      onLoad={(e) => {
        const img = e.currentTarget;
        onMedida({ w: img.naturalWidth, h: img.naturalHeight });
      }}
      onError={() => onError(true)}
    />
  );
}

function Total({
  icono,
  etiqueta,
  valor,
}: {
  icono: React.ReactNode;
  etiqueta: string;
  valor: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-md bg-background/40 p-2.5">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {icono} {etiqueta}
      </span>
      <span className="text-sm font-semibold">{valor}</span>
    </div>
  );
}
