// =============================================================================
// CONDORFINDER — LEYENDA DEL MAPA
// Archivo: src/components/MapLegend.tsx
//
// Qué representa cada marcador. Con cinco clases de pin en pantalla (zona
// medida, zona sin vuelo, punto de origen, retiro del día y relleno sanitario)
// más la escala de colores de los recorridos, el mapa dejó de poder explicarse
// solo: el glifo y el color distinguen un marcador de otro, pero no dicen QUÉ es
// cada uno la primera vez que alguien abre la vista.
//
// -----------------------------------------------------------------------------
// POR QUÉ VIVE ACÁ Y NO DENTRO DE UNA IMPLEMENTACIÓN DE MAPA
// -----------------------------------------------------------------------------
// Hay DOS motores (Leaflet y Google) y cuál corre lo decide una variable de
// entorno. Una leyenda escrita dentro de uno se habría quedado sin actualizar en
// el otro, y la divergencia aparecería recién en producción. Pero además no
// necesita nada del motor: es una lista de dibujos sobre el marco del mapa, así
// que se dibuja POR ENCIMA, como hermana del mapa, y los dos motores la heredan
// sin saber que existe. Mismo criterio que `map-pins.ts` y `route-colors.ts`.
//
// Los dibujos salen de `map-pins.ts`, o sea de la misma fuente que los
// marcadores reales. Es la parte que importa: una leyenda con sus propios
// dibujos es una leyenda que miente en cuanto alguien cambia un pin.
// =============================================================================

import { useState } from "react";
import { ChevronDown } from "@/components/icons/Icons";
import {
  COLOR_DIARIO,
  COLOR_ORIGEN,
  COLOR_SIN_VUELO,
  COLOR_ZONA_MEDIDA,
  DISPOSAL_PIN,
  GLIFO_DIARIO,
  GLIFO_MEDIDA,
  GLIFO_ORIGEN,
  GLIFO_SIN_DATO,
  PIN_GOTA,
} from "@/components/map-pins";

/** Una gota de leyenda, al tamaño de la lista y no al del mapa. */
function Gota({ glifo, color }: { glifo: string; color: string }) {
  return (
    <svg viewBox="0 0 256 256" className="h-4 w-4 flex-shrink-0" aria-hidden="true">
      <path d={PIN_GOTA} fill={color} />
      <path d={glifo} fill="#fff" />
    </svg>
  );
}

/** La placa del relleno, que no es una gota: es infraestructura fija. */
function Placa() {
  return (
    <span
      className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full"
      style={{ background: "var(--disposal)" }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 256 256" className="h-2.5 w-2.5" fill="#fff">
        <path d={DISPOSAL_PIN} />
      </svg>
    </span>
  );
}

interface Fila {
  icono: React.ReactNode;
  texto: string;
}

/** Qué clases de marcador puede mostrar cada vista.
 *
 *  `/rutas` muestra las cinco; `/recursos` no dibuja retiros del día ni el
 *  relleno, y mostrarlos ahí prometería marcadores que esa pantalla no tiene. */
export type AlcanceLeyenda = "rutas" | "recursos";

function filasDe(alcance: AlcanceLeyenda): Fila[] {
  const comunes: Fila[] = [
    {
      icono: <Gota glifo={GLIFO_MEDIDA} color={COLOR_ZONA_MEDIDA} />,
      texto: "Zona con vuelo (volumen medido)",
    },
    {
      icono: <Gota glifo={GLIFO_SIN_DATO} color={COLOR_SIN_VUELO} />,
      texto: "Zona sin vuelo (sin medición)",
    },
    {
      icono: <Gota glifo={GLIFO_ORIGEN} color={COLOR_ORIGEN} />,
      texto: "Punto de origen de la flota",
    },
  ];
  if (alcance === "recursos") return comunes;
  return [
    ...comunes,
    { icono: <Gota glifo={GLIFO_DIARIO} color={COLOR_DIARIO} />, texto: "Retiro del día" },
    { icono: <Placa />, texto: "Relleno sanitario" },
    {
      // Las zonas EN la ruta se pintan con el color de su recorrido, así que la
      // leyenda no puede nombrar un color: nombra la regla.
      icono: (
        <span className="flex gap-0.5" aria-hidden="true">
          <Gota glifo={GLIFO_MEDIDA} color="#7c3aed" />
        </span>
      ),
      texto: "En la ruta: color de su recorrido",
    },
  ];
}

/** La leyenda, plegable y plegada por omisión.
 *
 *  **Plegada**, porque el mapa es el contenido y una tarjeta fija de seis filas
 *  le come una esquina a quien ya sabe leer los marcadores. Abierta se queda
 *  abierta mientras la vista viva, así que leerla una vez no cuesta nada
 *  después. Va abajo a la izquierda: arriba a la izquierda está el panel del
 *  plan, abajo a la derecha el control de zoom de Leaflet, y arriba a la derecha
 *  los controles de Google. */
export function MapLegend({ alcance = "rutas" }: { alcance?: AlcanceLeyenda }) {
  const [abierta, setAbierta] = useState(false);
  const filas = filasDe(alcance);

  // `z-[800]` es el nivel de los CONTROLES de Leaflet. Sus capas llegan hasta
  // 700 (tiles 200, overlays 400, marcadores 600, tooltips 650, popups 700), así
  // que con un z menor la leyenda quedaba debajo de los propios pines que
  // explica. Y bien debajo de los 1100 de `DialogContent`, para no taparle un
  // diálogo.
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-[800]">
      <div className="pointer-events-auto overflow-hidden rounded-md border border-border/60 bg-card/95 shadow-md backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setAbierta((v) => !v)}
          aria-expanded={abierta}
          className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-accent"
        >
          Leyenda
          <ChevronDown
            className={`h-3 w-3 text-muted-foreground transition-transform duration-150 ${
              abierta ? "rotate-180" : ""
            }`}
          />
        </button>
        {abierta && (
          <ul className="space-y-1 border-t border-border/50 px-2.5 py-2">
            {filas.map((f) => (
              <li
                key={f.texto}
                className="flex items-center gap-2 text-[0.625rem] leading-tight text-muted-foreground"
              >
                {f.icono}
                <span>{f.texto}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
