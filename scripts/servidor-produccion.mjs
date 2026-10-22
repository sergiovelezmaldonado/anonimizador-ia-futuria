// Servidor independiente: sólo el inventario estático de dist, nunca el checkout.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, MIME, sha256, allowedFile, verifyProduction } from './verificar-produccion.mjs';
export async function startProductionServer({ port = Number(process.env.ANON_PROD_PORT || 5200), host = '127.0.0.1', dist = path.join(ROOT, 'dist'), source = true } = {}) {
  if (host !== '127.0.0.1') throw new Error('Este servidor sólo escucha en loopback.');
  const verified = await verifyProduction({ dist, source });
  const { manifest, manifestBytes } = verified;
  const headers = {
    'X-Anonimizador-Server': 'futuria-production-1',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': manifest.security.csp + "; frame-ancestors 'self'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cache-Control': 'no-store',
  };
  const server = createServer(async (req, res) => {
    const respond = (code, text) => { const data = Buffer.from(text); res.writeHead(code, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': data.length }); res.end(req.method === 'HEAD' ? undefined : data); };
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); req.resume(); return respond(405, 'Método no permitido'); }
    try {
      const raw = (req.url || '/').split('?')[0];
      const pathname = decodeURIComponent(raw);
      const file = pathname === '/' ? 'index.html' : pathname.startsWith('/') ? pathname.slice(1) : '';
      if (!allowedFile(file) || (file !== 'build-manifest.json' && !Object.hasOwn(manifest.files, file))) return respond(404, 'No encontrado');
      // Las lecturas exactas mantienen el manifiesto como whitelist, sin fallback SPA.
      const bytes = file === 'build-manifest.json' ? manifestBytes : await readFile(path.join(dist, file));
      if (file !== 'build-manifest.json' && sha256(bytes) !== manifest.files[file].sha256) return respond(503, 'Asset modificado: reconstruye dist y reinicia el servidor.');
      res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file)], 'Content-Length': bytes.length, ETag: '"sha256-' + sha256(bytes) + '"' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { respond(404, 'No encontrado'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, url: 'http://' + host + ':' + server.address().port, verified };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url } = await startProductionServer();
  console.log('App7 dist (sólo estático): ' + url);
}
