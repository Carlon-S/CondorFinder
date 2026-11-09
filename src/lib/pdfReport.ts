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
import {
  buildVersions,
  evolutionSeries,
  type RetiroDeZona,
  versionLabel,
  volumeByWasteType,
  zoneTotals,
} from "@/lib/volumeReport";

/** Un análisis elegido para el informe, junto a la zona a la que pertenece. */
export interface ReportSelection {
  zone: ZoneRecord;
  analyses: SavedAnalysisRecord[];
  /** Los retiros registrados de esta zona (pieza 2.5 de HDU5.2).
   *
   *  **Entran a la misma linea de tiempo que las mediciones**, porque son el
   *  mismo tipo de dato: los dos dicen cuanto volumen habia en un lugar en una
   *  fecha, y lo que cambia es quien lo conto. Es lo que le da historial de
   *  volumen a un punto permanente al que nadie le volo el dron.
   *
   *  Ausente significa que quien pidio el informe no los cargo, no que no haya:
   *  el documento sale igual, con solo las mediciones. */
  retiros?: RetiroDeZona[];
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
/** Los colores de la marca en el sistema: el azul casi negro de la barra lateral,
 *  el amarillo de los botones principales y el fondo claro de las tablas. */
const NAVY: [number, number, number] = [7, 11, 20];
const AMARILLO: [number, number, number] = [255, 197, 61];
const GRIS_FONDO: [number, number, number] = [245, 246, 249];
const TEXTO: [number, number, number] = [30, 35, 50];
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
 * Arma el documento y devuelve con qué mostrarlo y con qué guardarlo.
 *
 * Los dos accesos al informe (Vista Principal y la vista de Análisis) pasan por
 * la vista previa, y de ahí sale la descarga, así que el documento se construye
 * una sola vez y lo que se ve es literalmente lo que se guarda.
 *
 * La URL la libera quien la crea, no este módulo (ver ReportPreview).
 */
export async function buildVolumeReport(selections: ReportSelection[]): Promise<{
  blobUrl: () => string;
  save: () => void;
  filename: string;
}> {
  const doc = await renderReport(selections);
  const filename = reportFilename();
  return {
    // Se envuelve en un File con nombre para que una descarga hecha desde el
    // visor no quede bautizada con el identificador del blob.
    blobUrl: () =>
      URL.createObjectURL(new File([doc.output("blob")], filename, { type: "application/pdf" })),
    save: () => doc.save(filename),
    filename,
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

  const anchoPagina = doc.internal.pageSize.getWidth();
  const anchoUtil = anchoPagina - margin * 2;
  const totalPeso = selections.reduce(
    (s, sel) => s + sel.analyses.reduce((t, a) => t + zoneTotals(a).weightKg, 0),
    0,
  );

  /** Título de sección: una marca amarilla a la izquierda y el texto en el azul
   *  de la marca, igual que los encabezados del sistema. */
  const titulo = (texto: string) => {
    doc.setFillColor(...AMARILLO);
    doc.rect(margin, y - 10, 3, 13, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(...NAVY);
    doc.text(texto, margin + 10, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(0);
    y += 12;
  };

  /** Tabla con el estilo del documento: encabezado azul, filas alternadas y las
   *  columnas de cifras alineadas a la derecha (también su encabezado). */
  const tabla = (opts: Parameters<typeof autoTable>[1], numericas: number[]) =>
    autoTable(doc, {
      margin: { left: margin, right: margin, bottom: 50 },
      styles: { fontSize: 8, cellPadding: 5, textColor: TEXTO, lineWidth: 0 },
      headStyles: { fillColor: NAVY, textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: GRIS_FONDO },
      didParseCell: (d) => {
        if (numericas.includes(d.column.index)) d.cell.styles.halign = "right";
      },
      ...opts,
    });

  // ── encabezado: banda azul con el acento amarillo de la marca ──
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, anchoPagina, 84, "F");
  doc.setFillColor(...AMARILLO);
  doc.rect(0, 84, anchoPagina, 3, "F");
  doc.setTextColor(255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(19);
  doc.text("Informe de volumen de residuos", margin, 42);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(190, 196, 210);
  doc.text(
    `CondorFinder · Emitido el ${new Date().toLocaleDateString("es-CL")} · ` +
      `${selections.length} zona(s), ${totalAnalisis} análisis`,
    margin,
    62,
  );
  doc.setTextColor(0);
  y = 112;

  // ── cifras principales, en recuadros rectos como las tarjetas del sistema ──
  const resumen: [string, string][] = [
    ["ZONAS", String(selections.length)],
    ["ANÁLISIS", String(totalAnalisis)],
    ["VOLUMEN TOTAL", `${num(totalVolumen)} m³`],
    ["PESO TOTAL", `${totalPeso.toLocaleString("es-CL", { maximumFractionDigits: 0 })} kg`],
  ];
  const hueco = 10;
  const anchoRecuadro = (anchoUtil - hueco * (resumen.length - 1)) / resumen.length;
  resumen.forEach(([rotulo, valor], i) => {
    const rx = margin + i * (anchoRecuadro + hueco);
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(...GRIS_LINEA);
    doc.setLineWidth(0.8);
    doc.rect(rx, y, anchoRecuadro, 50, "FD");
    doc.setFillColor(...AMARILLO);
    doc.rect(rx, y, 3, 50, "F");
    doc.setFontSize(7);
    doc.setTextColor(GRIS_TEXTO);
    doc.text(rotulo, rx + 12, y + 17);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(...NAVY);
    doc.text(valor, rx + 12, y + 38);
    doc.setFont("helvetica", "normal");
  });
  doc.setTextColor(0);
  doc.setLineWidth(0.2);
  y += 50 + 30;

  titulo("Detalle por zona y análisis");
  y += 6;

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
          versionLabel(version.captureDate, version.uploadedAt),
          formatDate(analysis.savedAt),
          num(t.volumeM3),
          t.weightKg.toLocaleString("es-CL"),
          num(t.areaM2),
          String(t.count),
        ]);
      }
    }
  }

  tabla(
    {
      startY: y,
      head: [["Zona", "Captura", "Análisis", "Volumen m³", "Peso kg", "Área m²", "Detecciones"]],
      body: filas,
    },
    [3, 4, 5, 6],
  );

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
    titulo("Volumen por tipo de residuo");
    y += 6;

    const ordenado = [...porTipo.entries()].sort((a, b) => b[1] - a[1]);

    const filasTipo = ordenado.map(([tipo, valor]) => [
      tipo,
      num(valor),
      totalVolumen > 0 ? `${((valor / totalVolumen) * 100).toFixed(1)} %` : "0 %",
    ]);

    tabla(
      {
        startY: y,
        head: [["Tipo de residuo", "Volumen m³", "Participación"]],
        body: filasTipo,
      },
      [1, 2],
    );

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
    // **La serie sale de `evolutionSeries`, no de un recorrido propio.** Es la
    // regla del proyecto: la aritmetica del volumen vive en un solo lugar, o el
    // informe y el grafico de la pantalla cuentan historias distintas de la
    // misma zona. Trae las mediciones y, si se cargaron, los retiros ya
    // descontados e intercalados por fecha.
    const serie = evolutionSeries(versiones, sel.retiros);
    // Con un solo punto no hay evolucion que mostrar. Se mide sobre la SERIE y
    // no sobre las versiones: una zona de un vuelo con tres retiros si tiene
    // curva, y es el caso de los 54 puntos permanentes.
    if (serie.length < 2) continue;

    if (y > 680) {
      doc.addPage();
      y = margin;
    }

    titulo(`Evolución de ${sel.zone.name}`);
    y += 6;

    const filasComparacion: string[][] = [];
    const puntos: { etiqueta: string; valor: number }[] = [];
    let anterior: number | null = null;
    // Para poder poner en la fila cuantos analisis tiene cada captura, que es un
    // dato de la VERSION y no del punto de la serie.
    const analisisPorVuelo = new Map(versiones.map((v) => [v.sourceTaskId, v.analyses.length]));

    for (const punto of serie) {
      const esRetiro = punto.origen === "retiro";

      const etiqueta = esRetiro
        ? `Retiro ${formatDate(punto.date)}`
        : versionLabel(punto.date, punto.uploadedAt);
      puntos.push({
        etiqueta: esRetiro ? formatDate(punto.date) : etiqueta,
        valor: punto.volumeM3,
      });

      const variacion =
        anterior === null
          ? "-"
          : anterior === 0
            ? "sin base"
            : `${(((punto.volumeM3 - anterior) / anterior) * 100).toFixed(1)} %`;

      filasComparacion.push([
        etiqueta,
        // Un retiro no tiene analisis que contar: lleva un guion y no un cero,
        // que afirmaria que se midio cero veces.
        esRetiro ? "-" : String(analisisPorVuelo.get(punto.sourceTaskId) ?? 1),
        num(punto.volumeM3),
        variacion,
      ]);
      anterior = punto.volumeM3;
    }

    tabla(
      {
        startY: y,
        // "Registro" y no "Captura": desde que la tabla mezcla vuelos y retiros,
        // la columna ya no nombra solo capturas.
        head: [["Registro", "Análisis", "Volumen m³", "Variación"]],
        body: filasComparacion,
      },
      [1, 2, 3],
    );

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
  }

  // ── pie de cada página: línea fina, nombre del sistema y numeración ──
  const paginas = doc.getNumberOfPages();
  const altoPagina = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= paginas; i++) {
    doc.setPage(i);
    doc.setDrawColor(...GRIS_LINEA);
    doc.setLineWidth(0.6);
    doc.line(margin, altoPagina - 36, anchoPagina - margin, altoPagina - 36);
    doc.setFontSize(7.5);
    doc.setTextColor(GRIS_TEXTO);
    doc.text("CondorFinder · Detección de basurales con imágenes de dron", margin, altoPagina - 22);
    doc.text(`Página ${i} de ${paginas}`, anchoPagina - margin, altoPagina - 22, { align: "right" });
  }
  doc.setTextColor(0);

  return doc;
}
