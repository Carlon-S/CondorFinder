// =============================================================================
// CONDORFINDER, CIERRE DEL RETIRO (pieza 2.4)
// Archivo: src/components/CerrarRutaDialog.tsx
//
// Al terminar una ruta, la cuadrilla confirma por parada cuánto salió DE VERDAD.
//
// -----------------------------------------------------------------------------
// LO PLANIFICADO Y LO RETIRADO SON DOS CIFRAS, NO UNA
// -----------------------------------------------------------------------------
// Cada fila muestra lo que el plan iba a mover y pide lo que se movió. Que casi
// siempre coincidan no las vuelve la misma: confundirlas impediría después
// comparar lo planificado contra lo hecho, que es para lo que este registro
// existe. Es la misma distinción que la planilla municipal hace entre CANT. y
// M3 RETIRO.
//
// Por eso el campo **arranca con lo planificado** en vez de vacío: el caso
// frecuente es que coincidan, y obligar a reescribir veinte cifras iguales es
// la forma más segura de que nadie vuelva a cerrar una ruta. Quien tenga otra
// cifra la corrige.
//
// -----------------------------------------------------------------------------
// SE PUEDE CERRAR SIN ANOTAR NADA
// -----------------------------------------------------------------------------
// "Cerrar sin registrar" es un resultado válido y tiene su propio botón. Sin
// esa salida, una ruta de la que nadie tomó nota quedaría "en curso" para
// siempre, y una ruta eternamente en curso bloquea sus vehículos (pieza 2.2):
// el costo de no poder cerrar es mucho mayor que el de un cierre sin cifras.
// =============================================================================

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Loader2 } from "@/components/icons/Icons";
import { cifra } from "@/lib/formato";
import type { RoutePlanStop } from "@/lib/routePlan";
import type { RetiroDeParada } from "@/lib/routePlans";

/** Lo que el formulario tiene por parada mientras se escribe. */
interface FilaCierre {
  stopId: string;
  kind: "analysis" | "punto_diario";
  nombre: string;
  planificado: number | null;
  /** Texto y no número: es lo que el campo tiene mientras se teclea, y un "1,"
   *  a medio escribir no es un número. Se convierte al confirmar, igual que el
   *  volumen a retirar del diálogo de generación. */
  retirado: string;
  completado: boolean;
}

/** Una parada por fila, sin repetir las visitas de una misma zona.
 *
 *  **Una zona visitada tres veces se cierra UNA vez.** El plan la parte en
 *  visitas porque el convoy vuelve al relleno entre medio, pero a la cuadrilla
 *  se le pregunta cuánto sacó de ese lugar, no cuánto sacó en cada pasada:
 *  tres campos para el mismo basural obligarían a repartir a mano una cifra que
 *  se conoce entera. Lo planificado se SUMA entre las visitas por el mismo
 *  motivo. */
function filasDe(stops: RoutePlanStop[]): FilaCierre[] {
  const porParada = new Map<string, FilaCierre>();
  for (const s of stops) {
    if (!s.stopId) continue;
    const clave = `${s.kind ?? "analysis"}:${s.stopId}`;
    const previa = porParada.get(clave);
    const vol = s.removedVolumeM3 ?? 0;
    if (previa) {
      previa.planificado = (previa.planificado ?? 0) + vol;
      previa.retirado = String(previa.planificado);
    } else {
      porParada.set(clave, {
        stopId: s.stopId,
        kind: (s.kind ?? "analysis") as "analysis" | "punto_diario",
        nombre: s.label,
        planificado: vol,
        retirado: String(vol),
        completado: true,
      });
    }
  }
  return Array.from(porParada.values());
}

export function CerrarRutaDialog({
  abierto,
  onOpenChange,
  stops,
  onCerrar,
}: {
  abierto: boolean;
  onOpenChange: (abierto: boolean) => void;
  stops: RoutePlanStop[];
  /** Recibe lo confirmado. Lista vacía = cerrar sin registrar. */
  onCerrar: (retiros: RetiroDeParada[]) => Promise<void>;
}) {
  const [filas, setFilas] = useState<FilaCierre[]>([]);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (abierto) setFilas(filasDe(stops));
  }, [abierto, stops]);

  const confirmar = async (conCifras: boolean) => {
    setGuardando(true);
    try {
      await onCerrar(
        conCifras
          ? filas.map((f) => {
              const bruto = f.retirado.trim().replace(",", ".");
              const n = Number(bruto);
              return {
                stopId: f.stopId,
                kind: f.kind,
                // Vacío o no numérico se manda como `null`, que significa "no
                // se midió". Mandarlo como 0 afirmaría que el camión se fue
                // sin cargar, que es otra cosa.
                retiradoM3: bruto === "" || !Number.isFinite(n) ? null : n,
                completado: f.completado,
              };
            })
          : [],
      );
      onOpenChange(false);
    } finally {
      setGuardando(false);
    }
  };

  const actualizar = (i: number, cambios: Partial<FilaCierre>) =>
    setFilas((prev) => prev.map((f, j) => (j === i ? { ...f, ...cambios } : f)));

  return (
    <Dialog open={abierto} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Cerrar la ruta</DialogTitle>
          <DialogDescription>
            Confirma cuánto salió de cada parada. Lo que anotes acá es el retiro real, y queda en el
            historial de volumen de cada lugar.
          </DialogDescription>
        </DialogHeader>

        {filas.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/50 py-6 text-center text-xs text-muted-foreground">
            Esta ruta no tiene paradas que registrar.
          </p>
        ) : (
          <ul className="min-w-0 space-y-1.5">
            {filas.map((f, i) => (
              <li
                key={`${f.kind}:${f.stopId}`}
                className="flex items-center gap-2 rounded-md border border-border/60 p-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground">{f.nombre}</p>
                  <p className="text-[0.625rem] text-muted-foreground">
                    {f.kind === "punto_diario" ? "Retiro del día" : "Punto permanente"}
                    {f.planificado != null && ` · se planificó ${cifra(f.planificado)} m³`}
                  </p>
                </div>

                {/* "Completo" y no "pendiente": lo frecuente es que la parada se
                    haya atendido, y una casilla marcada por omisión que describe
                    lo normal se lee más rápido que una que hay que marcar
                    siempre. */}
                <label className="flex flex-shrink-0 cursor-pointer items-center gap-1.5 text-[0.625rem] text-muted-foreground">
                  <Checkbox
                    checked={f.completado}
                    onCheckedChange={(v) => actualizar(i, { completado: v === true })}
                    aria-label={`Parada ${f.nombre} atendida completa`}
                  />
                  Completo
                </label>

                <span className="flex flex-shrink-0 items-center gap-1">
                  <Input
                    value={f.retirado}
                    onChange={(e) => actualizar(i, { retirado: e.target.value })}
                    inputMode="decimal"
                    placeholder="0"
                    aria-label={`Volumen retirado de ${f.nombre}, en metros cúbicos`}
                    className="h-8 w-20 text-right text-xs"
                  />
                  <span className="mono text-[0.625rem] text-muted-foreground">m³</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          {/* La salida sin cifras, con su propio botón y no escondida. Una ruta
              que no se puede cerrar queda en curso para siempre, y una en curso
              retiene sus vehículos. */}
          <Button
            variant="ghost"
            onClick={() => void confirmar(false)}
            disabled={guardando}
            className="text-xs"
          >
            Cerrar sin registrar
          </Button>
          <span className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={guardando}>
              Cancelar
            </Button>
            <Button onClick={() => void confirmar(true)} disabled={guardando}>
              {guardando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Cerrar y registrar
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
