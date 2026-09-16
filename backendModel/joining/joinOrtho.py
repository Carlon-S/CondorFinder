from pyodm import Node
import os, shutil
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


class TaskCancelledError(Exception):
    """Se lanza cuando la tarea de ODM fue cancelada (status CANCELED)."""
    pass


def limpiar_salida_cruda(output_dir: str) -> None:
    """Vacía la carpeta de salida de ODM conservando la carpeta en sí.

    Se llama una vez rescatados el ortomosaico y los modelos de elevación. La
    carpeta tiene que seguir existiendo porque la próxima corrida descarga ahí
    sus assets.

    No usa shutil.rmtree sobre la carpeta entera a propósito: borrarla y
    recrearla cambiaría su dueño y sus permisos, y esta ruta está montada
    desde el disco de la máquina hacia el contenedor.
    """
    if not os.path.isdir(output_dir):
        return
    for nombre in os.listdir(output_dir):
        ruta = os.path.join(output_dir, nombre)
        try:
            if os.path.isdir(ruta):
                shutil.rmtree(ruta, ignore_errors=True)
            else:
                os.remove(ruta)
        except Exception as e:
            print(f"No se pudo liberar {ruta}: {e}", file=sys.stderr)

presetfast = {
        'orthophoto-resolution': 8,
        'fast-orthophoto': False,
        'skip-3dmodel': False,
        'dtm': True,
        'dsm': True,
        'matcher-neighbors': 8,
        'feature-quality': 'low',
        'pc-quality': 'lowest',
        'min-num-features': 4000,
        'resize-to': 1500,
    }

presethigh = {
        'orthophoto-resolution': 2,
        'feature-quality': 'high',
        'pc-quality': 'medium',
        'dtm': True,
        'dsm': True,
    }

def join(opc: int, on_task_created=None, on_progress=None) -> str:

    output_dir = os.path.join(BASE_DIR, "output")
    os.makedirs(output_dir, exist_ok=True)

    for filename in os.listdir(output_dir):
        file_path = os.path.join(output_dir, filename)
        try:
            if os.path.isfile(file_path) or os.path.islink(file_path):
                os.unlink(file_path)
            elif os.path.isdir(file_path):
                shutil.rmtree(file_path)
        except Exception as e:
            print('Failed to delete %s. Reason: %s' % (file_path, e), file=sys.stderr)

    if opc == 0:
        setting = presetfast
        print("Preset rapido", file=sys.stderr)
    else:
        print("Preset Calidad", file=sys.stderr)
        setting = presethigh

    # NODEODM_HOST: "localhost" en WSL local (NodeODM en la misma máquina),
    # "nodeodm" en docker-compose (contenedor sibling, ver orquestador.py).
    node = Node(os.environ.get("NODEODM_HOST", "localhost"), 3000)

    image_folder = os.path.join(BASE_DIR, "images")

    images = [
        os.path.join(image_folder, f)
        for f in os.listdir(image_folder)
        if f.lower().endswith(('jpg'))
    ]

    if not images:
        raise Exception("No se encontraron imagenes!")
    print(f"Encontradas {len(images)} imagenes.", file=sys.stderr)

    task = node.create_task(
        files=images,
        options=setting
    )

    print(f"Tarea juntado creada: {task.uuid}", file=sys.stderr)

    # Le pasa la tarea de ODM a quien llamó (orquestador.py) ANTES de bloquear
    # en wait_for_completion, para que /cancel/{task_id} pueda pedirle a ODM
    # que la cancele de verdad mientras sigue corriendo — no solo dejar de
    # avanzar a la siguiente fase.
    if on_task_created:
        on_task_created(task)

    # NodeODM reporta su propio porcentaje estimado (TaskInfo.progress, 0-100)
    # y pyodm lo entrega en cada sondeo a través de status_callback. Esta es la
    # fase larga del pipeline, así que es la única con progreso real que vale
    # la pena mostrar: sin esto el frontend solo podía saltar de un número fijo
    # al siguiente al cambiar de etapa.
    # El callback nunca debe reventar la unificación: si falla al guardar el
    # avance (Mongo caído, por ejemplo) se ignora y ODM sigue trabajando.
    def _report(info):
        if on_progress is None:
            return
        try:
            on_progress(float(getattr(info, "progress", 0.0) or 0.0))
        except Exception:
            pass

    try:
        task.wait_for_completion(status_callback=_report, interval=10)
    except Exception as wait_err:
        # pyodm lanza su propia excepción cuando la tarea no termina en
        # COMPLETED (incluyendo cuando se cancela) — antes de asumir que es
        # un error real, hay que revisar si en realidad fue una cancelación.
        try:
            status_name = task.info().status.name
        except Exception:
            raise wait_err
        if status_name == "CANCELED":
            print("Juntado cancelado por el usuario", file=sys.stderr)
            raise TaskCancelledError("Unificación cancelada por el usuario")
        raise wait_err

    status_name = task.info().status.name
    if status_name == "COMPLETED":
        print("Juntado completado!", file=sys.stderr)
    elif status_name == "CANCELED":
        print("Juntado cancelado por el usuario", file=sys.stderr)
        raise TaskCancelledError("Unificación cancelada por el usuario")
    else:
        # Antes esto llamaba a exit(), que en un hilo secundario solo termina
        # el hilo sin avisar — la tarea quedaba "joining" para siempre en el
        # frontend. Ahora se propaga como excepción real para que
        # run_pipeline la capture y marque la tarea como error.
        raise Exception(f"ODM falló con estado: {status_name}")


    final_dir = os.path.join(BASE_DIR, "finals")

    assets = task.download_assets(output_dir)

    shutil.move(f"{output_dir}/odm_orthophoto/odm_orthophoto.tif",f"{final_dir}/ortho_{task.uuid}.tif")


    print(f"Orthomosaic guardado en ./finals/ortho_{task.uuid}.tif", file=sys.stderr)

    # Los modelos de elevación se mueven junto al ortomosaico, con el mismo
    # nombre por tarea. Antes se quedaban en output/odm_dem/, que es una
    # carpeta COMPARTIDA que el siguiente vuelo sobrescribe: mientras el
    # volumen se calculaba dentro del pipeline daba igual, porque se usaban
    # de inmediato. Ahora que el cálculo ocurre después, desde la vista de
    # análisis, un relieve compartido significaría medir un vuelo con el
    # terreno de otro y devolver cifras incorrectas sin ningún error visible.
    #
    # Si ODM no los generó (no debería pasar: los dos presets piden dsm/dtm),
    # se sigue adelante sin ellos y el análisis avisará que faltan, en vez de
    # tumbar acá una unificación que sí salió bien.
    for nombre in ("dsm", "dtm"):
        origen = os.path.join(output_dir, "odm_dem", f"{nombre}.tif")
        if os.path.exists(origen):
            shutil.move(origen, os.path.join(final_dir, f"{nombre}_{task.uuid}.tif"))
            print(f"{nombre.upper()} guardado en ./finals/{nombre}_{task.uuid}.tif", file=sys.stderr)
        else:
            print(f"Advertencia: ODM no generó {nombre}.tif", file=sys.stderr)

    # Ya se rescató todo lo que el sistema usa: el ortomosaico y los dos
    # modelos de elevación. Lo que queda en output/ es la salida cruda de ODM
    # (modelo texturizado, nube de puntos, informe), que nada del sistema lee
    # y que se medía en unos 100 MB por vuelo.
    #
    # Antes no se borraba nunca. Como ODM reescribe esta misma carpeta en cada
    # corrida, no crecía sin techo, pero dejaba permanentemente ocupado el
    # espacio de un vuelo completo. Limpiarla acá es lo que evita que esto sea
    # mantención manual del servidor.
    #
    # Best-effort: si un borrado falla, la unificación ya terminó bien y no
    # tiene por qué caerse por no poder liberar espacio.
    limpiar_salida_cruda(output_dir)

    print(f"Salida cruda de ODM liberada en {output_dir}", file=sys.stderr)

    """Probablmente este se tiene que cambiar al archivo en si en vez del nombre? Funciona asi pero podria ser nesesario"""
    return f"ortho_{task.uuid}.tif"