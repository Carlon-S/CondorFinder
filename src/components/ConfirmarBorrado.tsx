// =============================================================================
// CONDORFINDER, CONFIRMACIÓN DE BORRADO
// Archivo: src/components/ConfirmarBorrado.tsx
//
// Un solo diálogo para los borrados que no tenían ninguno: un punto diario,
// un punto permanente y un tipo de solicitud. Los tres eliminan algo que
// alguien escribió a mano y ninguno se puede deshacer.
//
// Compartido y no uno por vista porque son el mismo gesto, y con una copia por
// lugar el texto, el color del botón y el estado de carga divergen a la
// primera corrección. Es el mismo criterio que `RenameDialog`.
//
// El botón de confirmar es `destructive` y NO es el que tiene el foco al
// abrir: con el foco puesto ahí, un Enter de más borra. Cancelar es el
// camino seguro y por eso es el que lo recibe.
// =============================================================================

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "@/components/icons/Icons";

export function ConfirmarBorrado({
  abierto,
  onOpenChange,
  titulo,
  descripcion,
  etiquetaConfirmar = "Eliminar",
  onConfirmar,
}: {
  abierto: boolean;
  onOpenChange: (abierto: boolean) => void;
  titulo: string;
  /** Qué se va a eliminar, con su nombre. Sin el nombre, quien abre el diálogo
   *  por error no tiene cómo darse cuenta de cuál apretó.
   *
   *  Acepta nodos y no solo texto porque algunas confirmaciones necesitan
   *  mostrar un desglose de lo que está en juego, no una frase. */
  descripcion: ReactNode;
  etiquetaConfirmar?: string;
  /** Hace el borrado. Si lanza, el diálogo queda abierto: cerrarlo escondería
   *  el motivo justo cuando hay que leerlo. */
  onConfirmar: () => Promise<void>;
}) {
  const [borrando, setBorrando] = useState(false);

  const confirmar = async () => {
    setBorrando(true);
    try {
      await onConfirmar();
      onOpenChange(false);
    } finally {
      setBorrando(false);
    }
  };

  return (
    <Dialog open={abierto} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{titulo}</DialogTitle>
          <DialogDescription>{descripcion}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={borrando} autoFocus>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={confirmar} disabled={borrando}>
            {borrando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {etiquetaConfirmar}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
