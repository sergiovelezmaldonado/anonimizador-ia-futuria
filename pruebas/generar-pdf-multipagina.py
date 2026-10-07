#!/usr/bin/env python3
"""Genera un PDF multipagina valido con texto extraible, sin dependencias externas.
Sirve para probar que el Anonimizador IA extrae TODAS las paginas, no solo la primera.
Cada pagina lleva datos sensibles distintos y marcadores unicos verificables."""
import sys, zlib

PAGINAS = int(sys.argv[1]) if len(sys.argv) > 1 else 12
SALIDA = sys.argv[2] if len(sys.argv) > 2 else 'prueba-multipagina.pdf'

def esc(s):
    return s.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')

def contenido_pagina(n, total):
    """Cada pagina trae un marcador unico MARCADOR_PAGINA_N y PII propia."""
    lineas = [
        f'ACTA DE REUNION CONFIDENCIAL  -  Pagina {n} de {total}',
        '',
        f'MARCADOR_PAGINA_{n:03d}',
        '',
        f'Responsable: correo pagina{n}@acmecorp.com',
        f'Telefono de contacto: +52 55 1234 {5000 + n}',
        f'RFC de la entidad: GODE5612{n:02d}GR8',
        f'Cuenta IBAN: ES91210004184502000513{n:02d}',
        f'Servidor del area: 192.168.14.{n}',
        f'Portal interno: https://intranet.acmecorp.com/area{n}',
        f'Monto asignado: $85.{n:02d}0',
        '',
        'Este documento se usa para verificar la extraccion completa',
        'de un PDF de varias paginas por parte del Anonimizador IA.',
    ]
    ops = ['BT', '/F1 11 Tf', '1 0 0 1 56 760 Tm', '14 TL']
    for ln in lineas:
        ops.append(f'({esc(ln)}) Tj')
        ops.append('T*')
    ops.append('ET')
    return '\n'.join(ops).encode('latin-1')

objetos = []          # lista de bytes, 1-indexada al construir
def add(b):
    objetos.append(b)
    return len(objetos)   # numero de objeto

# Reservamos: 1=Catalog, 2=Pages, 3=Font, luego por pagina: Page + Contents
num_catalog, num_pages, num_font = 1, 2, 3
objetos.extend([b'', b'', b''])    # placeholders

ids_paginas = []
for i in range(1, PAGINAS + 1):
    flujo = zlib.compress(contenido_pagina(i, PAGINAS))
    num_cont = add(
        b'<< /Length ' + str(len(flujo)).encode() + b' /Filter /FlateDecode >>\nstream\n'
        + flujo + b'\nendstream'
    )
    num_pag = add(
        b'<< /Type /Page /Parent ' + str(num_pages).encode() + b' 0 R '
        b'/MediaBox [0 0 612 792] '
        b'/Resources << /Font << /F1 ' + str(num_font).encode() + b' 0 R >> >> '
        b'/Contents ' + str(num_cont).encode() + b' 0 R >>'
    )
    ids_paginas.append(num_pag)

objetos[num_catalog - 1] = b'<< /Type /Catalog /Pages ' + str(num_pages).encode() + b' 0 R >>'
kids = b' '.join(str(p).encode() + b' 0 R' for p in ids_paginas)
objetos[num_pages - 1] = (
    b'<< /Type /Pages /Count ' + str(PAGINAS).encode() + b' /Kids [' + kids + b'] >>'
)
objetos[num_font - 1] = b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

# Ensamblar con tabla xref
salida = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
offsets = []
for i, cuerpo in enumerate(objetos, start=1):
    offsets.append(len(salida))
    salida += str(i).encode() + b' 0 obj\n' + cuerpo + b'\nendobj\n'

inicio_xref = len(salida)
n = len(objetos) + 1
salida += b'xref\n0 ' + str(n).encode() + b'\n'
salida += b'0000000000 65535 f \n'
for off in offsets:
    salida += f'{off:010d} 00000 n \n'.encode()
salida += (
    b'trailer\n<< /Size ' + str(n).encode() + b' /Root ' + str(num_catalog).encode() + b' 0 R >>\n'
    b'startxref\n' + str(inicio_xref).encode() + b'\n%%EOF\n'
)

with open(SALIDA, 'wb') as f:
    f.write(bytes(salida))

print(f'{SALIDA}: {PAGINAS} paginas, {len(salida):,} bytes')
print(f'marcadores esperados: MARCADOR_PAGINA_001 .. MARCADOR_PAGINA_{PAGINAS:03d}')
