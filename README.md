# Anonimizador IA — FuturIA (App 7)

> **Verificación ampliada (2026-10-13): 135/135 sin fallos.** Los contrajemplos de la revisión inicial ya se corrigieron y forman parte de las regresiones: credenciales con signos y escapes, unión de intervalos solapados, revisión por generación de resultado, servidor con versión y protecciones comprobadas, mapas JSON/TSV y Ctrl+P. Pendiente el dictamen de revisión final antes del commit. No se realizó deploy público en esta tanda.

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

- Categorías de detección con expresiones regulares + nombres por contexto + términos personalizados
- Cobertura fiscal LATAM + EE. UU.: RFC, CURP, CUIT/CUIL, RUT, NIT, RIF, RUC, CPF/CNPJ, RTN, RNC, SSN/EIN
- Revisión residual con los mismos patrones del motor. **Sin porcentajes de riesgo ni verde automático.** Copiar, descargar e imprimir exigen cero coincidencias pendientes y confirmación manual; esto no certifica anonimización completa.
- 50 plantillas de ejemplo en 8 industrias, con auto-activación de categorías
- Montos sustituidos por etiquetas; los rangos aproximados aparecen solo como pistas en la interfaz y deben revisarse.
- Sin `localStorage`, `sessionStorage` ni `IndexedDB`: el mapeo vive solo en memoria
- **Borrar sesión** retira el contenido y el mapa del estado de la app. No borra archivos descargados, portapapeles ni copias del sistema.
- Descarga habitual **.txt sin originales ni tabla de equivalencias**. Respaldo **CONFIDENCIAL .doc** separado, con originales y confirmación explícita; jamás compartirlo con un modelo.
- La detección de nombres es heurística contextual, sin IA integrada ni API: reconoce ejemplos como `Paciente: María García` o `Sr. Carlos López`, pero puede omitir nombres aislados, apodos y otros formatos.

## Carga de documentos

Las pestañas Texto y Documento aceptan PDF, DOCX, TXT y CSV, **con varias
páginas**: el PDF se recorre completo página por página mostrando el progreso.
La pestaña Documento abre el resultado en un visor a página completa con aspecto
de hoja impresa, con toggle «Con marcas / Sin marcas», imprimir y descargar.

Límites, declarados en la propia zona de carga y comprobados antes de leer el
archivo: **25 MB y 300 páginas**. A partir de 40 páginas avisa de que tardará.
No se admite un PDF escaneado sin capa de texto, porque no hay OCR.

## Ver la app

```bash
node servidor-local.mjs          # http://127.0.0.1:5199
```

En Windows también puedes ejecutar `abrir-anonimizador.cmd`: el lanzador comprueba la app, inicia el servidor si falta y abre el navegador. Requiere Node disponible en el equipo. El servidor escucha únicamente en `127.0.0.1`, solo sirve `/` e `/index.html`, rechaza POST y no escribe documentos ni registros de peticiones.

**Local no significa offline ni borrado forense.** La carga de librerías y fuentes usa internet; PDF y DOCX pueden descargar motores adicionales. Las descargas y el historial/sincronización del portapapeles pueden conservar datos fuera de la app. Las extensiones, el sistema operativo y una librería externa comprometida quedan fuera de sus garantías.

## Pruebas

```bash
# 1) servidor estático en el puerto 5199
node servidor-local.mjs

# 2) Chrome headless con el puerto de depuración abierto
chrome --headless=new --remote-debugging-port=9334 --user-data-dir=/tmp/p about:blank

# 3) suite reproducible: sondas de navegador serializadas
node pruebas/ejecutar-qa.mjs             # genera pruebas/qa-resumen.json

# O por separado
node --test pruebas/test-seguridad.mjs pruebas/test-servidor.mjs
node pruebas/sonda-seguridad.mjs
node pruebas/sonda-app.mjs              # 28 · regresión general
node pruebas/sonda-correccion.mjs       # 12 · saltos de línea y límites de carga
node pruebas/sonda-interfaz.mjs         # 18 · tamaños y ventana emergente
```

**135 comprobaciones verificadas el 2026-10-13**, más un PDF de 12 páginas, contra el motor publicado y la app realmente servida por CDP: dependencias
pinneadas, Tailwind efectivamente aplicado, el flujo completo de anonimización,
que ningún dato crudo quede en el bloque de salida, que la tabla de equivalencias
sí conserve los originales (reversibilidad), que no haya peticiones a ningún
backend, controles de exportación e impresión, descargas separadas, recuperación desde Documento, borrado de sesión, almacenamiento vacío en varias APIs, y sondas de desbordamiento a 1280/900/520 px. El informe registra el SHA-256 del HTML probado. Estas pruebas verifican los casos incluidos, no cobertura completa de cualquier documento ni un dispositivo móvil real.

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
- `.doc` legado no soportado: se detecta la firma OLE2 y se explica cómo convertir a DOCX. Probado con Word binario real y DOCX de control.
- La exportación a Word es HTML con estilos `mso-*` en un blob `application/msword`,
  no un `.docx` OOXML real.
- El visor se abre desde Texto y Documento. Ambas rutas exigen revisión manual para exportar. La impresión no incluye el nombre del archivo fuente y la página de trabajo no se imprime con Ctrl+P, para no incluir originales por accidente.
- La revisión de Documento se vincula a una generación nueva aunque las etiquetas de salida sean idénticas; el modal aísla fondo y foco. El mapa reversible usa originales JSON dentro de TSV para preservar tabulaciones, saltos y espacios, y sigue leyendo mapas clásicos. El lanzador exige `X-Anonimizador-Server: futuria-local-2` y comprueba restricciones reales; una instancia antigua debe reiniciarse.
- Segunda revisión independiente (2026-10-13) cerrada en código: credenciales rotuladas con separador multilínea (`password =\n"…"`) se sustituyen completas, y las ocurrencias solapadas de un mismo término personalizado (`Ana Ana Ana` con término `Ana Ana`) se enumeran con lookahead capturado y se unen en una sola etiqueta reversible.
- Las sondas de navegador usan Chrome headless en el puerto **9334** (no 9333). Si `ejecutar-qa.mjs` falla con `fetch failed` en la primera sonda, falta ese Chrome, no el servidor.
- PDF: `isEvalSupported: false`, mitigación recomendada por el advisory oficial de Mozilla `GHSA-wgrm-67xf-hhpq`; los recursos del documento se liberan después de extraer texto. Esto no equivale a una auditoría de todas las dependencias.
- Pendiente: QA en móvil real, despliegue público (no realizado), cobertura de nombres más allá de contextos y un paquete completamente offline. No hay OCR ni históricos automáticos.
