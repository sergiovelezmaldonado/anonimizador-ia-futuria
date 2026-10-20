import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runs = [];
const commands = [
  ['motor, revisión y servidores', ['--test', '--test-reporter=tap', 'pruebas/test-seguridad.mjs', 'pruebas/test-servidor.mjs', 'pruebas/test-correcciones-ui.mjs', 'pruebas/test-servidor-aislado.mjs']],
  ['regresión general', ['pruebas/sonda-app.mjs']],
  ['extracción y límites', ['pruebas/sonda-correccion.mjs']],
  ['interfaz', ['pruebas/sonda-interfaz.mjs']],
  ['Word y visor', ['pruebas/sonda-doc-y-visor.mjs']],
  ['seguridad y privacidad', ['pruebas/sonda-seguridad.mjs']],
  ['fixture PDF 12 páginas', ['pruebas/sonda-multipagina-visor.mjs']],
];
for (const [name, args] of commands) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000 });
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
