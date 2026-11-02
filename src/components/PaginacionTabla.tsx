// =============================================================================
// CONDORFINDER, BARRA DE PAGINACIÓN DE UNA TABLA
// Archivo: src/components/PaginacionTabla.tsx
//
// "Mostrando 1-8 de 14", Anterior, los números de página y Siguiente. Es la
// barra de las tablas de recursos y del historial, sacada a un componente para
// que Vista Principal la use también: con la suya propia (solo "1 / 3" y dos
// flechas) las tablas del sistema se paginaban de tres maneras distintas.
//
// **Va SIEMPRE, incluso con una sola página.** Apareciendo solo cuando sobran
// filas, cambiaba el alto de la tarjeta al filtrar, justo cuando se está
// mirando el resultado. Con una página los botones quedan deshabilitados, que
// ya dice que no hay a dónde ir.
//
// Las páginas se cuentan desde 1 (lo que el usuario lee). Quien pagina desde 0
// convierte en el borde.
// =============================================================================

import { Button } from "@/components/ui/button";

export function PaginacionTabla({
  pagina,
  totalPaginas,
  desde,
  hasta,
  total,
  onCambiar,
  etiqueta = "",
}: {
  /** Página actual, desde 1. */
  pagina: number;
  totalPaginas: number;
  /** Primer y último elemento mostrados, desde 1. `desde` es 0 si no hay nada. */
  desde: number;
  hasta: number;
  total: number;
  onCambiar: (pagina: number) => void;
  /** Texto tras el total, por ejemplo "de 54 zonas". Vacío por omisión. */
  etiqueta?: string;
}) {
  return (
    <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
      <p className="text-xs text-muted-foreground">
        Mostrando{" "}
        <span className="mono tabular-nums text-foreground">
          {desde}-{hasta}
        </span>{" "}
        de <span className="mono tabular-nums text-foreground">{total}</span>
        {etiqueta && ` ${etiqueta}`}
      </p>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="secondary"
          disabled={pagina <= 1}
          onClick={() => onCambiar(pagina - 1)}
        >
          Anterior
        </Button>
        {Array.from({ length: totalPaginas }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onCambiar(n)}
            aria-current={n === pagina ? "page" : undefined}
            className={`mono h-8 w-8 cursor-pointer rounded-md text-xs tabular-nums transition-colors ${
              n === pagina
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {n}
          </button>
        ))}
        <Button
          size="sm"
          variant="secondary"
          disabled={pagina >= totalPaginas}
          onClick={() => onCambiar(pagina + 1)}
        >
          Siguiente
        </Button>
      </div>
    </div>
  );
}
