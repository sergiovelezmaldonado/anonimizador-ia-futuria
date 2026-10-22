// Comprueba que el paquete se puede construir desde un CLON LIMPIO del
// repositorio. El despliegue de 31de6a7 falló porque un artefacto que el build
// necesita estaba en .gitignore: en local existía y en el alojamiento no.
// Aquí no se construye de verdad (sería lento); se afirma que todos los
// archivos que el build LEE están versionados en git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const versionados = new Set(git(['ls-files']).split('\n').map(l => l.trim()).filter(Boolean));

test('los archivos de vendor que el build necesita están versionados', () => {
  const build = readFileSync(path.join(root, 'scripts/build-produccion.mjs'), 'utf8');
  // Entradas [nombre, archivo, url, directorio] cuyo directorio es vendor/.
  const entradas = [...build.matchAll(/'([^']+)',\s*'([^']+\.m?js)',\s*'[^']*',\s*'(vendor\/[^']+)'/g)];
  assert.ok(entradas.length >= 1, 'no se encontró ninguna biblioteca servida desde vendor/');
  const exigidos = new Set();
  for (const [, nombre, archivo, dir] of entradas) {
    exigidos.add(dir + '/' + archivo);
    exigidos.add(dir + '/bundle-manifest.json');
    assert.ok(nombre.length > 0);
  }
  const faltan = [...exigidos].filter(rel => !versionados.has(rel));
  assert.deepEqual(faltan, [], 'el build los lee y no están en git (un clon limpio no puede construir): ' + faltan.join(', '));
});

test('ningún archivo que el build necesita está excluido por .gitignore', () => {
  const build = readFileSync(path.join(root, 'scripts/build-produccion.mjs'), 'utf8');
  const dirs = [...new Set([...build.matchAll(/'(vendor\/[^']+)'/g)].map(m => m[1]))];
  assert.ok(dirs.length > 0, 'no se detectaron directorios de vendor');
  for (const dir of dirs) {
    const ignorados = git(['ls-files', '--others', '--ignored', '--exclude-standard', '--', dir])
      .split('\n').map(l => l.trim()).filter(Boolean);
    assert.deepEqual(ignorados, [], 'hay archivos ignorados en ' + dir + ': ' + ignorados.join(', '));
  }
});

test('el repositorio no tiene cambios sin registrar al verificar el release', () => {
  // Un artefacto presente solo en el working tree pasa en local y falla en el
  // alojamiento; esta comprobación lo saca a la luz antes de publicar.
  const pendientes = git(['status', '--porcelain', '--', 'vendor', 'scripts', 'index.html'])
    .split('\n').map(l => l.trim()).filter(Boolean);
  assert.deepEqual(pendientes, [], 'sin registrar: ' + pendientes.join(' | '));
});

test('git entrega el bundle con los bytes exactos cuyo hash se verifica', () => {
  // Sin .gitattributes, Git puede normalizar los finales de línea al clonar y
  // el hash del alojamiento deja de coincidir con el aprobado.
  const manifest = JSON.parse(readFileSync(path.join(root, 'vendor/mammoth-browser/bundle-manifest.json'), 'utf8'));
  const rel = 'vendor/mammoth-browser/mammoth.browser.min.js';
  const enDisco = createHash('sha256').update(readFileSync(path.join(root, rel))).digest('hex');
  assert.equal(enDisco, manifest.sha256, 'el bundle en disco no coincide con su manifiesto');
  // Lo que git tiene guardado debe ser byte a byte lo mismo.
  const enGit = execFileSync('git', ['show', 'HEAD:' + rel], { cwd: root, maxBuffer: 1 << 28 });
  assert.equal(createHash('sha256').update(enGit).digest('hex'), manifest.sha256,
    'git guarda bytes distintos: revisa .gitattributes (vendor/** -text)');
  const attrs = readFileSync(path.join(root, '.gitattributes'), 'utf8');
  assert.match(attrs, /vendor\/\*\*\s+-text/, '.gitattributes debe marcar vendor/** como binario');
});

test('git guarda index.html con los bytes exactos que se verifican', () => {
  // Un .gitattributes que normalice los finales de línea de la fuente hace que
  // el clon del alojamiento construya un artefacto con OTRA huella que la
  // aprobada, y `git status` no avisa de nada.
  const enDisco = createHash('sha256').update(readFileSync(path.join(root, 'index.html'))).digest('hex');
  const enGit = execFileSync('git', ['show', 'HEAD:index.html'], { cwd: root, maxBuffer: 1 << 28 });
  assert.equal(createHash('sha256').update(enGit).digest('hex'), enDisco,
    'git guarda index.html con otros bytes: el clon construiría una huella distinta de la verificada (revisa .gitattributes)');
});

test('la huella del paquete corresponde a la fuente versionada', () => {
  // Cierra el círculo: lo que firma el manifiesto debe ser lo que hay en git.
  let manifest;
  try { manifest = JSON.parse(readFileSync(path.join(root, 'dist/build-manifest.json'), 'utf8')); }
  catch { return; } // sin dist/ construido no hay nada que comparar
  const enGit = execFileSync('git', ['show', 'HEAD:index.html'], { cwd: root, maxBuffer: 1 << 28 });
  assert.equal(manifest.inputs['index.html'], createHash('sha256').update(enGit).digest('hex'),
    'el paquete se construyó desde una fuente distinta de la versionada: reconstruye tras commitear');
});
