import { ChevronDown } from "@/components/icons/Icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Una opción del filtro.
 *
 * `conteo` es opcional porque no todos los filtros pueden contar sin recorrer
 * datos que la vista no tiene a mano. Cuando está, convierte cada opción en un
 * dato y no solo en un rótulo: "Sin vuelo (46)" dice cuánto trabajo falta
 * antes de elegirla.
 */
export interface OpcionFiltro<T extends string> {
  valor: T;
  etiqueta: string;
  conteo?: number;
}

/**
 * El filtro por estado de una tabla, igual en todo el sistema.
 *
 * **Un componente y no una copia por vista.** Había cuatro tablas filtrando por
 * estado con tres implementaciones distintas: botones en una píldora redonda en
 * Vista Principal y un control segmentado en las dos de recursos, cada uno con
 * sus propios colores de activo. Cuatro versiones del mismo control son cuatro
 * lugares donde el siguiente arreglo se aplica en tres.
 *
 * Decisiones que vienen de las reglas de diseño de menús desplegables:
 *
 * - **El rótulo se ve siempre, también cerrado** ("Estado: Con análisis"). Un
 *   desplegable que solo muestra el valor obliga a abrirlo para saber de qué
 *   se está filtrando.
 * - **La opción elegida se marca**, con su punto y con fondo, no solo con
 *   color: un cambio de color sobre el mismo dibujo se pierde a 14 px.
 * - **El caret rota al abrir**, así los estados abierto y cerrado se
 *   distinguen sin depender del color.
 * - **La animación es de 150 ms.** Por encima de 200 ms un desplegable se
 *   siente lento, y este se usa muchas veces por sesión.
 * - Teclado y lectores de pantalla los resuelve Radix: flechas, Enter, Escape,
 *   Tab y el anuncio del cambio de selección.
 *
 * **Divergencia anotada respecto de la referencia**: esa guía recomienda no
 * usar un desplegable con menos de cinco opciones y dejar botones. Los filtros
 * de recursos tienen tres, y aun así van en desplegable, porque la
 * consistencia entre las cuatro tablas pesa más acá: con dos controles
 * distintos según la tabla, el trabajador tiene que reaprender dónde está el
 * filtro en cada vista. El de Vista Principal, con seis, sí entra en la regla.
 */
export function FiltroDropdown<T extends string>({
  etiqueta,
  valor,
  opciones,
  onCambio,
  className = "",
}: {
  /** Qué se está filtrando, visible también con el menú cerrado. */
  etiqueta: string;
  valor: T;
  opciones: OpcionFiltro<T>[];
  onCambio: (valor: T) => void;
  className?: string;
}) {
  const elegida = opciones.find((o) => o.valor === valor);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={`group flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2.5 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${className}`}
        aria-label={`Filtrar por ${etiqueta.toLowerCase()}`}
      >
        <span className="text-muted-foreground">{etiqueta}:</span>
        <span className="font-medium text-foreground">
          {elegida?.etiqueta ?? "-"}
          {elegida?.conteo != null && (
            <span className="mono ml-1 tabular-nums text-muted-foreground">
              ({elegida.conteo})
            </span>
          )}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-[11rem]">
        <DropdownMenuRadioGroup value={valor} onValueChange={(v) => onCambio(v as T)}>
          {opciones.map((o) => (
            <DropdownMenuRadioItem
              key={o.valor}
              value={o.valor}
              className="cursor-pointer text-xs data-[state=checked]:bg-accent/60"
            >
              <span className="flex-1">{o.etiqueta}</span>
              {o.conteo != null && (
                <span className="mono ml-3 tabular-nums text-muted-foreground">{o.conteo}</span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
