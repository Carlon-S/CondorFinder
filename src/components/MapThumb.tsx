// =============================================================================
// CONDORFINDER, MINIATURA DE UN LUGAR
// Archivo: src/components/MapThumb.tsx
//
// La imagen de dónde queda un punto, para la lista de puntos.
//
// NO es una foto de la dirección. Una foto de calle sale de Street View, cuya
// API estática cobra por petición y exige una cuenta con facturación; la otra
// fuente libre (Mapillary) pide token y en Maipú tiene cobertura parcial, así
// que la mitad de los puntos quedaría sin imagen y sin forma de saber por qué.
// Esto es una vista de mapa del lugar, con los MISMOS tiles de OpenStreetMap
// que ya carga el mapa grande de la vista: sin llave, sin dependencia nueva y
// sin cuota.
//
// Tampoco monta un Leaflet por fila. Son imágenes sueltas: cuatro <img> y algo
// de aritmética. Cinco mapas de Leaflet en una tabla son cinco instancias con
// sus listeners y su capa de tiles, y la fila de una tabla no necesita nada de
// eso, no se hace zoom ni se arrastra.
// =============================================================================

const ZOOM = 16;
const TILE_PX = 256;
const TILES_URL = "https://tile.openstreetmap.org";

/** Coordenadas de tile (fraccionarias) según la proyección Web Mercator, que es
 *  la que usan los tiles de OSM. La parte entera dice qué tile, la decimal
 *  dónde cae el punto dentro de él. */
function aTile(lat: number, lng: number, z: number) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    x: ((lng + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  };
}

/**
 * Miniatura centrada exactamente en lat/lng.
 *
 * Carga un bloque de 2x2 tiles y lo desplaza para que el punto quede al medio.
 * Con UN solo tile bastaría una petición, pero el punto cae donde caiga dentro
 * de él y un punto pegado al borde se ve como una imagen equivocada. Con el
 * bloque de cuatro, el punto siempre queda en la mitad central y el encuadre no
 * depende de dónde haya partido la grilla.
 *
 * Las medidas de acá van en px y no en rem a propósito: son píxeles de imagen,
 * la unidad en la que está definida la grilla de tiles. Convertirlas a rem las
 * escalaría con el tamaño de fuente y el punto dejaría de caer donde debe. El
 * tamaño de la CAJA sí lo pone quien la usa, con clases.
 */
export function MapThumb({
  lat,
  lng,
  className = "",
  muted = false,
}: {
  lat: number;
  lng: number;
  className?: string;
  muted?: boolean;
}) {
  const { x, y } = aTile(lat, lng, ZOOM);
  // Tile superior izquierdo del bloque: el que deja el punto en el cuadrante
  // central. Así la posición del punto dentro del bloque queda siempre entre un
  // cuarto y tres cuartos.
  const tx0 = Math.floor(x - 0.5);
  const ty0 = Math.floor(y - 0.5);
  const px = (x - tx0) * TILE_PX;
  const py = (y - ty0) * TILE_PX;

  return (
    <div
      className={`relative overflow-hidden bg-muted ${muted ? "opacity-50 grayscale" : ""} ${className}`}
      title="Ubicación del punto. Mapa © colaboradores de OpenStreetMap"
    >
      {/* El bloque se posiciona por su desplazamiento respecto al centro de la
          caja, sin necesidad de saber cuánto mide la caja. */}
      <div
        className="absolute"
        style={{
          left: `calc(50% - ${px}px)`,
          top: `calc(50% - ${py}px)`,
          width: TILE_PX * 2,
          height: TILE_PX * 2,
        }}
      >
        {[0, 1].map((dy) =>
          [0, 1].map((dx) => (
            <img
              key={`${dx}-${dy}`}
              src={`${TILES_URL}/${ZOOM}/${tx0 + dx}/${ty0 + dy}.png`}
              alt=""
              aria-hidden="true"
              loading="lazy"
              draggable={false}
              className="absolute max-w-none select-none"
              style={{ left: dx * TILE_PX, top: dy * TILE_PX, width: TILE_PX, height: TILE_PX }}
            />
          )),
        )}
      </div>

      {/* El punto exacto. Va al centro por construcción, así que no necesita
          medirse nada. */}
      <span
        className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary shadow"
        aria-hidden="true"
      />
    </div>
  );
}
