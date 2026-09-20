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
// con await import() dentro de renderReport(), que solo corre al abrir la vista
// previa. Dos motivos: no engordar el bundle de quien nunca genera un informe,
// y que el import no se ejecute durante el renderizado en servidor del Worker.
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

// ── gráficos ────────────────────────────────────────────────────────────────
//
// Se dibujan con las primitivas del propio jsPDF (rectángulos, líneas y texto),
// no rasterizando un gráfico de la pantalla a imagen. Tres motivos: el informe
// se puede generar desde Vista Principal sin que el gráfico esté montado en
// ninguna parte, un PDF vectorial no se pixela al imprimirlo (que es lo que va
// a pasar con un informe municipal), y no suma ni una dependencia más a un
// bundle donde recharts ya se carga aparte a propósito.

/** Paleta del documento, en el mismo azul del encabezado de las tablas. */
const AZUL: [number, number, number] = [15, 34, 68];
const GRIS_LINEA: [number, number, number] = [210, 214, 222];
const GRIS_TEXTO = 110;

/** Escala "linda" para el eje: el menor 1/2/5 x 10^n que cubre el máximo. */
function escalaEje(maximo: number): number {
  if (maximo <= 0) return 1;
  const exponente = Math.floor(Math.log10(maximo));
  const base = Math.pow(10, exponente);
  for (const paso of [1, 2, 5, 10]) {
    if (maximo <= paso * base) return paso * base;
  }
  return 10 * base;
}

/** Solo el tipo: `import type` se borra al compilar, así que jspdf sigue
 *  entrando únicamente por el await import() de renderReport. */
type Doc = import("jspdf").jsPDF;

/**
 * Barras horizontales, una por categoría, con su valor al costado.
 *
 * Horizontales y no verticales porque las etiquetas son nombres largos
 * ("Residuo de construcción"): en vertical habría que rotarlas o recortarlas.
 *
 * Devuelve el alto ocupado para que quien llama siga apilando contenido.
 */
function dibujarBarras(
  doc: Doc,
  datos: { etiqueta: string; valor: number }[],
  x: number,
  y: number,
  ancho: number,
): number {
  const ALTO_FILA = 16;
  const ANCHO_ETIQUETA = 130;
  const ANCHO_VALOR = 52;
  const anchoPista = ancho - ANCHO_ETIQUETA - ANCHO_VALOR;
  const maximo = Math.max(...datos.map((d) => d.valor), 0);
  if (maximo <= 0) return 0;

  datos.forEach((dato, i) => {
    const filaY = y + i * ALTO_FILA;

    doc.setFontSize(8);
    doc.setTextColor(0);
    // Recorta el nombre al ancho reservado en vez de dejarlo pisar la barra.
    const etiqueta = doc.splitTextToSize(dato.etiqueta, ANCHO_ETIQUETA - 6)[0];
    doc.text(etiqueta, x, filaY + 8);

    // Pista de fondo: da referencia visual del 100% aunque la barra sea corta.
    doc.setFillColor(...GRIS_LINEA);
    doc.rect(x + ANCHO_ETIQUETA, filaY + 1.5, anchoPista, 8, "F");

    doc.setFillColor(...AZUL);
    doc.rect(
      x + ANCHO_ETIQUETA,
      filaY + 1.5,
      Math.max(1, (dato.valor / maximo) * anchoPista),
      8,
      "F",
    );

    doc.setTextColor(GRIS_TEXTO);
    doc.text(`${num(dato.valor)} m³`, x + ANCHO_ETIQUETA + anchoPista + 6, filaY + 8);
  });

  doc.setTextColor(0);
  return datos.length * ALTO_FILA;
}

/**
 * Línea de evolución: volumen por captura, en orden cronológico.
 *
 * Es la misma lectura que muestra HDU10 en pantalla, sacada de los mismos
 * números de volumeReport.ts, para que el informe y el gráfico de la aplicación
 * no cuenten historias distintas de la misma zona.
 */
function dibujarLinea(
  doc: Doc,
  puntos: { etiqueta: string; valor: number }[],
  x: number,
  y: number,
  ancho: number,
  alto: number,
): number {
  if (puntos.length < 2) return 0;

  const PAD_IZQ = 42;
  const PAD_ABAJO = 16;
  const trazoX = x + PAD_IZQ;
  const trazoAncho = ancho - PAD_IZQ;
  const trazoAlto = alto - PAD_ABAJO;
  const tope = escalaEje(Math.max(...puntos.map((p) => p.valor)));

  // Rejilla horizontal en cuartos, con su valor a la izquierda.
  doc.setFontSize(7);
  for (let i = 0; i <= 4; i++) {
    const lineaY = y + trazoAlto - (i / 4) * trazoAlto;
    doc.setDrawColor(...GRIS_LINEA);
    doc.setLineWidth(0.5);
    doc.line(trazoX, lineaY, trazoX + trazoAncho, lineaY);
    doc.setTextColor(GRIS_TEXTO);
    doc.text(num((tope * i) / 4), x, lineaY + 2, { align: "left" });
  }

  const posX = (i: number) =>
    trazoX + (puntos.length === 1 ? trazoAncho / 2 : (i / (puntos.length - 1)) * trazoAncho);
  const posY = (valor: number) => y + trazoAlto - (valor / tope) * trazoAlto;

  doc.setDrawColor(...AZUL);
  doc.setLineWidth(1.4);
  for (let i = 1; i < puntos.length; i++) {
    doc.line(posX(i - 1), posY(puntos[i - 1].valor), posX(i), posY(puntos[i].valor));
  }

  doc.setFillColor(...AZUL);
  puntos.forEach((punto, i) => {
    // Los extremos se anclan al borde del trazado en vez de centrarse: una
    // fecha centrada sobre el primer o el último punto se sale del ancho útil
    // de la página.
    const anclaje = i === 0 ? "left" : i === puntos.length - 1 ? "right" : "center";

    doc.circle(posX(i), posY(punto.valor), 2.2, "F");
    doc.setFontSize(7);
    doc.setTextColor(GRIS_TEXTO);
    doc.text(punto.etiqueta, posX(i), y + trazoAlto + 10, { align: anclaje });
    doc.setTextColor(0);
    doc.text(num(punto.valor), posX(i), posY(punto.valor) - 6, { align: anclaje });
  });

  doc.setTextColor(0);
  doc.setLineWidth(0.2);
  return alto;
}

/**
 * Arma el documento y devuelve una URL de objeto para mostrarlo.
 *
 * Ya no existe un camino de "descargar directo": los dos accesos al informe
 * (Vista Principal y la vista de Análisis) pasan por la vista previa, y la
 * descarga la ofrece el propio visor de PDF del navegador. Así lo que se ve y
 * lo que se guarda son literalmente el mismo documento, sin construirlo dos
 * veces.
 *
 * La URL la libera quien la crea, no este módulo (ver ReportPreview).
 */
export async function buildVolumeReport(selections: ReportSelection[]): Promise<{
  blobUrl: () => string;
}> {
  const doc = await renderReport(selections);
  return {
    // Se envuelve en un File con nombre para que la descarga del visor no
    // quede bautizada con el identificador del blob.
    blobUrl: () =>
      URL.createObjectURL(
        new File([doc.output("blob")], reportFilename(), { type: "application/pdf" }),
      ),
  };
}

/** Todo el dibujo del documento. */
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

    const ordenado = [...porTipo.entries()].sort((a, b) => b[1] - a[1]);

    const filasTipo = ordenado.map(([tipo, valor]) => [
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

    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 20;

    // Las mismas cifras de la tabla, en barras. La tabla responde "cuánto de
    // cada tipo"; el gráfico responde "cuál domina", que es lo que se mira
    // primero al planificar un retiro.
    const altoBarras = ordenado.length * 16 + 4;
    if (y + altoBarras > 780) {
      doc.addPage();
      y = margin;
    }
    y += dibujarBarras(
      doc,
      ordenado.map(([etiqueta, valor]) => ({ etiqueta, valor })),
      margin,
      y,
      515,
    );
    y += 26;
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
    const puntos: { etiqueta: string; valor: number }[] = [];
    let anterior: number | null = null;
    const algoritmos = new Set<number | null>();

    for (const version of versiones) {
      // La cifra de una versión es la de su análisis más reciente: es la
      // lectura vigente de ese vuelo.
      const ultimo = version.analyses[version.analyses.length - 1];
      const volumen = zoneTotals(ultimo).volumeM3;
      algoritmos.add(ultimo.algorithmVersion ?? null);
      puntos.push({ etiqueta: formatDate(version.captureDate), valor: volumen });

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

    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 20;

    // La curva de la zona. La tabla de arriba ya da la variación exacta entre
    // capturas; esto muestra la tendencia de un vistazo, que es lo que se lleva
    // a una reunión.
    const ALTO_LINEA = 110;
    if (y + ALTO_LINEA > 780) {
      doc.addPage();
      y = margin;
    }
    const dibujado = dibujarLinea(doc, puntos, margin, y, 515, ALTO_LINEA);
    if (dibujado > 0) y += dibujado + 14;

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
