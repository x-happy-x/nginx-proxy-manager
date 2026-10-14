// Local UI acceptance fixture: real Core, isolated Account/worker stubs, no router access.
// Never install or expose this development-only process on a network interface.
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root,'.local'),{recursive:true});
const state = await mkdtemp(path.join(root, '.local/modular-preview-'));
await mkdir(path.join(state, 'credentials'), { recursive: true });
const catalog = JSON.parse(await readFile(path.join(root, 'integrations/catalog.json'), 'utf8'));
const port=Number(process.argv[3]||48659);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local preview port');
const requested = new Set((process.argv[2] || '').split(','));
const servers = [];
async function listen(handler) { const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server); return `http://127.0.0.1:${server.address().port}`; }
const account = await listen((req, res) => { res.writeHead(204, { 'X-Gate-Login': 'local-preview', 'X-Gate-Role': 'admin' }); res.end(); });
const now = Date.now(), iso = t => new Date(t).toISOString();
const previewWidgets = {
  '/api/core/widgets/channel': { state: 'warn', updated_at: iso(now - 60e3), note: 'с 15:14 · пример', body: { label: 'Белые списки', items: [{ text: 'Яндекс', ok: true }, { text: 'Google', ok: false }] } },
  '/api/core/widgets/services': { state: 'warn', updated_at: iso(now - 4 * 60e3), note: 'не открывается: Telegram', body: { value: '11 из 12' } },
  '/api/core/widgets/servers': () => ({ state: 'ok', updated_at: iso(now - 6 * 60e3), note: 'сейчас 41 из 690 · стабильных 8 · пример', body: { unit: 'серверов', points: Array.from({ length: 288 }, (_, i) => [iso(now - (287 - i) * 300e3), Math.round(30 + 20 * Math.sin(i / 25) + (i > 150 && i < 200 ? -22 : 0))]), bands: [{ from: iso(now - 137 * 300e3), to: iso(now - 87 * 300e3), label: 'белые списки' }] } }),
  '/api/core/widgets/traffic-month': { state: 'ok', updated_at: iso(now - 60e3), note: 'лимит не задан · с 01.10', body: { value: '255,8', unit: 'ГБ' } },
  '/api/core/widgets/olcrtc': { state: 'ok', updated_at: iso(now - 3 * 60e3), note: 'резервный канал · UDP через реле', body: { label: '2 из 2 работают', items: [{ text: 'VDSKA jitsi', ok: true, value: '205 мс' }, { text: 'VDSKA telemost', ok: true, value: '310 мс' }] } },
  '/api/core/summary/attention': { items: [{ id: 'service-telegram', severity: 'warning', text: '«Telegram» не открывается: нет ответа за 8 с', since: iso(now - 20 * 60e3), action: { label: 'Разобрать', page: 'vpnsvc' } }, { id: 'channel', severity: 'info', text: 'Пример: сведения без действия' }] },
  '/api/nginx/widgets/domains': { state: 'ok', updated_at: iso(now - 60e3), note: 'nginx работает', body: { value: '24', unit: 'домена' } },
  '/api/nginx/widgets/certificates': { state: 'warn', updated_at: iso(now - 60e3), note: 'истекают в ближайшие 14 дн.: 1', body: { items: [{ text: 'old.example', state: 'warn', value: 'до 20.10 · 5 дн.', page: 'certs' }, { text: 'home.example', state: 'ok', value: 'до 12.12 · 59 дн.', page: 'certs' }], more: 21 } },
  '/api/nginx/widgets/requests-day': () => ({ state: 'ok', updated_at: iso(now - 60e3), note: '18 240 запросов · ошибок 0,8% · пример', body: { unit: 'запросов', points: Array.from({ length: 60 }, (_, i) => [iso(now - (59 - i) * 1440e3), Math.round(200 + 180 * Math.sin(i / 9 + 1) ** 2)]) } }),
  '/api/nginx/summary/attention': { items: [{ id: 'cert-old.example', severity: 'warning', text: 'Сертификат old.example истекает через 5 дн.', action: { label: 'Сертификаты', page: 'certs' } }] },
  '/api/network/widgets/internet': { state: 'ok', updated_at: iso(now - 30e3), note: 'LTE: RSRP -97 дБм · SINR 11 дБ', body: { label: 'Есть интернет', items: [{ text: 'Netcraze', ok: true }, { text: 'MikroTik', ok: true }, { text: 'LTE', ok: true }, { text: 'Через mihomo', ok: true }] } },
  '/api/network/widgets/availability-day': () => ({ state: 'warn', updated_at: iso(now - 60e3), note: 'интернет был 98,7% суток · худший час 71% · пример', body: { unit: '%', scale: 'linear', bars: Array.from({ length: 24 }, (_, i) => ({ label: `${String(i).padStart(2, '0')}:00`, value: i === 15 ? 71 : 100 })) } }),
  '/api/network/summary/attention': { items: [] },
  '/api/core/summary/tasks': { items: [{ id: 'olcrtc-setup', label: 'OLCRTC: настройка сервера', value: 3, total: 9, step: 'сборка olcrtc' }] },
};
const items = [];
for (const item of catalog.filter(i => requested.has(i.id))) {
  const endpoint = await listen((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') { res.end(JSON.stringify({status:'ok'})); return; }
    // NPM-66: sample home widgets so the page can be checked without a router
    const sample = previewWidgets[req.url.split('?')[0]];
    if (sample) { setTimeout(() => res.end(JSON.stringify(typeof sample === 'function' ? sample() : sample)), req.url.includes('olcrtc') ? 2500 : 0); return; }
    if (req.url === '/api/core/status') { res.end(JSON.stringify({ok:true,status:{installed:true,running:false,controller_ok:false}})); return; }
    res.writeHead(503); res.end(JSON.stringify({ok:false,error:'Изолированная проверка интерфейса: устройство не подключено'}));
  });
  const manifest = JSON.parse(await readFile(path.join(root, '.runtime/modules/linux-amd64', item.id, '1.0.0/manifest.json'), 'utf8'));
  manifest.arch = 'amd64'; manifest.backend.endpoint = endpoint;
  // a custom widget the VPN entry does not export: shows the «не отрисовался» path
  if (item.id === 'vpn' && manifest.ui.widgets) manifest.ui.widgets.push({ id: 'preview-custom', title: 'Свой виджет (проверка ошибки)', kind: 'custom', sizes: ['m'], modes: ['pro'], default: { pro: 99 } });
  items.push({ manifest, enabled:true, connection:'unconfigured' });
  await writeFile(path.join(state, 'credentials', `${item.id}.token`), 'local-preview-only-credential-not-for-deployment');
  const destination=path.join(state,'packages',item.id,'1.0.0');
  await cp(path.join(root,'.runtime/modules/linux-amd64',item.id,'1.0.0'),destination,{recursive:true});
  await writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest));
}
await writeFile(path.join(state, 'registry.json'), JSON.stringify({schema:1,items}));
await writeFile(path.join(state, 'config.json'), JSON.stringify({manage_workers:false,listen:`127.0.0.1:${port}`,state_dir:state,static_dir:path.join(root,'frontend/static/core'),packages_dir:path.join(state,'packages'),account_url:account,dms_url:'http://127.0.0.1:48660',dms_token_file:path.join(state,'absent-dms-token')}));
const binary = path.join(state, process.platform === 'win32' ? 'core.exe' : 'core');
const built = spawnSync('go',['build','-o',binary,'./core'],{cwd:path.join(root,'backend'),stdio:'inherit'});
if (built.status!==0) throw new Error('Core build failed');
const child = spawn(binary,['-config',path.join(state,'config.json')],{cwd:root,stdio:'inherit'});
child.on('exit',code=>{servers.forEach(s=>s.close());process.exitCode=code||0;});
process.on('SIGINT',()=>{child.kill();servers.forEach(s=>s.close());});
console.log(`UI fixture at http://127.0.0.1:${port} — no live device connections`);
