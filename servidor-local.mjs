// Solo sirve la aplicación; no recibe ni almacena documentos.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const PUERTO = Number(process.env.ANON_PORT || 5199);
const INDEX = new URL('./index.html', import.meta.url);
const headers = {
  'X-Anonimizador-Server': 'futuria-local-2',
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const server = createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { ...headers, Allow: 'GET, HEAD' });
    req.resume();
    return res.end('Método no permitido');
  }
  try {
    const path = decodeURIComponent((req.url || '/').split('?')[0]);
    // Lista cerrada: jamás exponer .git, pruebas, README ni otros archivos.
    if (!['/', '/index.html'].includes(path)) {
      res.writeHead(404, headers);
      return res.end(req.method === 'HEAD' ? '' : 'No encontrado');
    }
    const data = await readFile(INDEX);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, headers);
    res.end(req.method === 'HEAD' ? '' : 'No encontrado');
  }
});
server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? 'El puerto ' + PUERTO + ' ya está en uso.' : 'No se pudo iniciar el servidor local: ' + err.code);
  process.exitCode = 1;
});
// No escuchar en la red local ni en todas las interfaces.
server.listen(PUERTO, '127.0.0.1', () => {
  console.log('Anonimizador IA sirviendo en http://127.0.0.1:' + PUERTO);
});
