"""
CONDORFINDER, BITÁCORA DE ACCIONES DESTRUCTIVAS
Archivo: backendModel/auditoria.py

Quién borró o modificó qué, y cuándo.

**Por qué existe.** `owner` dice quién CREÓ cada zona, análisis y recurso, pero
nada decía quién los borró. Con una sola cuenta compartida eso daba lo mismo,
porque la respuesta siempre era "admin"; desde que cada persona entra con su
propia identidad, la pregunta "¿quién eliminó la zona de Las Industrias?" tiene
una respuesta real y vale la pena guardarla.

**Solo lo destructivo e irreversible.** Registrar cada lectura convertiría la
colección en un basurero donde lo importante no se encuentra, y además nadie la
miraría. Van los borrados, los renombrados y los cambios de identidad, que son
los que no se pueden deshacer mirando la pantalla.

**Nunca interrumpe la operación que registra.** Si escribir la bitácora falla
(Mongo caído, un documento raro), el borrado igual ocurrió y la respuesta sale
bien. Una bitácora que puede tumbar un borrado es peor que no tenerla: convierte
un problema de observabilidad en una caída.

No hay endpoint de lectura a propósito: es un registro forense que se consulta
desde la base cuando hace falta, no una pantalla más. Agregar la vista es
trabajo aparte y pertenece a una historia que nadie escribió todavía.
"""

from datetime import datetime, timezone

from pymongo.asynchronous.database import AsyncDatabase

_db: AsyncDatabase | None = None

COLECCION = "auditoria"


def set_db(db: AsyncDatabase) -> None:
    global _db
    _db = db


async def create_index() -> None:
    """Índice por fecha descendente, que es como se consulta siempre: "qué pasó
    últimamente". Idempotente, se puede llamar en cada arranque."""
    if _db is None:
        return
    await _db[COLECCION].create_index([("ts", -1)])


async def registrar(
    actor: str,
    accion: str,
    recurso: str,
    recurso_id: str | None = None,
    detalle: dict | None = None,
) -> None:
    """Anota una acción.

    `actor` es el correo de quien la hizo, `accion` qué hizo (`eliminar`,
    `renombrar`, `sobrescribir`, `reasignar`), `recurso` sobre qué tipo de cosa
    y `recurso_id` sobre cuál. `detalle` guarda lo que haga falta para entender
    después, como el nombre de lo que se borró, que es justamente el dato que
    deja de existir cuando el documento se va.
    """
    if _db is None:
        return
    try:
        await _db[COLECCION].insert_one({
            "ts": datetime.now(timezone.utc),
            "actor": actor,
            "accion": accion,
            "recurso": recurso,
            "recursoId": recurso_id,
            "detalle": detalle or {},
        })
    except Exception as e:
        # A propósito: se avisa por el log del servidor y se sigue. Ver el
        # docstring del módulo.
        print(f"[auditoria] No se pudo registrar {accion} sobre {recurso}: {e}")
