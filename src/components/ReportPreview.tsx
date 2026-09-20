// =============================================================================
// CONDORFINDER, VISTA PREVIA DEL INFORME (HDU9)
// Archivo: src/components/ReportPreview.tsx
//
// Muestra el PDF antes de descargarlo, para saber qué se está guardando. El
// documento se construye UNA vez (buildVolumeReport) y el mismo objeto sirve
// para la vista previa y para la descarga: así es imposible que lo que se ve
// difiera de lo que se guarda.
// =============================================================================

import { useEffect, useState } from "react";
import { Loader2 } from "@/components/icons/Icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { notify } from "@/lib/notify";
import type { ReportSelection } from "@/lib/pdfReport";

export function ReportPreview({
  selections,
  open,
  onOpenChange,
}: {
  /** Zonas a incluir. null mientras no hay nada que previsualizar. */
  selections: ReportSelection[] | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [saveDoc, setSaveDoc] = useState<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !selections || selections.length === 0) return;

    let cancelado = false;
    let creada: string | null = null;

    (async () => {
      setUrl(null);
      setError(null);
      try {
        // Carga diferida, igual que en el resto del proyecto: jspdf pesa cerca
        // de 400 kB y solo hace falta cuando alguien pide un informe.
        const { buildVolumeReport } = await import("@/lib/pdfReport");
        const doc = await buildVolumeReport(selections);
        if (cancelado) return;
        creada = doc.blobUrl();
        setUrl(creada);
        // Envuelto en una función porque setState interpreta una función como
        // actualizador y llamaría a save() en vez de guardarla.
        setSaveDoc(() => doc.save);
      } catch {
        if (!cancelado) setError("No se pudo generar el informe. Intenta nuevamente.");
      }
    })();

    return () => {
      cancelado = true;
      // Sin esto cada apertura deja un blob retenido mientras viva la pestaña.
      if (creada) URL.revokeObjectURL(creada);
    };
  }, [open, selections]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Vista previa del informe</DialogTitle>
          <DialogDescription>
            Así queda el documento. Revísalo antes de descargarlo.
          </DialogDescription>
        </DialogHeader>

        <div className="h-[30rem] overflow-hidden rounded-lg border border-border bg-muted/30">
          {error ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
              {error}
            </div>
          ) : url ? (
            <iframe src={url} title="Vista previa del informe" className="h-full w-full border-0" />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cerrar
          </Button>
          <Button
            disabled={!saveDoc}
            onClick={() => {
              saveDoc?.();
              notify.success("Informe descargado");
              onOpenChange(false);
            }}
          >
            Descargar PDF
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
