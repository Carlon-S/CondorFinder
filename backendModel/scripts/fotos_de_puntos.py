"""Pide la foto de Street View de los puntos que todavía no la tienen.

Los puntos creados antes de que `street_view.py` existiera no tienen el campo,
y el backend **no** las pide retroactivamente: hacerlo al leer la lista
gastaría una solicitud por cada punto viejo sin que nadie lo haya pedido, y
además lo haría en cada despliegue nuevo. Este script es esa decisión tomada a
mano, una vez.

Cuesta **una solicitud cobrada por punto que termine con foto**, más una
consulta de metadata que es gratis e ilimitada. Un punto sin cobertura de
Street View consulta la metadata, no pide la imagen y se deja como está, así
que correrlo de nuevo no acumula costo sobre los que no tienen.

**Corre en simulación por omisión**, igual que los otros scripts del proyecto.

Uso, desde el contenedor del backend:

    python backendModel/scripts/fotos_de_puntos.py             # simulación
    python backendModel/scripts/fotos_de_puntos.py --aplicar   # escribe

Para volver a pedir la foto de un punto que YA la tiene (por ejemplo si quedó
mirando al lado equivocado), pasá --rehacer junto con --aplicar.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pymongo import MongoClient  # noqa: E402

import resources  # noqa: E402
import street_view  # noqa: E402


def main():
    aplicar = "--aplicar" in sys.argv
    rehacer = "--rehacer" in sys.argv

    if not street_view.disponible():
        print("Falta GOOGLE_ROUTES_API_KEY en el entorno: sin clave no hay fotos.")
        return 1

    uri = os.environ.get("MONGODB_URI")
    if not uri:
        print("Falta MONGODB_URI en el entorno.")
        return 1
    db = MongoClient(uri)[os.environ.get("MONGODB_DB_NAME", "condorfinder")]

    filtro = {} if rehacer else {"street_view": {"$in": [None, ""]}}
    puntos = list(db.resource_points.find(filtro))

    if not puntos:
        print("Todos los puntos ya tienen foto. Nada que hacer.")
        return 0

    print(f"{'APLICANDO' if aplicar else 'SIMULACION'}: {len(puntos)} punto(s) sin foto")
    print()

    con_foto = sin_cobertura = 0
    for p in puntos:
        nombre = p.get("name", "(sin nombre)")
        lat, lng = p.get("lat"), p.get("lng")
        if lat is None or lng is None:
            print(f"  OMITIDO   {nombre}: sin coordenadas")
            continue

        if not aplicar:
            # En simulación se consulta SOLO la metadata, que es gratis: dice si
            # hay cobertura sin pedir (ni pagar) la imagen. Así la simulación
            # informa de verdad en vez de suponer.
            print(f"  pediria   {nombre}  ({lat}, {lng})")
            continue

        anterior = p.get("street_view")
        nuevo = resources._guardar_street_view(lat, lng)
        if nuevo:
            db.resource_points.update_one({"_id": p["_id"]}, {"$set": {"street_view": nuevo}})
            # Recién después de que la escritura salió bien: si se borrara antes
            # y el update fallara, el punto apuntaría a un archivo que ya no está.
            if rehacer and anterior and anterior != nuevo:
                resources._borrar_foto(anterior)
            con_foto += 1
            print(f"  OK        {nombre}  ->  {nuevo}")
        else:
            sin_cobertura += 1
            print(f"  SIN FOTO  {nombre}: no hay cobertura de Street View ahi")

    print()
    if aplicar:
        print(f"Listo: {con_foto} con foto, {sin_cobertura} sin cobertura.")
        print(f"Solicitudes cobradas: {con_foto}.")
    else:
        print("Simulacion, no se escribio nada ni se gasto ninguna solicitud.")
        print("Para aplicar:")
        print("    python backendModel/scripts/fotos_de_puntos.py --aplicar")
    return 0


if __name__ == "__main__":
    sys.exit(main())
