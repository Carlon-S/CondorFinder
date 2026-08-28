// El plugin de manifest de TanStack Start (@tanstack/start-plugin-core,
// vite/start-manifest-plugin/plugin.js) solo arma el manifest real de
// rutas cuando el entorno de Vite se llama exactamente "ssr" — es un
// nombre fijo (START_ENVIRONMENT_NAMES.server), no configurable. El build
// de "dist/server" (Vite SSR normal) usa ese nombre y sale bien. Pero
// @cloudflare/vite-plugin nombra su propio entorno según el "name" del
// worker en wrangler.jsonc ("condorfinder"), así que ese build de
// "dist/condorfinder" no lo reconoce y cae a un manifest vacío/stub que
// apunta al entry point de desarrollo de Vite (que no existe en
// producción) — la hidratación del cliente nunca llega a correr.
//
// Fix: copiar el contenido del manifest correcto (dist/server) sobre el
// archivo del manifest roto (dist/condorfinder), manteniendo el nombre de
// archivo que este último ya tiene (es lo que importa worker-entry.js).
// Los assets que referencia son válidos igual: el Worker sirve estáticos
// desde dist/client, la misma carpeta que usa dist/server.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function findManifestFile(assetsDir) {
  const files = await readdir(assetsDir);
  const match = files.find((f) => f.startsWith("_tanstack-start-manifest_v-") && f.endsWith(".js"));
  if (!match) {
    throw new Error(`No se encontró el chunk del manifest en ${assetsDir}`);
  }
  return join(assetsDir, match);
}

const serverManifestPath = await findManifestFile("dist/server/assets");
const workersManifestPath = await findManifestFile("dist/condorfinder/assets");

const correctContent = await readFile(serverManifestPath, "utf-8");
await writeFile(workersManifestPath, correctContent, "utf-8");

console.log(
  `[fix-workers-manifest] Copiado el manifest correcto de rutas hacia el build de Workers:\n  ${serverManifestPath} -> ${workersManifestPath}`,
);
