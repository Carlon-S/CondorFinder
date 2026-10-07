// =============================================================================
// CONDORFINDER, RENOMBRAR
// Archivo: src/components/RenameDialog.tsx
//
// Un solo diálogo para los dos renombrados que existen, y son dos cosas
// distintas:
//
//   - la ZONA, que es el terreno y persiste entre vuelos ("Avenida Las
//     Industrias");
//   - una VERSIÓN, que es una medición con su fecha ("Medición 26-05-2026").
//
// El sistema los confundía: al guardar se pedía un nombre, ese nombre quedaba en
// el análisis y `_resolve_zone()` lo copiaba a la zona recién creada, así que
// una zona terminaba llamándose como su primera medición y no había forma de
// corregirlo. Los endpoints para arreglarlo existían desde antes y ninguna
// pantalla los llamaba.
//
// Es un componente compartido y no dos diálogos porque son el mismo gesto sobre
// cosas distintas. Con una copia por vista, la validación (recortar, rechazar
// vacío, no guardar si no cambió) se escribe dos veces y divergen a la primera
// corrección.
// =============================================================================

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "@/components/icons/Icons";
import { notify } from "@/lib/notify";

export function RenameDialog({
  open,
  onOpenChange,
  titulo,
  descripcion,
  etiqueta,
  valorInicial,
  onGuardar,
}: {
  open: boolean;
  onOpenChange: (abierto: boolean) => void;
  titulo: string;
  descripcion: string;
  /** Lo que rotula el campo: "Nombre de la zona", "Nombre de la versión". */
  etiqueta: string;
  valorInicial: string;
  /** Hace el PUT/PATCH y refresca lo que haga falta. Si lanza, el diálogo queda
   *  abierto con el texto escrito: cerrarlo perdería lo que la persona tipeó
   *  justo cuando hay que reintentar. */
  onGuardar: (nombre: string) => Promise<void>;
}) {
  const [nombre, setNombre] = useState(valorInicial);
  const [guardando, setGuardando] = useState(false);

  // El valor se resiembra al ABRIR, no en cada render: durante el tipeo el
  // padre sigue teniendo el nombre viejo, así que sincronizar siempre pisaría
  // cada tecla.
  useEffect(() => {
    if (open) setNombre(valorInicial);
  }, [open, valorInicial]);

  const limpio = nombre.trim();
  const puedeGuardar = limpio.length > 0 && limpio !== valorInicial.trim() && !guardando;

  const guardar = async () => {
    if (!puedeGuardar) return;
    setGuardando(true);
    try {
      await onGuardar(limpio);
      onOpenChange(false);
    } catch (err) {
      notify.error(
        "No se pudo renombrar",
        err instanceof Error ? err.message : "Intenta nuevamente.",
      );
    } finally {
      setGuardando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !guardando && onOpenChange(v)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{titulo}</DialogTitle>
          <DialogDescription>{descripcion}</DialogDescription>
        </DialogHeader>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-foreground">{etiqueta}</span>
          <Input
            autoFocus
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            // Enter guarda. Es un formulario de un campo: obligar a bajar al
            // botón para confirmar una palabra es trabajo de más.
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                guardar();
              }
            }}
            disabled={guardando}
          />
        </label>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={guardando}>
            Cancelar
          </Button>
          <Button onClick={guardar} disabled={!puedeGuardar}>
            {guardando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
