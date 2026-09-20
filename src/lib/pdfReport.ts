// =============================================================================
// CONDORFINDER, INFORME DE VOLUMEN EN PDF (HDU9)
// Archivo: src/lib/pdfReport.ts
//
// El PDF se arma en el navegador, no en el servidor. El frontend corre en
// Cloudflare Workers, que escala solo en el borde; el backend es UNA máquina
// virtual que además corre la fotogrametría sobre una carpeta de trabajo
// compartida que ya obliga a procesar de a una tarea. Sumarle generación de
// documentos a ese cuello de botella sería ir en contra. Además, cada ajuste
// de formato del lado del servidor exigiría un despliegue manual por SSH.
//
// jspdf y jspdf-autotable NO se importan en el tope de este módulo: se cargan
// con await import() dentro de generateVolumeReport(), que solo corre al
// presionar el botón. Dos motivos: no engordar el bundle de quien nunca genera
// un informe, y que el import no se ejecute durante el renderizado en servidor
// del Worker.
// =============================================================================

import type { SavedAnalysisRecord, ZoneRecord } from "@/lib/analysisStore";
import { buildVersions, volumeByWasteType, zoneTotals } from "@/lib/volumeReport";

/** Un análisis elegido para el informe, junto a la zona a la que pertenece. */
export interface ReportSelection {
  zone: ZoneRecord;
  analyses: SavedAnalysisRecord[];
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "sin fecha";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "sin fecha" : d.toLocaleDateString("es-CL");
}

function num(n: number): string {
  return n.toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Nombre del archivo, fechado el día de emisión. */
export function reportFilename(): string {
  return `informe-volumen-${new Date().toISOString().slice(0, 10)}.pdf`;
}

/**
 * Arma el documento y lo devuelve sin guardarlo.
 *
 * Está separado de la descarga para que la vista previa muestre exactamente el
 * mismo documento que se va a guardar, sin construirlo dos veces ni arriesgar
 * que lo previsualizado y lo descargado difieran.
 *
 * Devuelve también una función para producir la URL del objeto, porque quien la
 * crea tiene que liberarla después (ver ReportPreview).
 */
export async function buildVolumeReport(selections: ReportSelection[]): Promise<{
  blobUrl: () => string;
  save: () => void;
}> {
  const doc = await renderReport(selections);
  return {
    blobUrl: () => doc.output("bloburl") as unknown as string,
    save: () => doc.save(reportFilename()),
  };
}

/**
 * Genera el informe y lo descarga directo, sin vista previa.
 *
 * Devuelve el nombre del archivo, o lanza si algo falla, quien llama decide
 * cómo avisar (toast), igual que hace el resto de src/lib.
 */
export async function generateVolumeReport(selections: ReportSelection[]): Promise<string> {
  const doc = await renderReport(selections);
  const filename = reportFilename();
  doc.save(filename);
  return filename;
}

/** Todo el dibujo del documento. Lo comparten la descarga directa y la vista
 *  previa, así que cualquier cambio de formato se hace en un solo lugar. */
async function renderReport(selections: ReportSelection[]) {
  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margin = 40;
  let y = margin;

  const totalAnalisis = selections.reduce((s, sel) => s + sel.analyses.length, 0);
  const totalVolumen = selections.reduce(
    (s, sel) => s + sel.analyses.reduce((t, a) => t + zoneTotals(a).volumeM3, 0),
    0,
  );

  // ── encabezado ──
  doc.setFontSize(18);
  doc.text("Informe de volumen de residuos", margin, y);
  y += 20;
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(
    `CondorFinder · Emitido el ${new Date().toLocaleDateString("es-CL")} · ` +
      `${selections.length} zona(s), ${totalAnalisis} análisis`,
    margin,
    y,
  );
  y += 26;

  doc.setTextColor(0);
  doc.setFontSize(13);
  doc.text(`Volumen total: ${num(totalVolumen)} m³`, margin, y);
  y += 18;

  // ── tabla por zona y análisis ──
  // Cada fila es un análisis con SU fecha: es lo que convierte al informe en
  // un registro en el tiempo y no en una foto del momento.
  const filas: string[][] = [];
  for (const sel of selections) {
    const versiones = buildVersions(sel.analyses);
    for (const version of versiones) {
      for (const analysis of version.analyses) {
        const t = zoneTotals(analysis);
        filas.push([
          sel.zone.name,
          formatDate(version.captureDate),
          formatDate(analysis.savedAt),
          num(t.volumeM3),
          t.weightKg.toLocaleString("es-CL"),
          num(t.areaM2),
          String(t.count),
        ]);
      }
    }
  }

  autoTable(doc, {
    startY: y,
    head: [["Zona", "Captura", "Análisis", "Volumen m³", "Peso kg", "Área m²", "Detecciones"]],
    body: filas,
    margin: { left: margin, right: margin },
    styles: { fontSize: 8, cellPadding: 4 },
    headStyles: { fillColor: [15, 34, 68], textColor: 255 },
  });

  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 26;

  // ── tabla por tipo de residuo ──
  // El reparto proporcional de volumeByWasteType() garantiza que estas partes
  // sumen exactamente el total de arriba. Ver el comentario de esa función
  // para por qué no se puede sumar el desglose crudo.
  const porTipo = new Map<string, number>();
  for (const sel of selections) {
    for (const analysis of sel.analyses) {
      for (const [tipo, valor] of volumeByWasteType(analysis)) {
        porTipo.set(tipo, (porTipo.get(tipo) ?? 0) + valor);
      }
    }
  }

  if (porTipo.size > 0) {
    doc.setFontSize(13);
    doc.text("Volumen por tipo de residuo", margin, y);
    y += 10;

    const filasTipo = [...porTipo.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tipo, valor]) => [
        tipo,
        num(valor),
        totalVolumen > 0 ? `${((valor / totalVolumen) * 100).toFixed(1)} %` : "0 %",
      ]);

    autoTable(doc, {
      startY: y,
      head: [["Tipo de residuo", "Volumen m³", "Participación"]],
      body: filasTipo,
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [15, 34, 68], textColor: 255 },
    });

    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 26;
  }

  // ── comparación entre versiones de una misma zona ──
  // Solo aparece cuando la selección incluye más de un vuelo de la misma zona,
  // que es el criterio de HDU9: comparar una versión con la que la reemplazó.
  for (const sel of selections) {
    const versiones = buildVersions(sel.analyses);
    if (versiones.length < 2) continue;

    if (y > 680) {
      doc.addPage();
      y = margin;
    }

    doc.setFontSize(13);
    doc.text(`Evolución de ${sel.zone.name}`, margin, y);
    y += 10;

    const filasComparacion: string[][] = [];
    let anterior: number | null = null;
    const algoritmos = new Set<number | null>();

    for (const version of versiones) {
      // La cifra de una versión es la de su análisis más reciente: es la
      // lectura vigente de ese vuelo.
      const ultimo = version.analyses[version.analyses.length - 1];
      const volumen = zoneTotals(ultimo).volumeM3;
      algoritmos.add(ultimo.algorithmVersion ?? null);

      const variacion =
        anterior === null
          ? ", "
          : anterior === 0
            ? "sin base"
            : `${(((volumen - anterior) / anterior) * 100).toFixed(1)} %`;

      filasComparacion.push([
        formatDate(version.captureDate),
        String(version.analyses.length),
        num(volumen),
        variacion,
      ]);
      anterior = volumen;
    }

    autoTable(doc, {
      startY: y,
      head: [["Captura", "Análisis", "Volumen m³", "Variación"]],
      body: filasComparacion,
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [15, 34, 68], textColor: 255 },
    });

    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 14;

    // Advertencia honesta: si las versiones se midieron con algoritmos
    // distintos, parte de la variación puede venir de la medición y no del
    // terreno. Un informe municipal que atribuye a una limpieza un cambio que
    // fue de precisión es peor que no informar nada.
    if (algoritmos.size > 1) {
      doc.setFontSize(8);
      doc.setTextColor(150, 90, 0);
      const aviso = doc.splitTextToSize(
        "Atención: estas versiones se midieron con distintas versiones del algoritmo de " +
          "cálculo. Parte de la variación puede deberse a mejoras en la medición y no a un " +
          "cambio real en el terreno.",
        515,
      );
      doc.text(aviso, margin, y);
      doc.setTextColor(0);
      y += aviso.length * 10 + 16;
    }
  }

  return doc;
}
