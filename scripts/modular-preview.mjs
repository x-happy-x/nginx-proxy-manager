// Local UI acceptance fixture: real Core, isolated Account/worker stubs, no router access.
// Never install or expose this development-only process on a network interface.
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = path.join(root, '.local/modular-preview');
await mkdir(path.join(state, 'credentials'), { recursive: true });
const catalog = JSON.parse(await readFile(path.join(root, 'integrations/catalog.json'), 'utf8'));
const requested = new Set((process.argv[2] || '').split(','));
const servers = [];
async function listen(handler) { const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server); return `http://127.0.0.1:${server.address().port}`; }
const account = await listen((req, res) => { res.writeHead(204, { 'X-Gate-Login': 'local-preview', 'X-Gate-Role': 'admin' }); res.end(); });
const items = [];
for (const item of catalog.filter(i => requested.has(i.id))) {
  const endpoint = await listen((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') { res.end(JSON.stringify({status:'ok'})); return; }
    if (req.url === '/api/core/status') { res.end(JSON.stringify({ok:true,status:{installed:true,running:false,controller_ok:false}})); return; }
    res.writeHead(503); res.end(JSON.stringify({ok:false,error:'Изолированная проверка интерфейса: устройство не подключено'}));
  });
  const manifest = JSON.parse(await readFile(path.join(root, '.runtime/modules/linux-arm64', item.id, '1.0.0/manifest.json'), 'utf8'));
  manifest.arch = 'amd64'; manifest.backend.endpoint = endpoint;
  items.push({ manifest, enabled:true, connection:'unconfigured' });
  await writeFile(path.join(state, 'credentials', `${item.id}.token`), 'local-preview-only-credential-not-for-deployment');
  await cp(path.join(root, 'frontend/static/integrations', item.id), path.join(state, 'packages', item.id, '1.0.0/ui'), {recursive:true});
}
await writeFile(path.join(state, 'registry.json'), JSON.stringify({schema:1,items}));
await writeFile(path.join(state, 'config.json'), JSON.stringify({listen:'127.0.0.1:48659',state_dir:state,static_dir:path.join(root,'frontend/static/core'),packages_dir:path.join(state,'packages'),account_url:account,dms_url:'http://127.0.0.1:48660',dms_token_file:path.join(state,'absent-dms-token')}));
const binary = path.join(state, process.platform === 'win32' ? 'core.exe' : 'core');
const built = spawnSync('go',['build','-o',binary,'./core'],{cwd:path.join(root,'backend'),stdio:'inherit'});
if (built.status!==0) throw new Error('Core build failed');
const child = spawn(binary,['-config',path.join(state,'config.json')],{cwd:root,stdio:'inherit'});
child.on('exit',code=>{servers.forEach(s=>s.close());process.exitCode=code||0;});
process.on('SIGINT',()=>{child.kill();servers.forEach(s=>s.close());});
console.log('UI fixture at http://127.0.0.1:48659 — no live device connections');
