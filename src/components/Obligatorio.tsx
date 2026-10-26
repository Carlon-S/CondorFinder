// =============================================================================
// CONDORFINDER, MARCA DE CAMPO OBLIGATORIO
// Archivo: src/components/Obligatorio.tsx
//
// El asterisco que distingue un campo que hay que llenar de uno opcional.
//
// Es un componente y no un carácter escrito a mano en cada rótulo por dos
// razones. El color sale del tema en un solo lugar, así que no aparecen tres
// rojos distintos; y lleva `aria-hidden` con un texto alternativo, porque un
// asterisco suelto un lector de pantalla lo lee como "asterisco" y no dice
// nada sobre que el campo sea obligatorio.
// =============================================================================

export function Obligatorio() {
  return (
    <>
      <span aria-hidden="true" className="text-destructive-strong">
        *
      </span>
      <span className="sr-only">(obligatorio)</span>
    </>
  );
}
