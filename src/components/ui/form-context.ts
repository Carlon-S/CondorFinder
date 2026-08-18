import * as React from "react";
import type { FieldPath, FieldValues } from "react-hook-form";

// Separado de form.tsx: estos contexts los usan tanto los componentes
// (FormField/FormItem) como el hook useFormField (ahora en
// use-form-field.ts) — factorizarlos acá evita que ninguno de esos dos
// archivos tenga que mezclar un export no-componente junto a componentes,
// que rompe el contrato de Fast Refresh de Vite.

export type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = {
  name: TName;
};

export const FormFieldContext = React.createContext<FormFieldContextValue | null>(null);

export type FormItemContextValue = {
  id: string;
};

export const FormItemContext = React.createContext<FormItemContextValue | null>(null);
