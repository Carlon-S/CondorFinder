from pyodm import Node
import os, shutil
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

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
        'pc-quality': 'medium'
    }

def join(opc: int) -> str:

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

    node = Node('localhost', 3000)

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

    task.wait_for_completion(interval=10)

    if task.info().status.name == "COMPLETED":
        print("Juntado completado!", file=sys.stderr)
    else:
        print(f"Juntado fallado con error: {task.info().status.name}", file=sys.stderr)
        exit()


    final_dir = os.path.join(BASE_DIR, "finals")

    assets = task.download_assets(output_dir)

    shutil.move(f"{output_dir}/odm_orthophoto/odm_orthophoto.tif",f"{final_dir}/ortho_{task.uuid}.tif")


    print(f"Orthomosaic guardado en ./finals/ortho_{task.uuid}.tif", file=sys.stderr)

    """Probablmente este se tiene que cambiar al archivo en si en vez del nombre? Funciona asi pero podria ser nesesario"""
    return f"ortho_{task.uuid}.tif"