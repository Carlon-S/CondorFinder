#!/bin/bash
if [[ "$1" != "0" && "$1" != "1" ]]; then
    echo "Uso: bash run.sh <0|1>"
    echo "  0 = fast preset"
    echo "  1 = quality preset"
    exit 1
fi

source .venv/bin/activate

FILENAME=$(python3 joining/joinOrtho.py "$1")

python3 detecting/detectingOrtho.py "joining/finals/$FILENAME"

if [[ -z "$FILENAME" ]]; then
    echo "Error: No se encontro archivo"
    exit 1
fi