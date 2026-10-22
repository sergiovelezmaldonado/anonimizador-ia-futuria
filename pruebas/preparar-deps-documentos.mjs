// Descarga SOLO bibliotecas de prueba fijadas y comprueba sus hashes SRI.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const dest=process.env.FUTURIA_EXPORT_TEST_DEPS||path.join(process.env.LOCALAPPDATA,'hermes/cache/scratch');fs.mkdirSync(dest,{recursive:true});
const section=html.match(/const assets = \{[\s\S]*?\n  \};/)[0],assets=[...section.matchAll(/url: '([^']+)'[\s\S]*?integrity: 'sha384-([^']+)'/g)];
if(assets.length!==3)throw Error('Se esperaban tres dependencias de exportación fijadas.');
for(const [i,match] of assets.entries()){
 const [_,url,hash]=match;if(!/^https:\/\/(unpkg\.com|cdn\.jsdelivr\.net)\//.test(url))throw Error('Host no previsto.');
 const name=['docx','pdfmake','vfs_fonts'][i],target=path.join(dest,'text-export-vendor-'+name+'.js');
 let bytes=fs.existsSync(target)?fs.readFileSync(target):null;
 if(!bytes||createHash('sha384').update(bytes).digest('base64')!==hash){const r=await fetch(url,{signal:AbortSignal.timeout(45000)});if(!r.ok)throw Error('HTTP '+r.status);bytes=Buffer.from(await r.arrayBuffer());}
 if(createHash('sha384').update(bytes).digest('base64')!==hash)throw Error('Integridad incorrecta: '+name);
 fs.writeFileSync(target,bytes);console.log(name+': SRI correcto ('+bytes.length+' bytes)');
}
console.log('Para DOCX/PDF de integración: npm install --prefix "'+path.join(dest,'text-document-test-deps')+'" --ignore-scripts mammoth@1.8.0 jsdom@26.1.0 pdfjs-dist@3.11.174');
