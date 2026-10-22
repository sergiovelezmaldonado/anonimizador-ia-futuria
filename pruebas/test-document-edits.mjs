import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const ctx=vm.createContext({Intl});vm.runInContext(html.slice(html.indexOf('function cn('),html.indexOf('// ─── Texto de muestra')),ctx);
function apply(source,edits){let cursor=0,out='';for(const e of edits){assert.ok(Number.isInteger(e.start)&&Number.isInteger(e.end)&&e.start>=cursor&&e.end>=e.start);out+=source.slice(cursor,e.start)+e.replacement;cursor=e.end;}return out+source.slice(cursor);}
test('anonimizar devuelve intervalos exactos sin copias del original para remapear formato',()=>{const source='Cliente: Ana Ruiz. Correo ana@ejemplo.test. Ana Ruiz.';ctx.source=source;const r=vm.runInContext("runAnonymize(source,CATS.filter(c=>c.on),'')",ctx);assert.ok(Array.isArray(r.edits));assert.equal(apply(source,r.edits),r.out);assert.ok(r.edits.length>=3);assert.equal(JSON.stringify(r.edits).includes('Ana Ruiz'),false);});
test('restaurar devuelve intervalos exactos incluso al reparar etiquetas',()=>{const source='Hola [PERSONA 1], **[EMAIL_1]** y PERSONA_1.';ctx.source=source;const r=vm.runInContext("restoreTags(source,{'[PERSONA_1]':'Ana Ruiz','[EMAIL_1]':'ana@ejemplo.test'})",ctx);assert.ok(Array.isArray(r.edits));assert.equal(apply(source,r.edits),r.out);assert.equal(r.edits.length,3);});
