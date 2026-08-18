import { cva } from "class-variance-authority";

// Separado de button.tsx: exportar una constante junto al componente ahí
// rompía el contrato de Fast Refresh de Vite (forzaba un full reload del
// programa entero en cada cambio de ese archivo, en vez de un hot-patch).
export const buttonVariants = cva(
  // Base: transition-all para animar transform + colores, active scale para feedback físico de clic
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-35 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.97] active:brightness-95",
  {
    variants: {
      variant: {
        // Primary: hover lift con spring y glow de color del tema
        default:
          "bg-primary text-primary-foreground shadow hover:bg-primary/90 hover:-translate-y-0.5 hover:shadow-[0_6px_20px_-4px_var(--primary-glow)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 hover:-translate-y-0.5 hover:shadow-[0_4px_16px_-4px_rgba(0,0,0,0.3)]",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground hover:-translate-y-0.5",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 hover:-translate-y-0.5",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);
