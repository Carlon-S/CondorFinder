// =============================================================================
// CONDORFINDER, ENCABEZADO DE COLUMNA ORDENABLE
// Archivo: src/components/SortableHead.tsx
//
// Extraído de index.tsx cuando la tabla de recursos necesitó el mismo
// comportamiento. Es genérico en el campo (`T`) para que cada tabla declare sus
// propias claves de orden sin castear nada.
//
// El indicador se dibuja SIEMPRE, en los tres estados, y lo que cambia es su
// opacidad y su color. Antes aparecía solo en la columna activa, y como las
// tablas usan el ancho automático del navegador, la flecha entrando y saliendo
// cambiaba el ancho del encabezado: ordenar corría las columnas de lugar. Que
// el espacio esté reservado es lo que lo deja quieto, y de paso el indicador
// atenuado al pasar el cursor avisa que la columna se puede ordenar, algo que
// antes no se anunciaba en ninguna parte.
//
// Lo clickeable es un <button> dentro del <th>, no el <th> mismo: una celda no
// recibe foco, así que con el onClick puesto ahí ordenar era imposible con
// teclado. Y el <th> lleva aria-sort, que es lo que anuncia el orden vigente a
// un lector de pantalla.
// =============================================================================

import { ChevronDown, ChevronUp } from "lucide-react";
import { TableHead } from "@/components/ui/table";

export function SortableHead<T extends string>({
  field,
  label,
  unit,
  sortBy,
  sortDir,
  onSort,
  align,
  className,
}: {
  field: T;
  label: string;
  /** Unidad de la columna, al lado del nombre y no repetida en cada celda.
   *  Repetida por fila aparece tantas veces como filas haya y separa las cifras
   *  de su propia columna, que es justo lo que hace comparable una tabla. Va en
   *  .mono, como toda unidad en el sistema. */
  unit?: string;
  sortBy: T;
  sortDir: "asc" | "desc";
  onSort: (field: T) => void;
  align?: "right" | "center";
  className?: string;
}) {
  const active = sortBy === field;
  const justify =
    align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";
  const texto =
    align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";

  return (
    <TableHead
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      className={`select-none p-0 ${texto} ${className ?? ""}`}
    >
      {/* Nombre y unidad van dentro de UN solo hijo del flex: con
          flex-row-reverse (columnas alineadas a la derecha) el orden visual se
          invierte, y como dos hijos sueltos quedaban como "(m³) Volumen". */}
      <button
        type="button"
        onClick={() => onSort(field)}
        title={`Ordenar por ${label.toLowerCase()}`}
        className={`group flex h-10 w-full cursor-pointer items-center gap-1 px-2 transition-colors hover:text-foreground ${justify} ${
          align === "right" ? "flex-row-reverse" : ""
        }`}
      >
        <span className="whitespace-nowrap">
          {label}
          {unit && <span className="mono ml-1 opacity-70">({unit})</span>}
        </span>
        {/* Los dos íconos ocupan la misma caja. El inactivo no se oculta con un
            condicional, se atenúa: montarlo y desmontarlo es lo que movía la
            columna. */}
        {active ? (
          sortDir === "asc" ? (
            <ChevronUp className="h-3 w-3 flex-shrink-0 text-primary" />
          ) : (
            <ChevronDown className="h-3 w-3 flex-shrink-0 text-primary" />
          )
        ) : (
          <ChevronDown
            aria-hidden="true"
            className="h-3 w-3 flex-shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-60"
          />
        )}
      </button>
    </TableHead>
  );
}
