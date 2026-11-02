// =============================================================================
// CONDORFINDER, MAPA DE UNA RUTA GUARDADA
// Archivo: src/components/MapaDeRuta.tsx
//
// El trazo de un plan que ya se generó, para el detalle del historial.
//
// -----------------------------------------------------------------------------
// NO CONSULTA NINGÚN SERVICIO DE RUTAS
// -----------------------------------------------------------------------------
// Cada plan guarda su geometría completa al generarse (ver `route_plans.py`), y
// este componente dibuja exactamente eso. Abrir una ruta del historial no llama
// a OSRM ni a Google Routes, que es el motivo por el que la geometría se guarda
// en vez de recalcularse: repetirla cuesta una llamada al proveedor, y con
// Google se cobra contra una cuota diaria. Un historial que gasta cuota al
// abrirse no es un historial.
//
// Lo único que se pide es el mapa base. Con Leaflet son los tiles de
// OpenStreetMap, que son gratis; con el motor de Google es una carga de mapa
// (ver `GeoMap.tsx`), que es otro SKU y otro cupo, y que se paga una vez por
// abrir el detalle, no por cada ruta del listado.
//
// Reutiliza `GeoMap` y `RouteLegend` sin tocarlos: el mapa de `/rutas` y este
// dibujan el trazo con el mismo código, así que no pueden verse distintos.
// =============================================================================

import { useMemo } from "react";

import { GeoMap, type GeoMapPoint } from "@/components/GeoMap";
import { RouteLegend } from "@/components/RouteLegend";
import { RELLENO_SANITARIO } from "@/lib/disposalSite";
import type { PlanDibujable } from "@/lib/routePlans";

type Trazo = [number, number][];

/** El nombre del punto sin el sufijo de convoy: el punto de origen es UNO, y
 *  rotularlo "(convoy 1)" en el mapa diría que hay dos patios. */
const sinConvoy = (nombre: string) => nombre.replace(/\s*\(convoy \d+\)\s*$/i, "");

export function MapaDeRuta({ plan }: { plan: PlanDibujable }) {
  const datos = useMemo(() => {
    const ida = (plan.outboundPaths ?? []) as Trazo[];
    const traslados = (plan.transferPaths ?? []) as Trazo[];
    const descarga = (plan.disposalPaths ?? []) as Trazo[];
    const regreso = (plan.returnPaths ?? []) as Trazo[];

    // **Un marcador por LUGAR, no por visita.** Una zona que se visita tres
    // veces tiene tres paradas en la misma coordenada: dibujarlas todas apila
    // tres gotas idénticas y el tooltip del de arriba tapa a los otros.
    const vistos = new Set<string>();
    const puntos: GeoMapPoint[] = [];
    for (const s of plan.stops ?? []) {
      const clave = `${s.kind ?? "analysis"}:${s.stopId ?? s.order}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      puntos.push({
        id: `parada-${s.order}`,
        position: [s.lat, s.lng],
        label: s.label,
        // Un punto diario y uno permanente se dibujan distinto, igual que en el
        // mapa de `/rutas`: es parte de lo que el marcador significa.
        kind: s.kind === "punto_diario" ? "diario" : "zona",
      });
    }

    // El patio de salida de cada recorrido. El plan no guarda sus coordenadas
    // aparte, pero el regreso termina exactamente ahí (`returnPaths` trae un
    // trazo por recorrido), así que se lee de su último vértice. Deduplicado por
    // coordenada: dos convoyes salen del MISMO patio.
    const origenes = new Set<string>();
    (plan.segments ?? []).forEach((seg, i) => {
      const trazo = regreso[i];
      const fin = trazo && trazo.length > 0 ? trazo[trazo.length - 1] : null;
      if (!fin) return;
      const clave = `${fin[0].toFixed(5)},${fin[1].toFixed(5)}`;
      if (origenes.has(clave)) return;
      origenes.add(clave);
      puntos.push({
        id: `origen-${i}`,
        position: fin,
        label: sinConvoy(seg.originName),
        kind: "origen",
      });
    });

    const hayGeometria = ida.length > 0 || descarga.length > 0 || regreso.length > 0;

    // El encuadre abarca TODO lo dibujado, relleno incluido: queda al poniente,
    // lejos de las zonas, y sin él el marcador existía y no se veía.
    const encuadre: Trazo = hayGeometria
      ? [
          ...ida.flat(),
          ...traslados.flat(),
          ...descarga.flat(),
          ...regreso.flat(),
          RELLENO_SANITARIO.position,
        ]
      : [...puntos.map((p) => p.position), RELLENO_SANITARIO.position];

    return {
      puntos,
      ida,
      traslados,
      descarga,
      regreso,
      hayGeometria,
      encuadre,
      // Sin geometría real (un plan muy viejo) se une las paradas con una línea
      // recta, que es lo que `/rutas` hacía antes de tener calles. Es lo único
      // honesto: inventar un recorrido por calles sin haberlo calculado no.
      recta: hayGeometria ? null : ((plan.stops ?? []).map((s) => [s.lat, s.lng]) as Trazo),
    };
  }, [plan]);

  if (datos.puntos.length === 0 && !datos.hayGeometria) return null;

  return (
    <div className="map-frame relative h-[26rem] overflow-hidden">
      <GeoMap
        className="h-full w-full"
        points={datos.puntos}
        disposalSite={RELLENO_SANITARIO}
        routePositions={datos.recta}
        outboundPaths={datos.hayGeometria ? datos.ida : null}
        transferPaths={datos.hayGeometria ? datos.traslados : null}
        disposalPaths={datos.hayGeometria ? datos.descarga : null}
        returnPaths={datos.hayGeometria ? datos.regreso : null}
        fitBoundsTo={datos.encuadre}
      />
      {/* La leyenda solo con trazo por calles: sin él explicaría colores que no
          están en pantalla. */}
      {datos.hayGeometria && <RouteLegend />}
    </div>
  );
}
