// =============================================================================
// CONDORFINDER — REDUCCIÓN DE IMÁGENES ANTES DE SUBIR
// Archivo: src/lib/imagenes.ts
//
// Un vuelo real de la municipalidad son 84 fotos de 8064x6048 a ~39 MB cada
// una: 3,2 GB. Eso no sube por ninguna conexión doméstica y Cloudflare corta
// el cuerpo de la petición mucho antes.
//
// **Y ODM no usa esa resolución.** `presetfast` declara `resize-to: 1500` y
// `presethigh` usa el default de ODM, 2048 (ver joinOrtho.py). O sea el
// pipeline reduce cada imagen apenas la recibe. Subir los 39 MB originales es
// transportar bytes que el servidor descarta al instante.
//
// Reducir a 4096 px de lado largo ANTES de subir lleva el set de 3,2 GB a
// ~0,41 GB conservando los 2 cm/px que pide el preset más exigente (ver
// LADO_MAXIMO para la medición). Una parte grande del ahorro ni siquiera es
// resolución: los originales vienen casi sin comprimir, y re-codificarlos al
// 92% SIN reducir nada ya los baja de 39 MB a 15,3.
//
// ── Por qué el EXIF se trasplanta a mano ──
// El canvas re-codifica el ráster y DESCARTA todos los metadatos. Eso rompería
// dos cosas que no dan error visible, solo resultados equivocados:
//   - el GPS, que es lo único que `Reconociemiento_solapamiento.py` usa para
//     comprobar el 60% de solapamiento entre fotos consecutivas;
//   - `DateTimeOriginal`, que es de donde sale la fecha de captura de la
//     versión, y sin ella una zona ordena mal su propia historia.
//
// Se copia el segmento APP1 del JPEG original al nuevo, por bytes. Es el
// formato de JPEG, congelado desde 1992, y evita una dependencia que tendría
// que pasar varios MB a base64 y de vuelta por cada una de las 84 fotos.
// =============================================================================

/** Lado largo al que se reduce.
 *
 *  **4096 no es un número redondo elegido a ojo: sale de lo que pide el preset
 *  más exigente.** Medido con el material real de la municipalidad (DJI FC8282,
 *  8064x6048, focal de 24 mm equivalente, volando a 60 m sobre el despegue):
 *
 *    lado   cm por pixel   por foto   set de 84
 *    2048       4,39         1,4 MB     0,12 GB
 *    4096       2,20         4,9 MB     0,41 GB
 *    8064       1,12        15,3 MB     1,28 GB   (original: 39 MB, 3,17 GB)
 *
 *  `presethigh` ("Preciso") pide un ortomosaico de **2 cm/px**, y 4096 entrega
 *  2,20: justo esa resolución. `presetfast` ("Óptimo") pide 8 cm/px, así que
 *  para ese preset esto sobra por cuatro.
 *
 *  **Y ODM NO reduce las imágenes por su cuenta.** Consultado contra el NodeODM
 *  de producción (`GET /options`, 07-10-2026), `resize-to` **no existe** en esta
 *  versión: el `'resize-to': 1500` que declara `presetfast` en joinOrtho.py es
 *  configuración muerta que se ignora en silencio. Eso significa que la
 *  resolución con la que llegan las fotos **acota directamente** la del
 *  ortomosaico, y por lo tanto el detalle que YOLO tiene para encontrar basura.
 *
 *  **Bajar a 2048 ahorraría otro 70% del peso y dejaría "Preciso" en 4,4 cm/px
 *  contra los 2 que pide.** Es la tentación obvia y hay que resistirla: SP2 es
 *  precisamente la historia sobre la precisión de la estimación, y recortar el
 *  ortomosaico para que suba más rápido socava lo que ese trabajo demuestra.
 *
 *  Lo que NO depende de esto es el cálculo de volumen: el DSM y el DTM salen de
 *  la nube de puntos que ODM reconstruye en su etapa de SfM, y ahí reduce las
 *  imágenes de todos modos. */
const LADO_MAXIMO = 4096;

/** Calidad del JPEG resultante. 0.92 y no 0.8: la fotogrametría encuentra
 *  puntos en común entre fotos a partir de detalle fino, y el artefacto de
 *  bloque de una compresión agresiva es exactamente lo que confunde a ese
 *  detector. El peso que ahorraría no vale el riesgo de un modelo peor. */
const CALIDAD = 0.92;

/**
 * El segmento EXIF (APP1) de un JPEG, o null si no tiene.
 *
 * Recorre los marcadores desde el principio. Un JPEG es `FFD8` seguido de
 * segmentos `FF <marca> <largo de 2 bytes> <datos>`, y el de EXIF es la marca
 * `E1` cuyos datos empiezan con "Exif". Hay otros APP1 posibles (XMP, por
 * ejemplo), de ahí que no alcance con mirar la marca.
 */
function extraerExif(buffer: ArrayBuffer): ArrayBuffer | null {
  const b = new Uint8Array(buffer);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null; // no es JPEG

  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null; // fuera de sincronía: no seguir adivinando
    const marca = b[i + 1];

    // Marcadores sin carga útil (relleno, reinicio): avanzan dos bytes.
    if (marca === 0x01 || (marca >= 0xd0 && marca <= 0xd9)) {
      i += 2;
      continue;
    }
    // Inicio del ráster comprimido: de acá en adelante no hay más metadatos.
    if (marca === 0xda) return null;

    const largo = (b[i + 2] << 8) | b[i + 3];
    if (largo < 2) return null;

    if (marca === 0xe1 && i + 10 <= b.length) {
      const esExif =
        b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66;
      if (esExif) return buffer.slice(i, i + 2 + largo);
    }
    i += 2 + largo;
  }
  return null;
}

/** Pega el segmento EXIF justo después del `FFD8` inicial del JPEG nuevo.
 *
 *  Ese es el lugar donde va por norma, y además el canvas no produce ningún
 *  APP1 propio, así que no hay nada que pueda quedar duplicado. */
function pegarExif(jpeg: ArrayBuffer, exif: ArrayBuffer): Blob {
  return new Blob([jpeg.slice(0, 2), exif, jpeg.slice(2)], { type: "image/jpeg" });
}

/**
 * Reduce una foto a `LADO_MAXIMO` conservando su EXIF.
 *
 * Devuelve el archivo ORIGINAL, sin tocar, cuando ya es lo bastante chico o
 * cuando algo falla: una foto grande que sube lento es infinitamente mejor que
 * una que no sube, y la decisión de no procesarla no debería romper la carga.
 */
export async function reducirParaOdm(file: File): Promise<File> {
  try {
    const buffer = await file.arrayBuffer();
    const bitmap = await createImageBitmap(new Blob([buffer], { type: file.type }));

    const lado = Math.max(bitmap.width, bitmap.height);
    if (lado <= LADO_MAXIMO) {
      bitmap.close();
      return file;
    }

    const escala = LADO_MAXIMO / lado;
    const ancho = Math.round(bitmap.width * escala);
    const alto = Math.round(bitmap.height * escala);

    const canvas = document.createElement("canvas");
    canvas.width = ancho;
    canvas.height = alto;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, ancho, alto);
    // Se libera apenas se usó: son 48 MP descomprimidos, unos 190 MB en
    // memoria. Con 84 fotos sin liberar, la pestaña se queda sin memoria antes
    // de llegar a subir nada.
    bitmap.close();

    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", CALIDAD));
    if (!blob) return file;

    const exif = extraerExif(buffer);
    const final = exif ? pegarExif(await blob.arrayBuffer(), exif) : blob;

    // Mismo nombre: el backend lo usa como identidad del archivo en disco y
    // ODM ordena las fotos por él.
    return new File([final], file.name, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/**
 * Reduce un conjunto, de a una.
 *
 * EN SERIE y no en paralelo a propósito: cada foto descomprimida son ~190 MB
 * en memoria, así que decodificar varias a la vez es la forma más rápida de
 * quedarse sin memoria. El cuello de botella real es la subida, no esto.
 */
export async function reducirTodas(
  files: File[],
  onProgress?: (hechas: number, total: number) => void,
): Promise<File[]> {
  const salida: File[] = [];
  for (let i = 0; i < files.length; i++) {
    salida.push(await reducirParaOdm(files[i]));
    onProgress?.(i + 1, files.length);
  }
  return salida;
}
