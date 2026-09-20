// =============================================================================
// CONDORFINDER, VISTA PREVIA DEL INFORME (HDU9)
// Archivo: src/components/ReportPreview.tsx
//
// Muestra el PDF antes de descargarlo, para saber qué se está guardando. El
// documento se construye UNA vez (buildVolumeReport) y el mismo objeto sirve
// para la vista previa y para la descarga: así es imposible que lo que se ve
// difiera de lo que se guarda.
//
// El envoltorio imita a un visor de documentos (Outlook, Drive): fondo oscuro,
// una barra propia arriba con el nombre del archivo y sus acciones, y la página
// centrada debajo. La barra del visor nativo del navegador se oculta con
// `#toolbar=0`; si no, quedaban dos barras de herramientas, una encima de la
// otra, ofreciendo lo mismo.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { Printer } from "lucide-react";
import { Download, FileText, Loader2 } from "@/components/icons/Icons";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
  const [filename, setFilename] = useState("informe.pdf");
  const [error, setError] = useState<string | null>(null);
  const marco = useRef<HTMLIFrameElement>(null);

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
        setFilename(doc.filename);
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

  // El blob es del mismo origen, así que se puede mandar a imprimir el
  // documento incrustado. Si el navegador lo impide (cada uno incrusta el PDF a
  // su manera), se abre en una pestaña para imprimir desde ahí, en vez de dejar
  // un botón que no hace nada.
  const imprimir = () => {
    try {
      const ventana = marco.current?.contentWindow;
      if (!ventana) throw new Error("sin marco");
      ventana.focus();
      ventana.print();
    } catch {
      if (url) window.open(url, "_blank", "noopener");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* text-neutral-200 en el contenedor: la X de cierre que trae
          DialogContent hereda el color del texto, y sobre este fondo oscuro el
          navy del tema la dejaba invisible. */}
      <DialogContent className="flex h-[92vh] max-h-[92vh] flex-col gap-0 overflow-hidden border-0 bg-neutral-900 p-0 text-neutral-200 sm:max-w-6xl">
        <DialogTitle className="sr-only">Vista previa del informe</DialogTitle>

        {/* pr-12 deja libre la esquina donde vive la X del diálogo. */}
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-white/10 px-3 py-2 pr-12">
          <FileText className="h-4 w-4 flex-shrink-0 text-neutral-400" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{filename}</span>

          <AccionVisor
            icon={<Download className="h-4 w-4" />}
            disabled={!saveDoc}
            onClick={() => {
              saveDoc?.();
              notify.success("Informe descargado");
            }}
          >
            Descargar
          </AccionVisor>

          <AccionVisor icon={<Printer className="h-4 w-4" />} disabled={!url} onClick={imprimir}>
            Imprimir
          </AccionVisor>
        </div>

        <div className="min-h-0 flex-1 bg-neutral-800">
          {error ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-400">
              {error}
            </div>
          ) : url ? (
            // toolbar=0 oculta la barra del visor nativo (la de arriba es la
            // nuestra); view=FitH encuadra el ancho, así la primera plana entra
            // entera en vez de abrirse al zoom que recuerde el visor.
            <iframe
              ref={marco}
              src={`${url}#toolbar=0&navpanes=0&view=FitH`}
              title="Vista previa del informe"
              className="h-full w-full border-0"
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Acción de la barra del visor. No usa <Button> porque sus variantes leen los
 *  tokens del tema claro y acá el fondo es oscuro. */
function AccionVisor({
  icon,
  children,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:bg-white/10 disabled:pointer-events-none disabled:opacity-40"
    >
      {icon}
      {children}
    </button>
  );
}
