#!/usr/bin/env python3
"""Genera un .doc LEGADO REAL (formato binario Word 97-2003, OLE2/CFB) usando Word
por COM, y un .docx moderno equivalente para comparar. Sirve para resolver el
pendiente abierto desde agosto: si la app soporta de verdad el .doc legado o solo
lo acepta en el selector de archivos."""
import os, sys

try:
    import win32com.client as win32
except ImportError:
    sys.exit('win32com no disponible')

DESTINO = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')

TEXTO = [
    'ACTA DE REUNION CONFIDENCIAL',
    '',
    'Responsable: correo direccion@acmecorp.com',
    'Telefono de contacto: +52 55 1234 5678',
    'RFC de la entidad: GODE561231GR8',
    'Cuenta IBAN: ES9121000418450200051332',
    'Servidor interno: 192.168.14.22',
    'Portal: https://intranet.acmecorp.com/clientes',
    'Monto asignado: $85.340',
    '',
    'MARCADOR_DOC_LEGADO',
]

wdFormatDocument97 = 0      # .doc binario legado
wdFormatXMLDocument = 12    # .docx OOXML

word = win32.gencache.EnsureDispatch('Word.Application')
word.Visible = False
word.DisplayAlerts = False
try:
    doc = word.Documents.Add()
    doc.Content.Text = '\r'.join(TEXTO)

    ruta_doc = os.path.join(DESTINO, 'prueba-legado.doc')
    ruta_docx = os.path.join(DESTINO, 'prueba-moderno.docx')
    for p in (ruta_doc, ruta_docx):
        if os.path.exists(p):
            os.remove(p)

    doc.SaveAs2(ruta_doc, FileFormat=wdFormatDocument97)
    doc.SaveAs2(ruta_docx, FileFormat=wdFormatXMLDocument)
    doc.Close(False)
finally:
    word.Quit()

for p in ('prueba-legado.doc', 'prueba-moderno.docx'):
    full = os.path.join(DESTINO, p)
    with open(full, 'rb') as f:
        firma = f.read(8)
    tam = os.path.getsize(full)
    # OLE2/CFB empieza por D0CF11E0A1B11AE1; OOXML (zip) por 504B0304
    tipo = ('OLE2/CFB binario legado' if firma[:8] == b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'
            else 'ZIP/OOXML moderno' if firma[:4] == b'PK\x03\x04'
            else 'desconocido')
    print(f'{p}: {tam:,} bytes · firma {firma[:4].hex()} · {tipo}')
