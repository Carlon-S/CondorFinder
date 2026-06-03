# Routes

TanStack Start uses **file-based routing**. Every `.tsx` file in this directory
is a route. Do **not** create `src/pages/`, `src/routes/_app/index.tsx`, or
`app/layout.tsx` — those are Next.js / Remix conventions. The only root layout
is `src/routes/__root.tsx`.

## Conventions

| File                     | URL                                                     |
| ------------------------ | ------------------------------------------------------- |
| `index.tsx`              | `/`                                                     |
| `analysis.tsx`           | `/analysis`                                             |
| `about.tsx`              | `/about`                                                |
| `users/index.tsx`        | `/users`                                                |
| `users/$id.tsx`          | `/users/:id` (dynamic — bare `$`, no curly braces)      |
| `posts/{-$category}.tsx` | `/posts/:category?` (optional segment)                  |
| `files/$.tsx`            | `/files/*` (splat — read via `_splat` param, never `*`) |
| `_layout.tsx`            | layout route (renders children via `<Outlet />`)        |
| `__root.tsx`             | app shell — wraps every page; preserve `<Outlet />`     |

`routeTree.gen.ts` is auto-generated. Don't edit it by hand.

## CondorFinder PMV routes

| Route       | Purpose                                                                           | Status                                       |
| ----------- | --------------------------------------------------------------------------------- | -------------------------------------------- |
| `/`         | HDU1: carga de imagenes JPG, validacion y generacion simulada del mapa unificado. | Frontend implementado, backend pendiente.    |
| `/analysis` | HDU2: analisis simulado de volumen por poligono y resumen total.                  | Frontend simulado, modelo/backend pendiente. |
