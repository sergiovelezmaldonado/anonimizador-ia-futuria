#!/usr/bin/env python3
"""PDF de prueba con estructura de parrafos REALISTA: titulos, parrafos separados
por hueco mayor, lineas cortas seguidas y listas. Sirve para verificar que la app
reconstruye los saltos de linea y los parrafos en vez de aplastarlo todo."""
import sys, zlib

SALIDA = sys.argv[1] if len(sys.argv) > 1 else 'prueba-parrafos.pdf'

def esc(s):
    return s.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')

# (texto, salto_antes_en_puntos) -- salto grande = parrafo nuevo
BLOQUES = [
    ('ACTA DE REUNION DEL COMITE DE DIRECCION', 0),
    ('Sesion ordinaria numero 47', 16),
    ('', 0),
    ('ASISTENTES', 28),
    ('Director General: correo direccion@acmecorp.com', 16),
    ('Telefono directo: +52 55 1234 5678', 16),
    ('RFC de la entidad: GODE561231GR8', 16),
    ('', 0),
    ('PRIMER PUNTO DEL ORDEN DEL DIA', 28),
    ('Se presenta el estado de la cuenta corporativa con numero', 16),
    ('IBAN ES9121000418450200051332, que registra un saldo', 16),
    ('pendiente de $85.340 a la fecha de cierre.', 16),
    ('', 0),
    ('SEGUNDO PUNTO', 28),
    ('El area de sistemas reporta que el servidor interno', 16),
    ('192.168.14.22 presenta intermitencias, y que el portal', 16),
    ('https://intranet.acmecorp.com/clientes requiere migracion.', 16),
    ('', 0),
    ('ACUERDOS', 28),
    ('Primero. Aprobar el presupuesto presentado.', 16),
    ('Segundo. Revisar los contratos vigentes.', 16),
    ('Tercero. Convocar sesion extraordinaria.', 16),
]

ops = ['BT', '/F1 11 Tf', '1 0 0 1 56 750 Tm']
primero = True
for texto, salto in BLOQUES:
    if primero:
        primero = False
    else:
        ops.append(f'0 -{salto} Td')
    if texto:
        ops.append(f'({esc(texto)}) Tj')
ops.append('ET')
flujo = zlib.compress('\n'.join(ops).encode('latin-1'))

objs = [
    b'<< /Type /Catalog /Pages 2 0 R >>',
    b'<< /Type /Pages /Count 1 /Kids [4 0 R] >>',
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
    b'/Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    b'<< /Length ' + str(len(flujo)).encode() + b' /Filter /FlateDecode >>\nstream\n' + flujo + b'\nendstream',
]

out = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
offs = []
for i, o in enumerate(objs, 1):
    offs.append(len(out))
    out += str(i).encode() + b' 0 obj\n' + o + b'\nendobj\n'
xref = len(out)
out += b'xref\n0 ' + str(len(objs) + 1).encode() + b'\n0000000000 65535 f \n'
for o in offs:
    out += f'{o:010d} 00000 n \n'.encode()
out += (b'trailer\n<< /Size ' + str(len(objs) + 1).encode() + b' /Root 1 0 R >>\nstartxref\n'
        + str(xref).encode() + b'\n%%EOF\n')

with open(SALIDA, 'wb') as f:
    f.write(bytes(out))
print(f'{SALIDA}: {len(out):,} bytes, {len([b for b in BLOQUES if b[0]])} lineas de texto')
