// A loopback-only design preview. It exposes no credentials or arbitrary commands.
import { createServer } from 'node:http';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectHardwareDesign } from './collect-hardware-design.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.argv[2]||48690), origin=`http://127.0.0.1:${port}`;
const dataPath=resolve(root,'.local/qa/NPM-96/hardware.json');
let collecting=null;
const files=new Map([
  ['/docs/machines-hardware-design.html',['docs/machines-hardware-design.html','text/html; charset=utf-8']],
  ['/docs/machines-hardware-data.js',['docs/machines-hardware-data.js','text/javascript; charset=utf-8']],
  ['/frontend/src/styles/tokens.css',['frontend/src/styles/tokens.css','text/css; charset=utf-8']],
]);
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  // Reject DNS rebinding and cross-origin refreshes before any collector runs.
  if(req.headers.host!==`127.0.0.1:${port}`){res.writeHead(403).end();return;}
  const path=new URL(req.url,origin).pathname;
  try{
    if(path==='/api/hardware-design/refresh' && req.method==='POST'){
      if(req.headers['x-homenet-preview']!=='1'||(req.headers.origin&&req.headers.origin!==origin)){res.writeHead(403).end();return;}
      if(!collecting)collecting=collectHardwareDesign().then(async data=>{await mkdir(dirname(dataPath),{recursive:true});await writeFile(dataPath,JSON.stringify(data));return data;}).finally(()=>{collecting=null;});
      const data=await collecting;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));return;
    }
    if(path==='/api/hardware-design' && req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(await readFile(dataPath));return;}
    const file=files.get(path);
    if(file && req.method==='GET'){res.setHeader('Content-Type',file[1]);res.end(await readFile(resolve(root,file[0])));return;}
    res.writeHead(404).end('Not found');
  }catch{res.writeHead(503,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Сбор пока недоступен. Проверьте сборку агента и SSH-доступ.'}));}
});
server.listen(port,'127.0.0.1',()=>console.log(`${origin}/docs/machines-hardware-design.html`));
