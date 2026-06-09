
import sys
from joining import joinOrtho
from detecting import detectingOrtho

def main():
    if len(sys.argv) >= 2:
        opc = int(sys.argv[1])

    filename = joinOrtho.join(opc)
    fileplace = f"joining/finals/{filename}"
    detectingOrtho.detect(fileplace)
    return

if __name__ == "__main__":
    main()