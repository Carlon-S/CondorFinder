// =============================================================================
// CONDORFINDER — PERSONAL DISPONIBLE (HDU5.1, AC1 y AC2)
// Archivo: src/lib/crewState.ts
//
// La cuadrilla que el trabajador declara al generar una ruta, recordada entre
// generaciones.
//
// ── Por qué no está en la base ──
// La Municipalidad de Maipú describió su operación como "se designa personal
// según requerimiento" y "se flexibiliza por inasistencias": el personal es del
// PLAN, no del vehículo ni del punto, así que no hay padrón que mantener.
// Guardar una nómina en Mongo además significaría almacenar datos personales
// (Ley 19.628) que nadie nos entregó y que ya no se pueden pedir.
//
// Lo que viaja al backend es solo la lista de quienes están marcados, dentro de
// la petición de esa generación. El servidor no la persiste.
//
// ── Por qué entonces se guarda acá ──
// Porque sin esto hay que reescribir la cuadrilla entera en cada generación, y
// un criterio que obliga a tipear veinte nombres por ruta queda cumplido en el
// papel y abandonado en la práctica. Guardado en el navegador del trabajador, la
// operación diaria pasa a ser marcar y desmarcar casillas.
//
// Es su propia máquina y su propia gente: el dato no se centraliza, no viaja al
// repositorio y nosotros no lo vemos. Se pierde al limpiar los datos del sitio o
// al cambiar de equipo, y eso es aceptable, porque es una comodidad para no
// retipear y no un registro oficial.
//
// localStorage y no sessionStorage, a diferencia del resto de los envoltorios de
// este directorio: una cuadrilla cambia de a poco entre semanas, no entre
// pestañas, y perderla al cerrar el navegador devolvería el problema que esto
// viene a resolver.
// =============================================================================

export type RolPersonal = "conductor" | "peoneta" | "operador";

export interface PersonaCuadrilla {
  /** Identificador local de la fila. No viaja al backend: existe para que React
   *  tenga una `key` estable mientras se escribe el nombre, que todavía puede
   *  estar vacío o repetido. */
  id: string;
  nombre: string;
  rol: RolPersonal;
  /** Si viene HOY. Desmarcarla es lo que cubre "se flexibiliza por
   *  inasistencias": quien falta un día vuelve al siguiente, y obligar a borrar
   *  y reescribir su nombre convertiría una ausencia en un alta nueva. */
  disponible: boolean;
}

const CLAVE = "condorfinder:cuadrilla";

export const ROLES: { valor: RolPersonal; etiqueta: string }[] = [
  { valor: "conductor", etiqueta: "Conductor" },
  { valor: "peoneta", etiqueta: "Peoneta" },
  { valor: "operador", etiqueta: "Operador" },
];

/** La cuadrilla guardada, o una lista vacía.
 *
 *  La guarda de `window` no es opcional: TanStack Start hace SSR en Node, donde
 *  Web Storage no existe. Y el try/catch tampoco: en una ventana privada o con
 *  los datos del sitio bloqueados, el solo hecho de LEER lanza. */
export function leerCuadrilla(): PersonaCuadrilla[] {
  if (typeof window === "undefined") return [];
  try {
    const crudo = window.localStorage.getItem(CLAVE);
    if (!crudo) return [];
    const datos = JSON.parse(crudo);
    if (!Array.isArray(datos)) return [];
    // Se valida fila por fila en vez de confiar en el JSON: esto lo escribió una
    // versión anterior de la app y puede tener otra forma.
    return datos
      .filter(
        (p): p is PersonaCuadrilla =>
          p && typeof p.nombre === "string" && ROLES.some((r) => r.valor === p.rol),
      )
      .map((p) => ({
        id: typeof p.id === "string" ? p.id : crypto.randomUUID(),
        nombre: p.nombre,
        rol: p.rol,
        disponible: p.disponible !== false,
      }));
  } catch {
    return [];
  }
}

export function guardarCuadrilla(personas: PersonaCuadrilla[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CLAVE, JSON.stringify(personas));
  } catch {
    // Sin espacio o con el almacenamiento bloqueado. La generación funciona
    // igual: lo que el backend necesita viaja en la petición, esto solo evita
    // retipear la próxima vez.
  }
}

/** Nombres repetidos entre las personas MARCADAS, en minúsculas y sin espacios
 *  sobrantes.
 *
 *  Mismo criterio que las patentes de la flota, y acá además es necesario para
 *  el criterio: el AC2 se verifica comprobando que un nombre no aparezca en dos
 *  vehículos del plan, y con dos filas llamadas igual esa comprobación deja de
 *  poder hacerse. */
export function nombresRepetidos(personas: PersonaCuadrilla[]): Set<string> {
  const vistos = new Set<string>();
  const repetidos = new Set<string>();
  for (const p of personas) {
    if (!p.disponible) continue;
    const clave = p.nombre.trim().toLowerCase();
    if (!clave) continue;
    if (vistos.has(clave)) repetidos.add(clave);
    vistos.add(clave);
  }
  return repetidos;
}
