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
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
      {/* Solo el visor, sin encabezado ni barra de acciones propias.
          El visor de PDF del navegador ya trae su botón de descarga, de
          impresión y su control de zoom; duplicarlos abajo repetía la misma
          acción dos veces y le robaba alto a lo único que importa acá, que es
          ver la primera plana completa. El diálogo aporta su propia X para
          cerrar (ver dialog.tsx). */}
      <DialogContent className="flex h-[90vh] max-h-[90vh] flex-col gap-0 overflow-hidden p-2 sm:max-w-5xl">
        {/* Radix exige un título para lectores de pantalla; visualmente sobra,
            así que va oculto en vez de ocupar una franja del diálogo. */}
        <DialogTitle className="sr-only">Vista previa del informe</DialogTitle>

        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-muted/30">
          {error ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
              {error}
            </div>
          ) : url ? (
            // #view=FitH encuadra el ancho de la página, así la primera plana
            // entra entera en vez de abrirse al zoom que recuerde el visor.
            <iframe
              src={`${url}#view=FitH`}
              title="Vista previa del informe"
              className="h-full w-full border-0"
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
