# Unificación de puntos y zonas: entrada a HDU5.2

> ## ⚠️ DOCUMENTO SUPERADO, NO ES LA FUENTE
>
> Escrito el 2026-10-26 **antes** de que el equipo tomara las decisiones. Se conserva solo como registro de cómo estaba planteado el problema; **no describe el plan vigente** y varias cosas que dice ya no valen:
>
> - Decía que la pieza 3.5 estaba sin resolver y ofrecía **tres opciones para el volumen de un punto que nadie midió**. Esa pregunta **ya no existe**: se decidió que solo entran a una ruta las paradas con datos, así que no hay que estimar nada.
> - No tiene las 18 decisiones acordadas, ni los 8 criterios de aceptación redactados, ni el reparto en Fase 0 / Fase 1 / Fase 2.
> - La **Fase 0 está cerrada y verificada en producción** (28-10-2026), con AC1 y AC8 cumplidos.
>
> **El plan vigente vive fuera del repositorio**, por decisión del usuario: `CondorFinder - Plan HDU5.2.md`, en la carpeta `Feria`. Un resumen con el orden de la Fase 1 está en `CLAUDE.md`, en "Current project status".

---

## 1. El problema

Hoy conviven **dos caminos** para que un lugar exista en el sistema, y producen objetos que se comportan distinto aunque vivan en la misma colección de Mongo (`zones`).

| | Nace de un vuelo | Nace a mano (HDU14) |
|---|---|---|
| Cómo se crea | Efecto secundario de guardar un análisis (`analyses.py::_resolve_zone`) | `POST /analyses/zones` |
| Qué trae | `orthoCenter`, `orthoBounds`, versiones, análisis | dirección, barrio, tipo, frecuencia, `lat`/`lng` |
| Dónde se ve | Vista Principal, `/rutas`, informes, evolución | Vista Principal (filtro "Sin vuelo"), Itinerario |
| ¿Entra a una ruta? | Sí | **No** |
| `kind` | `basural` (o ausente) | `permanente` |

**La causa de fondo**: el vuelo no sabe a qué lugar pertenece hasta que alguien guarda el análisis. De ahí salen los huérfanos, y de ahí sale que HDU7 tenga que existir para reparar después lo que se pudo evitar antes.

## 2. La decisión de fondo

**El lugar existe primero; el vuelo se le cuelga.** No al revés.

Esto parece contradecir la premisa del producto (descubrir basurales volando un dron) y no lo hace: **el dron siempre se vuela sobre un lugar que alguien eligió de antemano**. Lo que el pipeline descubre es cuánta basura hay y dónde exactamente *dentro* de ese terreno, no el terreno.

Registrar el punto antes de volarlo es el orden natural del trabajo, y además es el orden en que la municipalidad ya tiene sus datos: su planilla de 54 puntos permanentes existe desde mucho antes que cualquier vuelo.

## 3. Las cinco piezas

### 3.1 El vuelo declara su punto antes de subir imágenes

En `/carga`, antes de las imágenes, se elige el punto permanente. El documento de la tarea guarda ese `zoneId` y lo arrastra hasta el guardado del análisis.

**Costo: bajo.** `_resolve_zone()` ya honra un `zoneId` explícito por encima de todo lo demás (es su primera rama). Esto es plomería desde `/carga` hasta `analysis.tsx`, no lógica nueva.

**Lo que se gana**: no se puede crear un huérfano.
**Lo que se pierde**: nada, porque el camino de "guardar sin zona declarada" se conserva como respaldo.

> **No cerrar el camino sin declarar.** Convertir en error un flujo que hoy funciona, sin que ningún criterio lo pida, es más riesgo que beneficio. Que sea el camino normal, no el único.

### 3.2 HDU7 pasa de mecanismo a red de seguridad

Si el vuelo siempre declara su punto, dos vuelos del mismo lugar ya no pueden crear zonas distintas por accidente. La detección de duplicados por IoU de `orthoBounds` deja de ser *lo que evita el problema* y pasa a cubrir el caso en que alguien declaró mal.

**No se toca el código.** Está entregada y verificada en Sprint 1. Cambia su rol, no su implementación. Conviene decirlo en el README para que nadie la lea como redundante y la borre.

### 3.3 Una sola lista, dos vistas

Las dos tablas muestran la misma entidad con columnas distintas según para qué se está mirando.

| Vista Principal (hoy) | Vista Principal (objetivo) |
|---|---|
| Mapa, Nombre, Dirección, Fecha, Volumen, Peso, Área | + **Barrio**, **Tipo** |

| Itinerario (hoy) | Itinerario (objetivo) |
|---|---|
| Mapa, Nombre, Dirección, Barrio, Tipo, Frecuencia, En la semana | + **Volumen**, **Peso**, **Área**, **Fecha** |

**El filtro de Vista Principal cambia** de describir el origen a describir el estado:

```
Todas | Con análisis | Sin vuelo | En progreso | Historial
```

**Costo: bajo.** La mitad ya está. Vista Principal ya tiene dirección y el Itinerario ya tiene la columna de mapa (con la miniatura del mapa unificado, que el backend devuelve en la misma agregación que el conteo de análisis).

### 3.4 Botón para volar un punto

En la fila de un punto sin vuelo, una acción "Generar mapa unificado" que lleva a `/carga` con ese punto ya declarado.

Al terminar, el análisis queda colgado de él y **evolución, informe, versiones y "ver análisis" funcionan sin cambios**, porque todos operan sobre `zoneId` y no sobre el origen de la zona.

**Costo: bajo.** Es el 3.1 más un enlace.

### 3.5 Los puntos permanentes entran a las rutas

**Esta es la pieza que no está resuelta y es la razón de ser de HDU5.2.**

`routing.py::_load_route_stops` arma cada parada con `volume_m3`, `weight_kg` y `clasesPorVolumen`. Todo el reparto de HDU5.1 descansa en esas tres cosas:

- `_capacidad_de_peso()` recorta por peso
- `_trucks_used()` elige vehículos por volumen, peso y tipo de residuo
- `_parcializar()` calcula la fracción que se retira
- `_MINIMO_RETIRO_M3` descarta lo que no justifica un viaje

Un punto sin vuelo **no tiene ninguna de las tres**.

#### Las tres opciones, y ninguna es obvia

| Opción | A favor | En contra |
|---|---|---|
| **Volumen declarado a mano** en el punto, como ya se hace con los puntos diarios | Simple, honesto, disponible hoy | Es una estimación que nadie va a mantener |
| **Volumen histórico**: promedio de lo retirado en visitas anteriores | Es lo correcto | Necesita el registro de retiros, que no existe |
| **Capacidad fija por frecuencia**: un punto de "5 veces a la semana" mueve más que uno mensual | No pide ningún dato nuevo | Es una heurística sin respaldo del cliente |

**Recomendación: volumen declarado ahora, histórico después**, con el campo preparado para que el histórico lo sobrescriba cuando exista.

**Esta es la decisión que hay que tomar antes de escribir código**, porque define el resto.

#### Lo que falta además del volumen

- **Peso**: sin medición no hay `weight_kg`. O se deriva del volumen con una densidad por tipo de residuo (que habría que pedirle a la municipalidad), o el recorte por peso simplemente no aplica a estas paradas.
- **Clases de residuo**: el AC4 de HDU5.1 prefiere ciertos vehículos según el tipo dominante. Un punto permanente tiene `tipo` (Microbasural o VIRS), que **no es** lo mismo que la clase de residuo que detecta YOLO. Hay que decidir si se mapean o si estas paradas se saltan esa preferencia.

## 4. El registro de retiros

No aparece en ningún criterio de ninguna historia, y con los criterios cerrados queda fuera de alcance como historia propia. Pero es lo que cierra el círculo, así que conviene dejarlo descrito.

**Un retiro** es: fecha, zona, m³ retirados, camión que lo hizo, quién lo anotó. **Sin dotación**: el usuario elige el camión a mano, y una dotación es una restricción de *planificación*, mientras que un retiro ya ocurrió.

**La decisión de modelo**: un retiro y un análisis son el **mismo tipo de dato**. Los dos dicen cuánto volumen había en un lugar en una fecha; uno lo midió un dron y el otro lo contó la cuadrilla. Van a la **misma línea de tiempo**: `ZoneEvolution` y el informe PDF los grafican juntos, distinguidos por su origen.

Eso es lo que le da historial de volumen a los 54 puntos permanentes sin volarle el dron a ninguno, que es el verdadero valor.

**Camión manual contra `_trucks_used`: conviven, no chocan.** `_trucks_used` dice qué camión *debería* ir, antes del turno, y es una predicción. El campo manual dice qué camión *fue*, después, y es un hecho. El camión manual vive en el registro de retiro, **no** en el plan de ruta: HDU5 no se toca. Cuando haya suficientes retiros registrados, comparar lo planificado contra lo ejecutado sale gratis.

## 5. Qué NO hacer

**No borrar las zonas analizadas existentes.** Con el lápiz de Vista Principal se les completa dirección, barrio, tipo y frecuencia, y quedan indistinguibles de un punto permanente. Son la única evidencia de que el pipeline completo funciona, que es lo que se demuestra en la defensa.

**No cerrar el camino de volar sin declarar punto.** Ver 3.1.

**No convertir el registro de retiros en una historia nueva.** Los criterios están cerrados y no se pueden agregar.

## 6. Orden de trabajo y dónde está el riesgo

| # | Qué | Riesgo |
|---|---|---|
| 1 | Completar las columnas de las dos tablas y el filtro de Vista Principal | Ninguno |
| 2 | Declarar el punto en `/carga` + botón "Generar mapa unificado" en la fila | Bajo, todo nuevo |
| 3 | Paradas sin vuelo en el ruteo | **Alto** |

Los dos primeros se pueden hacer **sin abrir HDU5.1**. El tercero es HDU5.2 propiamente, toca `_trucks_used`, el recorte por peso y la preferencia por tipo de residuo, que están verificados y demostrados, y **necesita que antes se decida de dónde sale el volumen de un punto que nadie midió**.

---

## Anexo: contexto que hace falta para retomar

### Archivos que toca cada pieza

| Pieza | Backend | Frontend |
|---|---|---|
| 3.1 Declarar punto al cargar | `orquestador.py` (guardar `zoneId` en la tarea) | `carga.tsx`, `analysis.tsx`, `mapState.ts` |
| 3.3 Columnas y filtro | ninguno | `index.tsx`, `planificacion.itinerario.tsx` |
| 3.4 Botón de volar | ninguno | `index.tsx`, `carga.tsx` |
| 3.5 Paradas sin vuelo | `routing.py` (`_load_route_stops`, `_trucks_used`, `_parcializar`) | `routePlan.ts`, `planificacion.rutas.tsx` |
| 4 Registro de retiros | módulo nuevo | `ZoneEvolution.tsx`, `volumeReport.ts`, `pdfReport.ts` |

### Invariantes que no se pueden romper

- **Una zona tiene exactamente una versión vigente a la vez**, la más reciente por `captureDate`, con todo lo anterior `historical`. Lo reestablece `_reconciliar_vigencia()`, y **toda escritura que pueda perturbarlo la llama**: guardar análisis, confirmar duplicado, reasignar versión y borrar análisis.
- **Una versión solo existe una vez que su primer análisis está guardado.** Es lo que hace imposible una versión huérfana.
- **`volumeReport.ts` es la única aritmética** del informe y de la evolución. Si cada uno calculara lo suyo, contarían historias distintas de la misma zona.
- **El volumen por tipo de residuo se reparte proporcionalmente, nunca se suma.** El `volume_m3` de una detección fusionada es el promedio o el máximo del grupo, no la suma de su desglose.
- **Los totales se redondean por fila antes de sumar**, en el frontend y en el backend. Sumar crudo y redondear al final da un total que no cuadra con su propio detalle.

### Por qué `zones` ya está preparada

Los campos que agregó HDU14 son todos opcionales y **disjuntos** de los que escribe el vuelo:

```
kind, address, comuna, barrio, lat, lng, photoUrl, tipo, frecuencia, active
```

Ningún camino escribe un campo que el otro también quiera escribir, así que una zona puede completarse por los dos lados sin nada que reconciliar. Las zonas anteriores a HDU14 no traen `kind`, y ausente significa `basural`: **no hay migración pendiente**.

### Lo único asimétrico: el nombre

La zona es el terreno ("Avenida Las Industrias") y cada versión es una medición con su fecha ("Medición 26-05-2026"). Si la zona ya existe, conserva su nombre y lo que se escribe al guardar nombra la **versión**. Eso ya está resuelto y no hay que volver a tocarlo.
