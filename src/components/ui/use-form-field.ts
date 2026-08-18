import * as React from "react";
import { useFormContext } from "react-hook-form";

import { FormFieldContext, FormItemContext } from "./form-context";

// Separado de form.tsx: exportar este hook junto a los componentes de ese
// archivo rompía el contrato de Fast Refresh de Vite (forzaba un full
// reload del programa entero en cada cambio, en vez de un hot-patch).
export const useFormField = () => {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
  const { getFieldState, formState } = useFormContext();

  if (!fieldContext) {
    throw new Error("useFormField should be used within <FormField>");
  }

  if (!itemContext) {
    throw new Error("useFormField should be used within <FormItem>");
  }

  const fieldState = getFieldState(fieldContext.name, formState);

  const { id } = itemContext;

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    ...fieldState,
  };
};
