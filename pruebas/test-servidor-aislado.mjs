// Todos los servidores de este archivo son propios y usan puertos efímeros, nunca 5199.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
const launcher = fileURLToPath(new URL('../abrir-local.mjs', import.meta.url));
const serverPath = fileURLToPath(new URL('../servidor-local.mjs', import.meta.url));
const exec = promisify(execFile);
const protection = {'x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY','cache-control':'no-store'};
const title = '<title>Anonimizador IA — FuturIA</title>';
const runLauncher = port => exec(process.execPath,[launcher],{cwd:homedir(),env:{...process.env,ANON_PORT:String(port),ANON_NO_BROWSER:'1'}});
async function withFixture(headers, closedPaths, body) {
  const old=createServer((req,res)=>{
    res.writeHead(closedPaths && req.url!=='/' ? 404 : 200,headers);
    res.end(title);
  });
  await new Promise(resolve=>old.listen(0,'127.0.0.1',resolve));
  try { await body(old.address().port); }
  finally { await new Promise(resolve=>old.close(resolve)); }
}
test('aislado: una versión antigua se rechaza aunque tenga título y cabeceras', async () => {
  await withFixture({...protection,'x-anonimizador-server':'futuria-local-1'},true,async port=>{
    await assert.rejects(runLauncher(port),error=>error.code===1 && /antigua|reinici|versi[oó]n/i.test(error.stderr));
  });
});
test('aislado: la versión actual sin protecciones no se reutiliza', async () => {
  await withFixture({'x-anonimizador-server':'futuria-local-2'},true,async port=>{
    await assert.rejects(runLauncher(port),error=>error.code===1 && /reinici|protecci[oó]n|cabeceras/i.test(error.stderr));
  });
});
test('aislado: una marca y cabeceras correctas no bastan si todavía expone Git', async () => {
  await withFixture({...protection,'x-anonimizador-server':'futuria-local-2'},false,async port=>{
    await assert.rejects(runLauncher(port),error=>error.code===1 && /reinici|protecci[oó]n|archivos/i.test(error.stderr));
  });
});
test('aislado: servidor real tiene versión, lista cerrada y launcher compatible desde otra carpeta', async () => {
  const reserve=createServer(); await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port; await new Promise(resolve=>reserve.close(resolve));
  assert.notEqual(port,5199);
  const child=spawn(process.execPath,[serverPath],{env:{...process.env,ANON_PORT:String(port)},cwd:homedir(),stdio:['ignore','pipe','pipe'],windowsHide:true});
  let spawnError, output='';
  child.on('error',error=>{spawnError=error;});
  child.stdout.on('data',data=>{output+=data;}); child.stderr.on('data',data=>{output+=data;});
  const closed=new Promise(resolve=>child.on('close',resolve));
  try {
    const base='http://127.0.0.1:'+port;
    let page;
    for(let n=0;n<80;n++) {
      if(spawnError)throw spawnError;
      if(child.exitCode!==null)throw new Error(output);
      try {page=await fetch(base+'/',{signal:AbortSignal.timeout(200)});break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.ok(page,'servidor aislado listo: '+output);
    assert.equal(page.headers.get('x-anonimizador-server'),'futuria-local-2');
    assert.match(await page.text(),/Anonimizador IA/);
    for(const path of ['/.git/config','/README.md','/pruebas/test-servidor.mjs','/..%2f..%2fsecret.txt']) {
      assert.equal((await fetch(base+path)).status,404,path);
    }
    const head=await fetch(base+'/',{method:'HEAD'});
    assert.equal(head.status,200); assert.equal(await head.text(),'');
    for(const [key,value] of Object.entries(protection))assert.equal(head.headers.get(key),value);
    assert.equal(head.headers.get('set-cookie'),null);
    assert.equal((await fetch(base+'/',{method:'POST'})).status,405);
    const result=await runLauncher(port);
    assert.match(result.stdout,new RegExp('lista.*127\\.0\\.0\\.1:'+port));
  } finally { if(child.exitCode===null)child.kill(); await closed; }
});
test('aislado: error de spawn se maneja y explica, sin evento error sin escuchar', async () => {
  let handled=false; const messages=[];
  const fakeProcess={env:{ANON_PORT:'53001',ANON_NO_BROWSER:'1'},execPath:'fixture-node.exe'};
  const source=readFileSync(launcher,'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('import.meta.url',JSON.stringify(new URL('../abrir-local.mjs',import.meta.url).href));
  await vm.runInNewContext('(async()=>{'+source+'})()',{
    process:fakeProcess,dirname:()=>homedir(),fileURLToPath,URL,AbortSignal,
    fetch:async()=>{throw new Error('conexión no disponible');},
    setTimeout:callback=>setTimeout(callback,1),
    console:{log:message=>messages.push(message),error:message=>messages.push(message)},
    spawn:()=>{
      const child=new EventEmitter();child.unref=()=>{};
      child.on('error',()=>{handled=child.listenerCount('error')>1;});
      queueMicrotask(()=>{const error=new Error('spawn ENOENT');error.code='ENOENT';child.emit('error',error);});
      return child;
    },
  });
  assert.equal(handled,true,'el lanzador registra su manejador de error de spawn');
  assert.equal(fakeProcess.exitCode,1);
  assert.ok(messages.some(message=>/iniciar.*ENOENT|ENOENT.*iniciar/i.test(message)));
});
