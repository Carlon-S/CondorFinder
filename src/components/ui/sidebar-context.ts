import * as React from "react";

// Separado de sidebar.tsx: exportar este hook junto a los componentes de
// ese archivo rompía el contrato de Fast Refresh de Vite (forzaba un full
// reload del programa entero en cada cambio, en vez de un hot-patch).

export type SidebarContextProps = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

export const SidebarContext = React.createContext<SidebarContextProps | null>(null);

export function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}
