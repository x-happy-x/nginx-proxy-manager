// Local UI acceptance fixture: real Core, isolated Account/worker stubs, no router access.
// Never install or expose this development-only process on a network interface.
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakePve } from './fixtures/pve.mjs';
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
  '/api/core/widgets/servers-reliability': { state: 'ok', updated_at: iso(now - 60e3), note: 'работают ≥90% времени: 8 из 690 · пример', body: { unit: 'серверов', scale: 'sqrt', bars: [588, 78, 4, 0, 0, 2, 10, 5, 3, 0].map((value, i) => ({ label: `${i * 10}–${i * 10 + 10}%`, value })) } },
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
const vpnBoard = process.env.PREVIEW_VPN_BOARD ? await readFile(process.env.PREVIEW_VPN_BOARD, 'utf8') : '';
const vpnNode = process.env.PREVIEW_VPN_BOARD ? await readFile(process.env.PREVIEW_VPN_BOARD.replace(/board\.json$/, 'node.json'), 'utf8').catch(() => '') : '';
const vpnBoard30 = process.env.PREVIEW_VPN_BOARD ? await readFile(process.env.PREVIEW_VPN_BOARD.replace(/board\.json$/, 'board30.json'), 'utf8').catch(() => '') : '';
// NPM-74: PREVIEW_PVE_KEY=<ssh key> PREVIEW_PVE_HOSTS=s1@192.168.99.10,pve3@192.168.99.30 answers the
// Proxmox screens with live agent data read from this PC (dev only; the key never leaves it).
const pveHosts = (process.env.PREVIEW_PVE_HOSTS || '').split(',').filter(Boolean).map(s => { const [id, address] = s.split('@'); return { id, name: id, address }; });
const pveCache = new Map();
function pveRead(h, request) {
  const key = `${h.id}/${request}`, hit = pveCache.get(key);
  if (hit && Date.now() - hit.at < 8000) return hit.value;
  const r = spawnSync('ssh', ['-i', process.env.PREVIEW_PVE_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', `root@${h.address}`, `/usr/local/bin/homenet-pve-agent serve ${request}`], { encoding: 'utf8', timeout: 12000 });
  const value = r.status === 0 ? { ok: true, body: r.stdout } : { ok: false, error: (r.stderr || 'ssh failed').trim().split('\n').pop() };
  pveCache.set(key, { at: Date.now(), value });
  return value;
}
function pveOverview() {
  return { configured: pveHosts.length > 0, error: '', hosts: pveHosts.map(h => {
    const r = pveRead(h, 'bundle'); const b = r.ok ? JSON.parse(r.body) : {};
    return { ...h, online: r.ok, error: r.error || '', latency_ms: 12, checked_at: iso(Date.now()), last_ok: r.ok ? iso(Date.now()) : undefined, current: b.current || null, hardware: b.hardware || null };
  }) };
}
// NPM-76: the «Умный дом» module runs its real worker. PREVIEW_HA=fake points it at a small
// fake Home Assistant below; PREVIEW_HA_URL + PREVIEW_HA_TOKEN_FILE at a real one (read-only API,
// the token stays in .local). Without either the settings page starts empty.
async function fakeHomeAssistant() {
  const ago = m => new Date(Date.now() - m * 60e3).toISOString();
  const dev = (id, name, area, ids) => [id, name, area, ids, false];
  const devices = [dev('bridge', 'Zigbee2MQTT Bridge', '', 'mqtt:zigbee2mqtt_bridge_0x1'), dev('ups', 'ИБП', 'Серверная', 'tuya:1'), dev('street', 'Лампа GX53 Улица 1', 'Улица', 'matter:1'),
    dev('door', 'Датчик двери', 'Коридор', 'mqtt:zigbee2mqtt_0xa1'), dev('remote', 'Пульт гостиной', 'Гостиная', 'mqtt:zigbee2mqtt_0xa2'), dev('motion', 'Датчик движения', 'Прихожая', 'mqtt:zigbee2mqtt_0xa3'),
    dev('lock', 'Замок', 'Прихожая', 'matter:2'), dev('kitchen', 'Свет на кухне', 'Кухня', 'mqtt:zigbee2mqtt_0xa4'), dev('hall', 'Свет в прихожей', 'Прихожая', 'mqtt:zigbee2mqtt_0xa5'), dev('core', 'Home Assistant Core', '', 'hassio:core')];
  const st = (entity_id, state, minutes, attributes = {}, device) => ({ entity_id, state, last_changed: ago(minutes), attributes, device });
  const states = [
    st('binary_sensor.zigbee2mqtt_bridge_connection_state', 'on', 600, { friendly_name: 'Zigbee2MQTT Bridge Connection state' }, 'bridge'),
    st('switch.ups', 'unavailable', 300, { friendly_name: 'ИБП' }, 'ups'), st('light.street_1', 'unavailable', 2000, { friendly_name: 'Улица 1' }, 'street'),
    st('sensor.door_battery', '14', 60, { device_class: 'battery', unit_of_measurement: '%' }, 'door'), st('binary_sensor.door', 'off', 60, {}, 'door'),
    st('sensor.remote_battery', '6', 60, { device_class: 'battery', unit_of_measurement: '%' }, 'remote'), st('sensor.motion_battery', '87', 60, { device_class: 'battery', unit_of_measurement: '%' }, 'motion'),
    st('binary_sensor.lock_battery', 'on', 60, { device_class: 'battery', friendly_name: 'Замок батарея' }, 'lock'),
    st('light.kitchen', 'on', 30, { friendly_name: 'Кухня' }, 'kitchen'), st('light.hall', 'on', 30, { friendly_name: 'Прихожая' }, 'hall'),
    st('light.all', 'on', 30, { friendly_name: 'Весь свет', entity_id: ['light.kitchen', 'light.hall'] }),
    st('update.home_assistant_core_update', 'on', 600, { title: 'Home Assistant Core', installed_version: '2026.7.2', latest_version: '2026.10.2' }, 'core'),
    st('update.zigbee2mqtt_update', 'on', 600, { title: 'Zigbee2MQTT', installed_version: '2.13.0', latest_version: '2.14.2' }),
    st('update.piper_update', 'on', 600, { title: 'Piper', installed_version: '2.3.2', latest_version: '2.5.2' }),
    st('sensor.backup_last_successful_automatic_backup', 'unknown', 600, { device_class: 'timestamp' }),
  ];
  const map = { e: states.filter(x => x.device).map(x => [x.entity_id, x.device]), d: devices };
  return listen((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/config') res.end(JSON.stringify({ version: '2026.7.2', location_name: 'Дом (пример)', external_url: 'https://ha.example.org', state: 'RUNNING' }));
    else if (req.url === '/api/states') res.end(JSON.stringify(states.map(({ device, ...x }) => x)));
    else if (req.url === '/api/template' && req.method === 'POST') { req.resume(); req.on('end', () => res.end(JSON.stringify(map))); }
    else { res.writeHead(404); res.end('{}'); }
  });
}
async function startHAWorker(item, manifestPath, tokenPath) {
  const dir = path.join(state, 'ha'); await mkdir(dir, { recursive: true });
  if (process.env.PREVIEW_HA === 'fake') await writeFile(path.join(dir, 'config.json'), JSON.stringify({ url: await fakeHomeAssistant(), token: 'preview-token-for-the-fake-home-assistant' }));
  else if (process.env.PREVIEW_HA_URL && process.env.PREVIEW_HA_TOKEN_FILE) await writeFile(path.join(dir, 'config.json'), JSON.stringify({ url: process.env.PREVIEW_HA_URL, token: (await readFile(process.env.PREVIEW_HA_TOKEN_FILE, 'utf8')).trim() }));
  const binary = path.join(state, process.platform === 'win32' ? 'ha-worker.exe' : 'ha-worker');
  const built = spawnSync('go', ['build', '-tags=integration_worker', '-ldflags=-X main.workerID=ha', '-o', binary, './manager'], { cwd: path.join(root, 'backend'), stdio: 'inherit' });
  if (built.status !== 0) throw new Error('ha worker build failed');
  const worker = spawn(binary, ['-manifest', manifestPath, '-token-file', tokenPath], { cwd: state, stdio: 'inherit', env: { ...process.env, HA_DIR: dir } });
  process.on('exit', () => worker.kill());
}
async function freePort() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const items = [];
for (const item of catalog.filter(i => requested.has(i.id))) {
  const endpoint = await listen((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') { res.end(JSON.stringify({status:'ok'})); return; }
    if (item.id === 'pve' && process.env.PREVIEW_PVE === 'fake' && fakePve(req, res)) return;
    if (item.id === 'pve' && pveHosts.length) {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/api/pve/overview') { res.end(JSON.stringify(pveOverview())); return; }
      if (url.pathname === '/api/pve/history') { const h = pveHosts.find(x => x.id === url.searchParams.get('host')); const r = h && pveRead(h, 'history'); if (r?.ok) res.end(r.body); else { res.writeHead(502); res.end(JSON.stringify({ error: r?.error || 'unknown host' })); } return; }
      if (url.pathname === '/api/pve/widgets/hosts') { const o = pveOverview(); res.end(JSON.stringify({ state: 'ok', updated_at: iso(Date.now()), note: 'пример', body: { label: 'Хосты Proxmox', items: o.hosts.map(h => ({ text: `${h.name} · CPU ${Math.round(h.current?.node.cpu || 0)}% · ${Math.round(h.current?.node.cpu_temp || 0)} °C`, ok: h.online })) } })); return; }
      if (url.pathname === '/api/pve/widgets/guests') { const o = pveOverview(); const g = o.hosts.flatMap(h => h.current?.guests || []).filter(x => !x.template); res.end(JSON.stringify({ state: 'ok', updated_at: iso(Date.now()), note: `всего ${g.length}`, body: { value: String(g.filter(x => x.status === 'running').length), unit: 'запущено' } })); return; }
      if (url.pathname === '/api/pve/widgets/temps') { const o = pveOverview(); res.end(JSON.stringify({ state: 'ok', updated_at: iso(Date.now()), body: { items: o.hosts.map(h => ({ text: `${h.name} · процессор`, value: `${Math.round(h.current?.node.cpu_temp || 0)} °C`, state: 'ok', page: 'pvehw' })) } })); return; }
      if (url.pathname === '/api/pve/summary/attention') { res.end(JSON.stringify({ items: [] })); return; }
      // NPM-75: settings page — a read-only view of the preview hosts; saving is refused here
      if (url.pathname === '/api/pve/config' && req.method === 'GET') { res.end(JSON.stringify({ hosts: pveHosts.map(h => ({ id: h.id, name: h.name, address: h.address, port: 22, user: 'root', pinned: true })), public_key: 'ssh-ed25519 AAAA…preview homenet-servers@router' })); return; }
      if (url.pathname === '/api/pve/config/test') { let body = ''; req.on('data', c => body += c); req.on('end', () => { const b = JSON.parse(body || '{}'); const h = { id: 't', name: 't', address: b.address }; const r = pveRead(h, 'ping'); res.end(JSON.stringify(r.ok ? { ok: true, pinned: true, latency_ms: 40, ...JSON.parse(r.body) } : { ok: false, pinned: true, error: r.error })); }); return; }
      if (url.pathname === '/api/pve/config') { res.writeHead(409); res.end(JSON.stringify({ ok: false, error: 'В превью сохранение отключено' })); return; }
    }
    // NPM-66: sample home widgets so the page can be checked without a router
    const sample = previewWidgets[req.url.split('?')[0]];
    if (sample) { setTimeout(() => res.end(JSON.stringify(typeof sample === 'function' ? sample() : sample)), req.url.includes('olcrtc') ? 2500 : 0); return; }
    // NPM-70: PREVIEW_VPN_BOARD=<file> answers the VPN screens with a local snapshot (never committed)
    if (item.id === 'vpn' && vpnNode && req.url.startsWith('/api/core/vpn/node/check')) { res.end(JSON.stringify({ ok: true, passed: true, ms: 612 })); return; }
    if (item.id === 'vpn' && vpnNode && req.url.startsWith('/api/core/vpn/node')) { res.end(vpnNode); return; }
    if (item.id === 'vpn' && vpnBoard && req.url.startsWith('/api/core/vpn/board')) { res.end(req.url.includes('days=30') && vpnBoard30 ? vpnBoard30 : vpnBoard); return; }
    if (req.url === '/api/core/status') { res.end(JSON.stringify({ok:true,status:{installed:true,running:!!vpnBoard,controller_ok:!!vpnBoard}})); return; }
    res.writeHead(503); res.end(JSON.stringify({ok:false,error:'Изолированная проверка интерфейса: устройство не подключено'}));
  });
  const manifest = JSON.parse(await readFile(path.join(root, '.runtime/modules/linux-amd64', item.id, '1.0.0/manifest.json'), 'utf8'));
  manifest.arch = 'amd64'; manifest.backend.endpoint = item.id === 'ha' ? `http://127.0.0.1:${await freePort()}` : endpoint;
  // a custom widget the VPN entry does not export: shows the «не отрисовался» path
  if (item.id === 'vpn' && manifest.ui.widgets) manifest.ui.widgets.push({ id: 'preview-custom', title: 'Свой виджет (проверка ошибки)', kind: 'custom', sizes: ['m'], modes: ['pro'], default: { pro: 99 } });
  items.push({ manifest, enabled:true, connection:'unconfigured' });
  await writeFile(path.join(state, 'credentials', `${item.id}.token`), 'local-preview-only-credential-not-for-deployment');
  const destination=path.join(state,'packages',item.id,'1.0.0');
  await cp(path.join(root,'.runtime/modules/linux-amd64',item.id,'1.0.0'),destination,{recursive:true});
  await writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest));
  if (item.id === 'ha') await startHAWorker(item, path.join(destination, 'manifest.json'), path.join(state, 'credentials', 'ha.token'));
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
