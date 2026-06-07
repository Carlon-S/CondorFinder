## Grupos archivos

1. **Joining** — Carga las imágenes del dron a un nodo local de OpenDroneMap (ODM), espera a que se procesen y guarda el archivo ortomosaico resultante `.tif`.
2. **Detecting** — Divide el ortomosaico en secciones, ejecuta un modelo YOLOv8 para detectar categorías de basura y guarda una imagen de vista previa anotada.

## Requerimientos

- [Python 3.12+](https://www.python.org/downloads/)
- [Docker](https://docs.docker.com/get-docker/)

> Solo lo he probado en linux, asique windows probablemente sea distinto

---

## Setup

### 1. Inicia el nodo de ODM

```bash
docker run -ti -p 3000:3000 webodm/nodeodm
```

Mantén esto ejecutándose en una terminal separada. El paso de joining se conecta a ella en `localhost:3000`.

### 2. Crea un ambiente de maquina virtual

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 3. Instala requerimientos

```bash
pip install -r requirements.txt
```

> Va a tomar un rato instalar todos los requisitos. Solo hay que hacer esto una vez.

---

## Uso temportal (Hay que actualizarlo para que funcione con el front end, por ahora solo se ejecuta con un archivo bash.

### 1. Añade las imagenes

Coloca las imagenes (`.jpg`) en:

```
joining/images/
```

### 2. Ejecuta el bash

```bash
bash run.sh <0|1>
```

| Argumento | Preset | Descripcion |
|---|---|---|
| `0` | Rapido | Mas rapido, peor resolucion (~10 min) |
| `1` | Calida | Mas lento y mejor resulicion. Es lo mejor que se podia mi pc (~40 min) |

**Ejemplo:**
```bash
bash run.sh 0
```

### 3. Final

La imagen con las annotaciones se guarda en:
```
detecting/output/
```

---

## Estructura

```
project-root/
├── joining/
│   ├── images/          ← Imagenes. Solo puede haber un grupo de imagenes por ejecucion. 
│   ├── finals/          ← El orthomosaico se guarda aqui.
│   └── joinOrtho.py
├── detecting/
│   ├── model/
│   │   └── best.pt      ← YOLOv8 pesos
│   ├── output/          ← Las imagenes anotadas se guardan aqui.
│   └── detectingOrtho.py
├── .venv/
├── requirements.txt
├── run.sh
└── README.md
```

---

## Notas
- El paso de deteccion por default usa la CPU. Para usar la GPU, cambiar `device="cpu"` a `device="cuda"` en `detecting/detectingOrtho.py`.
- Si el ODM (Docker) no esta funcionando, el programa crashea.
- Hay un ejemplo en la carpeta de detecting/output para comparar. Esta hecho en el setup de baja calidad, por lo que no es muy precsiso.
---
## Que falta por hacer

1. Conectar el front-end y el backend. Por ahora la forma de ejecutar es un sh.run que solo se ejecuta una vez. Habria que cambiarlo a un python que se conecta al front que espera request.
2. Refinar mas el model, pero eso siempre se espera
3. Crear el mapa interactivo con las anotaciones. Hay un ejemplo vivecodeado en el detectingOrtho.py, pero no me gusto mucho.
4. Calcular el volumen de basura que hay.
---
