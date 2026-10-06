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

## Pruebas

```bash
# 1) servidor estático en el puerto 5199
node -e "const h=require('http'),f=require('fs');h.createServer((q,r)=>{f.readFile('index.html',(e,d)=>{r.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});r.end(d)})}).listen(5199)"

# 2) Chrome headless con el puerto de depuración abierto
chrome --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/p about:blank

# 3) la sonda
node pruebas/sonda-app.mjs
```

`pruebas/sonda-app.mjs` ejecuta 28 comprobaciones contra la app servida de verdad:
dependencias pinneadas, Tailwind efectivamente aplicado, el flujo completo de
anonimización, que ningún dato crudo quede en el bloque de salida, que la tabla de
equivalencias sí conserve los originales (reversibilidad), que no haya peticiones a
ningún backend, y sondas de desbordamiento a 1280/900/520 px.

## Notas de mantenimiento

- **Las dependencias de CDN van con versión exacta.** `cdn.tailwindcss.com` responde
  HTTP 200 a versiones que no existe y entonces los estilos no se aplican sin ningún
  error de red: la última versión servida por ese CDN es la `3.4.17`. Un 200 no prueba
  que la dependencia cargue — hay que comprobar un estilo computado.
- Soporte de `.doc` legado sin verificar: el selector lo acepta y pasa por
  `mammoth.extractRawText`, documentada para OOXML (`.docx`).
- La exportación a Word es HTML con estilos `mso-*` en un blob `application/msword`,
  no un `.docx` OOXML real.
- Pendiente: QA en móvil real (las sondas de ancho son emulación por CDP).
