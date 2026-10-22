import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CDP = process.env.FUTURIA_CDP || 'http://127.0.0.1:9334';
// Deja el navegador con una sola pestaña en blanco. Sin esto, cada sonda
// arranca sobre el estado que dejó la anterior y los fallos son intermitentes.
async function resetBrowserTabs() {
  try {
    const list = await (await fetch(CDP + '/json/list')).json();
    const pages = list.filter(t => t.type === 'page');
    const fresh = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
    for (const page of pages) {
      if (page.id !== fresh.id) await fetch(CDP + '/json/close/' + page.id);
    }
  } catch { /* sin navegador la propia sonda informará del fallo */ }
}
const runs = [];
const commands = [
  ['motor, revisión y servidores', ['--test', '--test-reporter=tap', 'pruebas/test-seguridad.mjs', 'pruebas/test-fase0-motor.mjs', 'pruebas/test-servidor.mjs', 'pruebas/test-correcciones-ui.mjs', 'pruebas/test-servidor-aislado.mjs', 'pruebas/test-document-edits.mjs',
 'pruebas/test-revision-final-produccion.mjs', 'pruebas/test-document-model.mjs', 'pruebas/test-document-export.mjs', 'pruebas/test-cargas-y-limites-produccion.mjs', 'pruebas/test-mensajes-produccion.mjs']],
  ['regresión general', ['pruebas/sonda-app.mjs']],
  ['Fase 0: flujo, diálogos, popovers, móvil', ['pruebas/sonda-fase0.mjs']],
  ['extracción y límites', ['pruebas/sonda-correccion.mjs']],
  ['interfaz', ['pruebas/sonda-interfaz.mjs']],
  ['organización aprobada y plegables', ['pruebas/sonda-organizacion.mjs']],
  ['cabeceras de apertura: escritorio y móvil', ['pruebas/sonda-cabeceras.mjs']],
  ['aviso de guardado y memoria de sesión', ['pruebas/sonda-nota-sesion.mjs']],
  ['navegación móvil y pestaña activa completa', ['pruebas/sonda-navegacion-produccion.mjs']],
  ['Word y visor', ['pruebas/sonda-doc-y-visor.mjs']],
  ['seguridad y privacidad', ['pruebas/sonda-seguridad.mjs']],
  ['fixture PDF 12 páginas', ['pruebas/sonda-multipagina-visor.mjs']],
  ['documentos: controles y alcance', ['pruebas/sonda-documentos.mjs']],
  ['documentos: archivos reales y 200 páginas', ['pruebas/sonda-documentos-e2e.mjs', '--large']],
];
for (const [name, args] of commands) {
  // Las sondas CDP comparten la misma pestaña del navegador: sin limpiarla,
  // una sonda hereda el estado que dejó la anterior (pestaña activa, texto
  // cargado, diálogos abiertos) y falla de forma intermitente aunque la app
  // esté bien. Se deja una única pestaña en blanco antes de cada sonda.
  if (args[0].startsWith('pruebas/sonda-')) await resetBrowserTabs();
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 240000, env: { ...process.env, FUTURIA_REQUIRE_DOCUMENT_DEPS: '1' } });
  const output = (result.stdout || '') + (result.stderr || '');
  let total = 0, passed = 0;
  if (name === 'motor, revisión y servidores') {
    total = Number(output.match(/# tests (\d+)/)?.[1]);
    passed = Number(output.match(/# pass (\d+)/)?.[1]);
  } else if (name === 'seguridad y privacidad') {
    const report = JSON.parse(readFileSync(new URL('resultado-seguridad.json', import.meta.url), 'utf8'));
    total = report.total; passed = report.passed;
  } else if (name !== 'fixture PDF 12 páginas') {
    const match = output.match(/TOTAL:\s*(\d+)\s*\|\s*OK:\s*(\d+)\s*\|\s*FALLAS:\s*(\d+)/);
    total = Number(match?.[1]); passed = Number(match?.[2]);
  }
  const fixtureOK = name !== 'fixture PDF 12 páginas' || (/marcadores encontrados: 12 de 12/.test(output) && /respaldo confidencial .doc: true/.test(output));
  const ok = result.status === 0 && fixtureOK && (name === 'fixture PDF 12 páginas' || (Number.isFinite(total) && total > 0 && total === passed));
  runs.push({name, total, passed, ok, exitCode:result.status, output});
  console.log(name + ': ' + (ok ? 'OK' : 'FALLA') + (total ? ' ' + passed + '/' + total : ''));
  if (!ok) { console.log(output); break; }
}
const report = {
  date: new Date().toISOString(),
  appSha256: createHash('sha256').update(readFileSync(new URL('../index.html', import.meta.url))).digest('hex'),
  total: runs.reduce((sum, run) => sum + (run.total || 0), 0),
  passed: runs.reduce((sum, run) => sum + (run.passed || 0), 0),
  complete: runs.length === commands.length && runs.every(run => run.ok),
  runs,
};
writeFileSync(new URL('qa-resumen.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ total: report.total, passed: report.passed, complete: report.complete, appSha256: report.appSha256 }, null, 2));
if (!report.complete) process.exitCode = 1;
