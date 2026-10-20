import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
test('lanzador no reutiliza un servidor antiguo solo porque entregue el título de la app', async () => {
  const old = createServer((req,res)=>res.end('<title>Anonimizador IA — FuturIA</title>'));
  await new Promise(resolve=>old.listen(0,'127.0.0.1',resolve));
  try {
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../abrir-local.mjs', import.meta.url))], { env:{...process.env,ANON_PORT:String(old.address().port),ANON_NO_BROWSER:'1'} }), error=>error.code===1 && /antigua|reinici|versi[oó]n/i.test(error.stderr));
  } finally { await new Promise(resolve=>old.close(resolve)); }
});
test('lanzador comprueba el servidor desde otra carpeta sin abrir navegador en QA', async () => {
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../abrir-local.mjs', import.meta.url))], { cwd: homedir(), env: { ...process.env, ANON_NO_BROWSER: '1' } });
  assert.match(result.stdout, /lista.*127\.0\.0\.1:5199/i);
});
const base = 'http://127.0.0.1:5199';
test('servidor local sirve la app pero no Git, pruebas ni documentos privados', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Anonimizador IA/);
  for (const path of ['/.git/config', '/pruebas/medicion-nombres.json', '/README.md', '/..%2f..%2fsecret.txt']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});
test('servidor rechaza POST y entrega cabeceras de protección sin cookies', async () => {
  assert.equal((await fetch(base + '/', { method: 'POST', body: 'fixture-no-confidencial' })).status, 405);
  const page = await fetch(base + '/', { method: 'HEAD' });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('set-cookie'), null);
});
