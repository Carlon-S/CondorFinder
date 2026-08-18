// Única fuente de BACKEND_URL para todo src/lib — antes cada archivo
// redefinía su propio "http://localhost:8000", así que apuntar el
// frontend a un backend desplegado (VM en la nube) significaba editar 6
// archivos. VITE_BACKEND_URL se define en un .env en la raíz del repo (no
// es secreto, es solo la IP pública del backend); sin ese archivo, sigue
// apuntando a localhost:8000 para desarrollo 100% local.
export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8000";
