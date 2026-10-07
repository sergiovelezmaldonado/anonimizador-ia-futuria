// Servidor estático local para ver el Anonimizador IA.
// Uso: node servidor-local.mjs   ->  http://localhost:5199
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PUERTO = 5199;
const RAIZ = process.cwd();

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    let ruta = decodeURIComponent((req.url || '/').split('?')[0]);
    if (ruta === '/' || ruta === '') ruta = '/index.html';

    // no permitir salir de la carpeta del proyecto
    const abs = normalize(join(RAIZ, ruta));
    if (!abs.startsWith(RAIZ)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('403 prohibido');
    }

    const datos = await readFile(abs);
    res.writeHead(200, {
      'Content-Type': TIPOS[extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(datos);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 no encontrado');
  }
}).listen(PUERTO, () => {
  console.log('Anonimizador IA sirviendo en http://localhost:' + PUERTO);
  console.log('Carpeta: ' + RAIZ);
  console.log('Para detenerlo: Ctrl+C en esta terminal.');
});
