# Anonimizador IA — FuturIA (App 7)

Detecta y reemplaza datos sensibles en un texto **antes** de pegarlo en ChatGPT,
Claude, Gemini o cualquier otro modelo. El reemplazo es reversible: cada dato
original queda mapeado a una etiqueta (`[EMAIL_1]`, `[CREDENCIAL_1]`) y la
pestaña Recuperar devuelve el texto a su forma original con la respuesta del modelo.

**El procesamiento del texto es 100% local**: ocurre en el navegador y no genera
ninguna petición de red. Lo que sí requiere internet es la carga inicial de la
app (React, Babel, Tailwind y la fuente desde CDN), así que sin conexión no arranca.

## Qué contiene

Archivo único (`index.html`), sin build y sin backend. React se transpila en el
navegador con Babel Standalone.

- 11 categorías de detección con expresiones regulares propias + términos personalizados
- Cobertura fiscal LATAM + EE. UU.: RFC, CURP, CUIT/CUIL, RUT, NIT, RIF, RUC, CPF/CNPJ, RTN, RNC, SSN/EIN
- Semáforo de riesgo residual que **bloquea la exportación** con riesgo ≥60%
- 50 plantillas de ejemplo en 8 industrias, con auto-activación de categorías
- Montos sustituidos por un rango de ±10%, no eliminados
- Sin `localStorage`, `sessionStorage` ni `IndexedDB`: el mapeo vive solo en memoria

## Carga de documentos

Las pestañas Texto y Documento aceptan PDF, DOCX, DOC, TXT y CSV, **con varias
páginas**: el PDF se recorre completo página por página mostrando el progreso.
La pestaña Documento abre el resultado en un visor a página completa con aspecto
de hoja impresa, con toggle «Con marcas / Sin marcas», imprimir y descargar.

Límites, declarados en la propia zona de carga y comprobados antes de leer el
archivo: **25 MB y 300 páginas**. A partir de 40 páginas avisa de que tardará.
No se admite un PDF escaneado sin capa de texto, porque no hay OCR.

## Ver la app

```bash
node servidor-local.mjs          # http://localhost:5199
```

## Pruebas

```bash
# 1) servidor estático en el puerto 5199
node servidor-local.mjs

# 2) Chrome headless con el puerto de depuración abierto
chrome --headless=new --remote-debugging-port=9334 --user-data-dir=/tmp/p about:blank

# 3) las tres sondas
node pruebas/sonda-app.mjs              # 28 · regresión general
node pruebas/sonda-correccion.mjs       # 12 · saltos de línea y límites de carga
node pruebas/sonda-interfaz.mjs         # 18 · tamaños y ventana emergente
```

**58 comprobaciones** contra la app realmente servida, por CDP: dependencias
pinneadas, Tailwind efectivamente aplicado, el flujo completo de anonimización,
que ningún dato crudo quede en el bloque de salida, que la tabla de equivalencias
sí conserve los originales (reversibilidad), que no haya peticiones a ningún
backend, y sondas de desbordamiento a 1280/900/520 px.

Los PDF de prueba se generan sin dependencias externas:

```bash
python pruebas/generar-pdf-multipagina.py 12 pruebas/prueba-multipagina.pdf
python pruebas/generar-pdf-parrafos.py pruebas/prueba-parrafos.pdf
```

## Notas de mantenimiento

- **Las dependencias de CDN van con versión exacta.** `cdn.tailwindcss.com` responde
  HTTP 200 a versiones que no existe y entonces los estilos no se aplican sin ningún
  error de red: la última versión servida por ese CDN es la `3.4.17`. Un 200 no prueba
  que la dependencia cargue — hay que comprobar un estilo computado.
- **La extracción de PDF se verifica por su estructura, no por el número de
  caracteres.** `pdf.js` entrega fragmentos sueltos con su posición; unirlos con
  `items.map(i => i.str).join(' ')` devuelve todos los caracteres y destruye el
  documento, que sale como un solo párrafo ilegible. `reconstructPageText()` agrupa
  por coordenada Y e infiere el párrafo con el interlineado mediano de cada página.
  El contenedor que lo muestre necesita `white-space: pre-wrap`, o pierde igualmente
  los saltos simples. La prueba cuenta párrafos.
- **Los ejemplos de credencial no imitan el formato real.** Las claves de muestra
  usan placeholders explícitamente ficticios: con el formato real de Stripe, el
  escáner de secretos de GitHub rechaza el push. La app los detecta igual, porque
  su patrón solo exige `[A-Za-z0-9_-]{10,}` tras el prefijo.
- Soporte de `.doc` legado sin verificar: el selector lo acepta y pasa por
  `mammoth.extractRawText`, documentada para OOXML (`.docx`).
- La exportación a Word es HTML con estilos `mso-*` en un blob `application/msword`,
  no un `.docx` OOXML real.
- Pendiente: QA en móvil real (las sondas de ancho son emulación por CDP),
  detección de nombres propios de personas, y descubribilidad del visor, que hoy
  solo se alcanza desde la pestaña Documento.
