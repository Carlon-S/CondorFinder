// =============================================================================
// CONDORFINDER, LEYENDA DEL TRAZO
// Archivo: src/components/RouteLegend.tsx
//
// Qué significa cada color del recorrido dibujado.
//
// Existe porque los cuatro tramos pasaron a tener cuatro colores propios, y sin
// una clave eso es decoración: nada en pantalla decía que el azul era la salida
// del patio ni que el magenta era la vuelta. Se probó poner el color al lado de
// cada fila de la línea de tiempo y se descartó: ahí la clave queda repartida en
// un panel que hace scroll, así que para decodificar un trazo del mapa había que
// buscar la fila correspondiente, que es justo el trabajo que una leyenda ahorra.
//
// Va DENTRO del marco del mapa, abajo a la izquierda: pertenece al dibujo, no al
// panel, y arriba a la derecha ya está el botón de centrar en Maipú.
//
// Los colores salen de route-colors.ts, los mismos literales que los motores
// pasan al renderer. Acá son estilos en línea y no clases de Tailwind porque no
// existen como tokens del tema: son colores del trazo, no de la interfaz.
// =============================================================================

import {
  ROUTE_DISPOSAL_COLOR,
  ROUTE_OUTBOUND_COLOR,
  ROUTE_RETURN_COLOR,
  ROUTE_TRANSFER_COLOR,
} from "@/components/route-colors";

const TRAMOS = [
  { color: ROUTE_OUTBOUND_COLOR, texto: "Ida" },
  { color: ROUTE_TRANSFER_COLOR, texto: "Transición" },
  { color: ROUTE_DISPOSAL_COLOR, texto: "Al relleno" },
  { color: ROUTE_RETURN_COLOR, texto: "Regreso" },
] as const;

export function RouteLegend() {
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-[550] rounded-lg border border-border/60 bg-background/90 px-3 py-2.5 shadow-md backdrop-blur">
      <p className="mb-1.5 text-[0.625rem] font-semibold uppercase tracking-wide text-muted-foreground">
        Tramos
      </p>
      <ul className="space-y-1">
        {TRAMOS.map((t) => (
          <li key={t.texto} className="flex items-center gap-2">
            {/* Un trazo y no un cuadrado: lo que identifica es una línea sobre
                el mapa, y su grosor es el mismo que el del trazo real. */}
            <span
              aria-hidden="true"
              className="h-[3px] w-5 flex-shrink-0 rounded-full"
              style={{ backgroundColor: t.color }}
            />
            <span className="text-[0.6875rem] text-foreground">{t.texto}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
