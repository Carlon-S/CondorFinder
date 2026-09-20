// =============================================================================
// CONDORFINDER, LIMPIEZA DE ARCHIVOS DE UNA VERSIÓN
// Archivo: src/lib/versionCleanup.ts
//
// Una VERSIÓN es un vuelo: un set de fotos, un ortomosaico, y todo lo que el
// pipeline derivó de él. Cuando esa versión se queda sin ningún análisis
// guardado, nada de eso le sirve ya a nadie y hay que borrarlo del servidor.
//
// Vive acá, y no dentro de una vista, porque hay DOS lugares que borran:
// Vista Principal (eliminar una captura o una zona entera) y la vista de
// Análisis (eliminar una versión desde la barra de capturas). Con la lógica
// duplicada, cualquier archivo que se agregue al pipeline se acuerda en un
// lado y se olvida en el otro, que es exactamente como aparecieron las
// miniaturas y los modelos de elevación huérfanos que hubo que ir cazando
// después.
//
// Los cuatro .tif comparten el uuid de la tarea de ODM, que es el que viaja en
// el nombre del mapa ("ortho_<uuid>.png"), NO el sourceTaskId de CondorFinder:
// son espacios de nombres distintos y confundirlos apunta a archivos que no
// existen.
// =============================================================================

import {
  deleteResultFile,
  deleteFinalsFile,
  deleteTaskImages,
  deleteTask,
} from "@/lib/unify";

/** Prefijos de los cuatro .tif que joinOrtho deja en finals/ por cada vuelo. */
const PREFIJOS_TIF = ["ortho_", "dsm_", "dtm_", "ndsm_"] as const;

/**
 * Borra del servidor todo lo que pertenece a una versión.
 *
 * Llamar SOLO cuando esa versión ya no tiene ningún análisis guardado.
 * Mientras le quede alguno, sus archivos siguen haciendo falta: los modelos de
 * elevación son con lo que se vuelve a medir, y el ortomosaico es lo que lee
 * ese cálculo.
 *
 * @param mapUrl  URL del mapa de la versión ("…/result/ortho_<uuid>.png").
 * @param taskId  sourceTaskId de CondorFinder, para el snapshot y el documento.
 */
export function borrarArchivosDeVersion(mapUrl?: string | null, taskId?: string | null): void {
  const filename = mapUrl?.split("/").pop();

  if (filename) {
    // En el bucket: el mapa, su miniatura y el JSON de detecciones.
    deleteResultFile(filename);
    const thumbName = filename.replace(/\.png$/i, "_thumb.png");
    if (thumbName !== filename) deleteResultFile(thumbName);
    const jsonName = filename.replace(/\.png$/i, ".json");
    if (jsonName !== filename) deleteResultFile(jsonName);

    // En el disco de la VM: ortomosaico y los tres modelos de elevación.
    const base = filename.replace(/\.png$/i, "");
    for (const prefijo of PREFIJOS_TIF) {
      deleteFinalsFile(`${base.replace(/^ortho_/, prefijo)}.tif`);
    }
  }

  // El snapshot de las imágenes originales y el documento de la tarea.
  if (taskId) {
    deleteTaskImages(taskId);
    deleteTask(taskId);
  }
}
