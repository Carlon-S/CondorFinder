// =============================================================================
// CONDORFINDER — PUNTOS DE SALIDA (HDU6) Y RECURSOS (HDU8)
// Archivo: src/lib/resources.ts
//
// Mismo patrón que unify.ts/auth.ts: un módulo chico por responsabilidad,
// fetch directo con credentials: "include" (la cookie de sesión viaja
// sola, mismo mecanismo que el resto del backend ya protegido).
//
// El punto es el LUGAR y el recurso es la UNIDAD que opera desde ahí. HDU6
// guardaba la maquinaria como contadores dentro del punto (`tolvas`, `trucks`,
// `retroexcavadoras_count`); HDU8 los reemplazó por recursos individuales, cada
// uno con su identidad y su propio interruptor de disponibilidad, porque un
// contador no tiene patente y no se puede marcar como "en taller". Los campos
// en snake_case son los del backend, que en este módulo nunca usó camelCase.
// =============================================================================

// CLIENT_BACKEND_URL (no BACKEND_URL): este archivo corre 100% en el
// navegador — necesita la ruta relativa que proxyea vite.config.ts, para
// que la cookie de sesión no se pierda por ser cross-origin. Ver config.ts.
import { CLIENT_BACKEND_URL as BACKEND_URL } from "./config";

/** Familia de un tipo de recurso. Decide qué campos pide el formulario (AC2 de
 *  HDU8) y qué recursos suman capacidad de transporte.
 *
 *   carga    -> capacidad de la tolva o caja. Es la que cuenta para la ruta.
 *   maquina  -> capacidad del balde. Carga, no transporta.
 *   arrastre -> se remolca; sin capacidad ni dotación propia.
 *   apoyo    -> vehículo de supervisión, sin capacidad de carga. */
export type ResourceFamily = "carga" | "maquina" | "arrastre" | "apoyo";

export interface ResourceType {
  tipo: string;
  familia: ResourceFamily;
}

export interface ResourceInput {
  tipo: string;
  numero_equipo: string;
  patente: string;
  marca: string;
  modelo: string;
  anio: number | null;
  /** Solo familia "carga". En las demás el backend rechaza el campo, no lo
   *  ignora: una capacidad de carga guardada en una retroexcavadora la haría
   *  aparecer como transporte disponible en el ruteo. */
  capacidad_m3: number | null;
  /** Limite de PESO, al lado del de volumen. Un camion tiene los dos y hasta
   *  HDU8 el sistema solo modelaba el primero: la municipalidad entrego el
   *  del CAMION 3/4 PLANO (1 t) y el del AMPLIROLL (15 t) y no habia donde
   *  guardarlos. El ruteo reparte por VOLUMEN, asi que este campo no decide
   *  ninguna ruta todavia; es el limite que el AC4 de HDU5.1 va a contrastar
   *  contra el peso estimado de la zona. */
  capacidad_ton: number | null;
  /** AC3 de HDU5.1: kilometros que el vehiculo recorre antes de necesitar
   *  recarga. El ruteo descarta los ordenes de visita cuya distancia total lo
   *  supere. **La municipalidad respondio que ese limite no existe en su
   *  flota**, asi que en produccion queda vacio y el criterio no corta nada;
   *  es demostrable declarando una autonomia baja. Solo familia `carga`. */
  autonomia_km: number | null;
  /** Solo familia "maquina". */
  capacidad_balde_m3: number | null;
  conductores_requeridos: number;
  peonetas_requeridas: number;
  operadores_requeridos: number;
  observaciones: string;
  /** Nombre del archivo, no una URL. La URL se arma con resourcePhotoUrl(). */
  foto: string | null;
  /** AC4 de HDU8. */
  disponible: boolean;
  point_id: string;
}

export interface Resource extends ResourceInput {
  id: string;
  owner: string;
  created_at: string;
  /** Derivada del tipo por el backend, nunca enviada por el cliente. */
  familia: ResourceFamily;
}

export interface ResourcePointInput {
  name: string;
  address: string;
  comuna: string;
  lat: number;
  lng: number;
  /** Trabajadores del punto. Se mantuvo cuando la maquinaria pasó a recursos
   *  porque es el único dato de HDU6 sin equivalente en la planilla de flota:
   *  la planilla trae la dotación que un vehículo REQUIERE, no los
   *  trabajadores que el punto TIENE. */
  personal_count: number;
  // HDU5/AC1 — si participa como origen al generar una ruta.
  active: boolean;
}

export interface ResourcePoint extends ResourcePointInput {
  id: string;
  owner: string;
  created_at: string;
  // Resumen de los recursos del punto, CALCULADO por el backend en cada
  // lectura. Reemplaza a los contadores en todas las vistas que los mostraban.
  // No se envía al crear ni al editar.
  resource_count: number;
  available_count: number;
  /** Capacidad de transporte disponible, en m³. Cuenta exactamente lo mismo que
   *  cuenta el ruteo: familia "carga", disponible y con capacidad declarada. */
  capacity_m3: number;
  /** Nombre del archivo de la foto de Street View del lugar, servible con
   *  `resourcePhotoUrl()`.
   *
   *  El backend la pide UNA vez, al crear el punto o al moverlo, y la guarda en
   *  disco: la vista nunca llama a Google. Viene `null` cuando no hay cobertura
   *  en esa coordenada, cuando el backend no tiene clave, o en los puntos
   *  creados antes de que esto existiera; en los tres casos la vista cae al
   *  mapa estático de siempre. */
  street_view?: string | null;
}

/** Por qué un recurso entra o no entra en el cálculo de una ruta.
 *
 *  Es el ESPEJO exacto de `capacidad_de_carga_por_punto()` en
 *  backendModel/resources.py, con sus tres exclusiones y en el mismo orden. Que
 *  esté duplicado no es un descuido: el backend decide, el frontend explica, y
 *  la alternativa (pedirle al backend un desglose solo para mostrarlo) sería un
 *  endpoint nuevo para no decir nada que el cliente no pueda deducir de datos
 *  que ya tiene. Si cambia una de las dos, tiene que cambiar la otra. */
export type MotivoFueraDeRuta =
  | "no_disponible"
  | "se_remolca"
  | "no_transporta"
  | "solo_toneladas"
  | "sin_capacidad";

export function motivoFueraDeRuta(r: Resource): MotivoFueraDeRuta | null {
  // El orden importa: cada unidad cae en UN motivo, y el primero es el que se
  // reporta. Una retroexcavadora fuera de servicio se informa como fuera de
  // servicio, que es lo que el trabajador puede cambiar.
  if (!r.disponible) return "no_disponible";
  // El arrastre va antes y con motivo propio: decirle "no transporta carga" a
  // un carro que declara 30 m³ es falso. Lo que lo deja fuera de una ruta no
  // es que no cargue, es que no circula solo.
  if (r.familia === "arrastre") return "se_remolca";
  if (r.familia !== "carga") return "no_transporta";
  // Antes de "sin capacidad": el CAMION 3/4 PLANO declara 1 tonelada y no un
  // volumen, asi que decirle "sin capacidad declarada" seria falso. Queda
  // fuera igual, porque el ruteo reparte por m3, pero por un motivo distinto
  // y que ademas coincide con lo que pidio la municipalidad: ese camion hace
  // reciclaje, no escombros.
  if (r.capacidad_m3 == null && r.capacidad_ton != null) return "solo_toneladas";
  if (r.capacidad_m3 == null) return "sin_capacidad";
  return null;
}

export const TEXTO_FUERA_DE_RUTA: Record<MotivoFueraDeRuta, string> = {
  no_disponible: "marcado como no disponible",
  se_remolca: "se remolca, no circula por sí solo",
  no_transporta: "no transporta carga",
  solo_toneladas: "declara su capacidad en toneladas, no en m³",
  sin_capacidad: "sin capacidad declarada",
};

export interface ResumenRuta {
  /** Los que sí suman: de carga, disponibles y con capacidad declarada. */
  suman: Resource[];
  capacidad: number;
  fuera: Record<MotivoFueraDeRuta, Resource[]>;
}

/** Reparte los recursos de un punto entre los que cuentan para una ruta y los
 *  que no, con el motivo de cada exclusión. */
export function resumenParaRuta(recursos: Resource[]): ResumenRuta {
  const resumen: ResumenRuta = {
    suman: [],
    capacidad: 0,
    fuera: {
      no_disponible: [],
      se_remolca: [],
      no_transporta: [],
      solo_toneladas: [],
      sin_capacidad: [],
    },
  };
  for (const r of recursos) {
    const motivo = motivoFueraDeRuta(r);
    if (motivo) resumen.fuera[motivo].push(r);
    else {
      resumen.suman.push(r);
      resumen.capacidad += r.capacidad_m3 ?? 0;
    }
  }
  return resumen;
}

/** URL de la foto de un recurso. El endpoint exige sesión, igual que el resto
 *  del router; la cookie viaja sola en un `<img src>`. */
export function resourcePhotoUrl(foto: string): string {
  return `${BACKEND_URL}/resources/photo/${encodeURIComponent(foto)}`;
}

/** Campo de un error de validación de FastAPI: loc es la ruta al campo
 *  ("body", "capacidad_m3") y msg el motivo. */
interface ValidationError {
  loc?: (string | number)[];
  msg?: string;
}

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const parsed = await res.json();
    const detail = parsed?.detail;
    if (typeof detail === "string") return detail;

    // Un 422 de FastAPI trae `detail` como LISTA de errores por campo, no como
    // texto. Antes esa rama caía directo al mensaje genérico, así que un
    // rechazo de validación (por ejemplo una capacidad en 0, que el backend
    // exige > 0) se veía en pantalla como "No se pudo guardar el punto" sin
    // decir qué campo estaba mal, y quedaba indistinguible de una caída de red.
    if (Array.isArray(detail) && detail.length > 0) {
      const campos = (detail as ValidationError[])
        .map((e) => {
          // Se salta el primer tramo del loc, que siempre es "body".
          const ruta = (e.loc ?? []).slice(1).join(".");
          return ruta ? `${ruta}: ${e.msg ?? "valor inválido"}` : e.msg;
        })
        .filter(Boolean)
        .slice(0, 3)
        .join(" · ");
      if (campos) return `${fallback} Revisa: ${campos}`;
    }
  } catch {
    // respuesta no era JSON, se usa el mensaje genérico
  }
  return fallback;
}

export async function createResourcePoint(point: ResourcePointInput): Promise<ResourcePoint> {
  const res = await fetch(`${BACKEND_URL}/resources/points`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(point),
  });

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo guardar el punto."));
  }

  return res.json();
}

export async function listResourcePoints(): Promise<ResourcePoint[]> {
  const res = await fetch(`${BACKEND_URL}/resources/points`, {
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudieron cargar los puntos."));
  }

  return res.json();
}

/** Un punto por su id, con su resumen calculado. Lo usa la vista del listado de
 *  recursos, que llega por URL y no siempre tiene el punto ya cargado. */
export async function getResourcePoint(id: string): Promise<ResourcePoint> {
  const res = await fetch(`${BACKEND_URL}/resources/points/${encodeURIComponent(id)}`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo cargar el punto."));
  }
  return res.json();
}

export async function updateResourcePoint(
  id: string,
  point: ResourcePointInput,
): Promise<ResourcePoint> {
  const res = await fetch(`${BACKEND_URL}/resources/points/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(point),
  });

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo actualizar el punto."));
  }

  return res.json();
}

/** Activa o desactiva un punto sin abrir el formulario, para el interruptor de
 *  la lista.
 *
 *  Reusa el PUT completo en vez de pedir un PATCH nuevo al backend, como el que
 *  sí tienen los recursos (`/units/{id}/disponibilidad`): el cliente ya tiene el
 *  punto entero, así que reenviarlo con `active` invertido da exactamente el
 *  mismo resultado y no obliga a desplegar la VM para un cambio que es de
 *  interfaz. Si alguna vez hay más de un usuario editando a la vez, esto pisa
 *  los campos del otro y ahí sí conviene el PATCH. */
export async function setPointActive(
  point: ResourcePoint,
  active: boolean,
): Promise<ResourcePoint> {
  return updateResourcePoint(point.id, {
    name: point.name,
    address: point.address,
    comuna: point.comuna,
    lat: point.lat,
    lng: point.lng,
    personal_count: point.personal_count,
    active,
  });
}

export async function deleteResourcePoint(id: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/resources/points/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo eliminar el punto."));
  }
}

// =============================================================================
// RECURSOS (HDU8)
// =============================================================================

/** Tipos de recurso con su familia. Los sirve el backend en vez de tenerlos
 *  duplicados acá: la familia decide qué campos pide el formulario, y con dos
 *  copias de esa tabla una validación aceptada en pantalla podría ser rechazada
 *  por el servidor sin explicación. */
export async function listResourceTypes(): Promise<ResourceType[]> {
  const res = await fetch(`${BACKEND_URL}/resources/types`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudieron cargar los tipos de recurso."));
  }
  return res.json();
}

export async function listResources(pointId?: string): Promise<Resource[]> {
  const url = pointId
    ? `${BACKEND_URL}/resources/units?pointId=${encodeURIComponent(pointId)}`
    : `${BACKEND_URL}/resources/units`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudieron cargar los recursos."));
  }
  return res.json();
}

export async function createResource(resource: ResourceInput): Promise<Resource> {
  const res = await fetch(`${BACKEND_URL}/resources/units`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(resource),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo guardar el recurso."));
  }
  return res.json();
}

/** AC3 de HDU8. */
export async function updateResource(id: string, resource: ResourceInput): Promise<Resource> {
  const res = await fetch(`${BACKEND_URL}/resources/units/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(resource),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo actualizar el recurso."));
  }
  return res.json();
}

// =============================================================================
// PERSONAL (AC1 y AC2 de HDU5.1)
//
// La cuadrilla de un punto. Empezo guardada en el navegador para no almacenar
// datos personales, y se movio al servidor a pedido del equipo: una lista que no
// se comparte entre equipos ni sobrevive a un cambio de navegador obliga a
// reescribirla en cada maquina, y el criterio terminaba cumplido en el papel y
// abandonado en la practica.
// =============================================================================

export type RolPersonal = "conductor" | "peoneta" | "operador";

export interface Persona {
  id: string;
  nombre: string;
  rol: RolPersonal;
  /** Si entra en el plan de hoy. Es el equivalente del interruptor de los
   *  vehiculos y lo que cubre "se flexibiliza por inasistencias": quien falta
   *  hoy vuelve manana, y borrarlo convertiria una ausencia en una baja. */
  disponible: boolean;
  point_id: string;
}

export type PersonaInput = Omit<Persona, "id">;

export const ROLES: { valor: RolPersonal; etiqueta: string; plural: string }[] = [
  { valor: "conductor", etiqueta: "Conductor", plural: "conductores" },
  { valor: "peoneta", etiqueta: "Peoneta", plural: "peonetas" },
  { valor: "operador", etiqueta: "Operador", plural: "operadores" },
];

export async function listWorkers(pointId?: string): Promise<Persona[]> {
  const q = pointId ? `?point_id=${encodeURIComponent(pointId)}` : "";
  const res = await fetch(`${BACKEND_URL}/resources/workers${q}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await parseErrorMessage(res, "No se pudo cargar el personal."));
  return res.json();
}

export async function createWorker(persona: PersonaInput): Promise<Persona> {
  const res = await fetch(`${BACKEND_URL}/resources/workers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(persona),
  });
  if (!res.ok) throw new Error(await parseErrorMessage(res, "No se pudo agregar a la persona."));
  return res.json();
}

export async function updateWorker(id: string, persona: PersonaInput): Promise<Persona> {
  const res = await fetch(`${BACKEND_URL}/resources/workers/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(persona),
  });
  if (!res.ok) throw new Error(await parseErrorMessage(res, "No se pudo guardar el cambio."));
  return res.json();
}

export async function deleteWorker(id: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/resources/workers/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await parseErrorMessage(res, "No se pudo quitar a la persona."));
}

/** Nombres repetidos entre las personas MARCADAS, normalizados.
 *
 *  Mismo criterio que las patentes de la flota, y aca ademas es necesario para
 *  el criterio: el AC2 se verifica comprobando que un nombre no aparezca en dos
 *  vehiculos del plan, y con dos filas llamadas igual esa comprobacion deja de
 *  poder hacerse. */
export function nombresRepetidos(personas: Persona[]): Set<string> {
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

/** Pone TODAS las unidades de un punto en el mismo estado, en UNA peticion.
 *
 *  Un bucle de 21 PATCH desde el cliente se siente lento, y en paralelo son 21
 *  escrituras compitiendo contra la misma coleccion. El backend lo resuelve con
 *  un update_many y devuelve la lista ya actualizada, asi la vista la reemplaza
 *  sin volver a pedirla. */
export async function setPointResourcesAvailability(
  pointId: string,
  disponible: boolean,
): Promise<Resource[]> {
  const res = await fetch(
    `${BACKEND_URL}/resources/points/${encodeURIComponent(pointId)}/disponibilidad`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ disponible }),
    },
  );
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo cambiar la disponibilidad."));
  }
  return res.json();
}

/** AC4 de HDU8. Endpoint propio y no un PUT completo: es la acción más
 *  frecuente de la vista (un camión entra y sale de taller), y con PUT habría
 *  que reenviar el recurso entero, con riesgo de pisar un campo que alguien más
 *  editó en el intervalo. */
export async function setResourceAvailability(id: string, disponible: boolean): Promise<Resource> {
  const res = await fetch(
    `${BACKEND_URL}/resources/units/${encodeURIComponent(id)}/disponibilidad`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ disponible }),
    },
  );
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo cambiar la disponibilidad."));
  }
  return res.json();
}

export async function deleteResource(id: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/resources/units/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo eliminar el recurso."));
  }
}

/** Campos que la familia del tipo hace relevantes. Una sola definición para el
 *  formulario, la lista y las validaciones: si cada lugar decidiera por su
 *  cuenta, el formulario podría pedir un campo que el backend rechaza. */
export function camposDeFamilia(familia: ResourceFamily): {
  capacidadCarga: boolean;
  capacidadPeso: boolean;
  autonomia: boolean;
  capacidadBalde: boolean;
  dotacion: boolean;
  motorizado: boolean;
} {
  return {
    // Los carros también declaran capacidad. Un CARRO RECICLAJE lleva 30 m³
    // según la municipalidad, así que esconderle el campo obligaba a guardar un
    // dato confirmado en un lugar donde nadie puede verlo ni corregirlo.
    //
    // Que la declare NO lo mete en las rutas: el ruteo filtra por familia
    // "carga" (ver capacidad_de_carga_por_punto en resources.py), y un carro
    // sigue siendo "arrastre". La familia dice cómo se mueve, no si carga.
    capacidadCarga: familia === "carga" || familia === "arrastre",
    capacidadPeso: familia === "carga" || familia === "arrastre",
    // Mas estricto que las capacidades: un carro remolcado no gasta
    // combustible propio.
    autonomia: familia === "carga",
    capacidadBalde: familia === "maquina",
    // Un carro se remolca: no lleva tripulación propia.
    dotacion: familia !== "arrastre",
    // Los carros de la flota real no declaran marca, modelo ni año.
    motorizado: familia !== "arrastre",
  };
}

/** Recurso vacío del tipo dado, para abrir el formulario ya coherente con su
 *  familia. Al cambiar de tipo hay que volver a pasar por acá: si quedara una
 *  capacidad de carga puesta y el tipo nuevo es una máquina, el backend
 *  responde 422 y el usuario no tiene forma de saber qué campo sobra. */
export function recursoVacio(tipo: string, pointId: string): ResourceInput {
  return {
    tipo,
    numero_equipo: "",
    patente: "",
    marca: "",
    modelo: "",
    anio: null,
    capacidad_m3: null,
    capacidad_ton: null,
    autonomia_km: null,
    capacidad_balde_m3: null,
    conductores_requeridos: 0,
    peonetas_requeridas: 0,
    operadores_requeridos: 0,
    observaciones: "",
    foto: null,
    disponible: true,
    point_id: pointId,
  };
}

/** Sube la foto de un recurso y devuelve el nombre con que quedó guardada.
 *
 *  Sin `Content-Type` a mano: con FormData el navegador tiene que poner el
 *  suyo, que incluye el `boundary` del multipart. Fijarlo rompe el parseo del
 *  lado del servidor. */
export async function uploadResourcePhoto(file: File): Promise<string> {
  const datos = new FormData();
  datos.append("file", file);
  const res = await fetch(`${BACKEND_URL}/resources/photo`, {
    method: "POST",
    credentials: "include",
    body: datos,
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "No se pudo subir la imagen."));
  }
  const { foto } = await res.json();
  return foto as string;
}
