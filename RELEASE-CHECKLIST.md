# Puerta de salida a producción — App 7 Anonimizador IA

Estado: **candidata aprobada técnicamente.** Queda el despliegue y las pruebas que exigen dispositivos reales (ver «Pendiente»).

Candidata: `index.html` sha256 **3c187f1900bf541254f968d1cbdc90dbdb2f76f9cb64165ee9a33c67dd94b13c**

## Alcance de esta versión

Herramienta gratuita que procesa todo en el navegador: sustituye datos sensibles del texto por etiquetas, deja revisar el resultado, lo descarga en Word, PDF, TXT o JSON y lo restaura con su llave. Conserva la estructura del texto (títulos, listas, negrita, cursiva), no imágenes, gráficos ni el diseño original. Sin guardado automático de documentos ni de llaves.

## Requisitos de autorización

- [x] Aviso visible de que no hay guardado automático, en Anonimizar y en Restaurar; explica qué archivos conservar y que «Borrar sesión» no elimina descargas ni portapapeles. 24/24.
- [x] Los bloques de apertura conservan el fondo aprobado `#fff5f6` en las cuatro pestañas de contenido. 26/26.
- [x] La pestaña activa se ve completa en pantallas estrechas y se explica que la barra se desliza. 17/17 a 360/390/1366 px.
- [x] Sin promesas de utilidad idéntica de la IA ni de exposición cero; se distingue la ausencia de analítica propia de los registros técnicos del alojamiento. 4/4.
- [x] **La lista «Deja visibles estas palabras» falla cerrada.** Una palabra autorizada protege exactamente lo que el usuario escribió; el resto del dato se anonimiza igual, el semáforo escanea el texto íntegro con el mismo criterio que el motor, y la interfaz avisa cuando una palabra solo cubre parte de un dato. Revisión independiente con ~59.500 casos de fuzzing determinista: **cero fugas con semáforo verde**.
- [x] **Toda lectura asíncrona lleva guarda de generación**: documento de trabajo, documento a restaurar y llave, más los botones de modo y el pegado manual. Una lectura obsoleta no puede sustituir lo vigente ni avisar sobre un archivo que ya no lo es. Hay pruebas de comportamiento y dos reglas estructurales que lo exigen para cualquier manejador nuevo.
- [x] **El resaltado del texto restaurado no bloquea la página**: se construye con los intervalos exactos de la sustitución y se acota a 2.000 marcas, avisando cuando trunca. Con 100.000 datos restaurados pasó de 5.891 ms a ~42 ms, y desapareció el aborto del motor que cerraba la pestaña con la llave en memoria.
- [x] Los fallos de preparación y los límites producen un aviso y nunca un resultado parcial silencioso. 6/6.
- [x] La restauración es exacta carácter a carácter: el troceado ya no emite fragmentos degenerados que colapsaran espacios o tabuladores.
- [x] **Paquete de producción sin compiladores en el navegador**: `npm run build` precompila JSX y Tailwind y sirve las bibliotecas desde el propio origen con SRI; `npm run verify` comprueba bytes, hashes y lista blanca, y rechaza cualquier archivo no inventariado. 6/6.
- [x] **Dependencias al día y auditadas**: PDF.js 4.2.67 (incluye el parche de GHSA-wgrm-67xf-hhpq) y Mammoth 1.13.0 reconstruido en este repositorio con sus transitivas parcheadas. La auditoría declara **0 avisos** en lo que se sirve al usuario, con inventario embebido exacto: incluye las dependencias ocultas dentro de bundles ya empaquetados y no declara las ausentes.
- [x] **Suite completa sobre una única candidata: 429/429**, informe con huella coincidente, sin pruebas omitidas ni suites interrumpidas. Tres pasadas consecutivas sin fallos tras aislar las sondas del navegador.
- [x] **Recorrido real en navegador: 15/15**, con los cuatro formatos descargados y reimportados, sin una sola petición a internet y sin desbordamiento a 360 px.
- [x] **Revisión independiente sin hallazgos bloqueantes.** Cinco rondas; cada hallazgo cerrado con pruebas de regresión que fallan si el defecto reaparece.
- [ ] Commit y etiqueta de la candidata, con push verificado y rollback preparado a un artefacto anterior.
- [ ] Despliegue con HTTPS y cabeceras de protección; comprobar que los archivos públicos coinciden con los hashes del paquete aprobado y que no se sirve el repositorio, las pruebas ni documentos privados.
- [ ] Anuncio o publicación en Substack solo después de comprobar el sitio desplegado.

## Pendiente (no bloquea la aprobación técnica)

- Prueba en teléfono físico y en navegadores adicionales: la emulación del navegador **no** sustituye este punto y no debe declararse hecho sin evidencia.
- `vercel.json` manda `X-Frame-Options: DENY` pero no envía cabecera CSP; el alojamiento debería servir la misma CSP que el servidor local, con `frame-ancestors 'none'`.
- Los bundles de `docx` y `pdfmake` se sirven tal como los publica cada proyecto: su contenido interno no lo prueba el lock de npm, solo su hash y su SRI.
- Documentar que una misma entidad escrita con otra grafía (mayúsculas o acentos distintos) se restaura con la grafía de su primera aparición.

## Hallazgos cerrados en la puerta de salida

Cinco revisiones independientes encontraron y se cerraron, en este orden: bloqueo del hilo principal al restaurar; carrera de carga del documento; inventario de dependencias embebidas primero incompleto y luego sobredeclarado; `import()` de PDF.js convertido en `require()` por Babel, que rompía toda carga de PDF; SRI del bundle reconstruido que el navegador rechazaba; `useEffect` sin desestructurar, que dejaba en blanco la pestaña Restaurar; carrera de la llave, incluido el cambio de modo; y la lista de palabras visibles fallando en abierto. Además se aisló la pestaña del navegador entre sondas, porque el estado heredado producía fallos intermitentes que no eran de la app.

## Límites que deben comunicarse

No hay garantía de detección completa: la app no reconoce todo nombre, cargo o lugar que identifique a alguien, y por eso el resultado siempre se revisa a mano antes de exportar. Los documentos escaneados necesitan OCR, que esta versión no incluye; los .doc antiguos deben convertirse a .docx. La llave y los documentos restaurados son confidenciales. Los archivos descargados, el portapapeles y sus sincronizaciones quedan fuera del borrado de sesión. No hay borrado forense ni protección frente a un equipo o una extensión comprometidos.
