// =============================================================================
// CONDORFINDER, SITIO DE DISPOSICIÓN FINAL
// Archivo: src/lib/disposalSite.ts
//
// Dónde termina el residuo que se retira de un microbasural.
//
// La Municipalidad de Maipú lo confirmó por escrito el 30-09-2026, respondiendo
// a la pregunta de dónde descarga el camión después de cargar:
//
//   "Se descarga en el Relleno Sanitario Santiago Poniente. Dependiendo de la
//    ruta asignada, el camión debe volver a concluirla, o bien, llegar a la base
//    si concluye el turno o la hora de colación."
//
// Esa respuesta cambió el modelo de ruta de forma estructural. El sistema
// calcula hoy base -> zonas -> base, y lo real es
// base -> zonas -> relleno -> vuelve a la ruta -> base, con viajes intermedios
// cada vez que el camión se llena. Mientras ese cambio no esté hecho en
// `routing.py`, el sitio al menos se DIBUJA, para que quien mire el mapa vea a
// dónde va el material y entienda por qué los tiempos del plan no son los
// definitivos.
//
// ── Por qué es una constante y no un dato ──
// Debería ser un punto de recursos más, con su propio registro, igual que el
// patio desde donde sale la flota: hoy hay un solo relleno, pero nada garantiza
// que mañana no haya dos, o que cambie. Se deja fijo porque convertirlo en dato
// implica tocar el modelo de puntos y eso es alcance de HDU5.1, no de dibujar un
// marcador. Cuando se haga, esta constante se borra y el sitio pasa a ser un
// `resource_point` con su tipo.
// =============================================================================

export interface DisposalSite {
  name: string;
  /** [lat, lng] en WGS84, igual que el resto de los puntos del mapa. */
  position: [number, number];
}

export const RELLENO_SANITARIO: DisposalSite = {
  name: "Relleno Sanitario Santiago Poniente",
  position: [-33.521018456153946, -70.86714285793538],
};
