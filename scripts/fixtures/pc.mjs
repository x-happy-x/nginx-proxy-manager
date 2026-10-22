// Isolated PC fixtures; no SSH, Docker or WSL processes are run.
const GB = 1024 ** 3;
const tasks = [];
const wsl = [{ name: 'Ubuntu', state: 'running', version: 2 }, { name: 'Debian', state: 'stopped', version: 2 }, { name: 'Fedora', state: 'running', version: 2 }];
const container = (id, name, state, image, ports = '') => ({ id: id.repeat(64), name, state, image, status: state === 'running' ? 'Up 3 hours' : 'Exited (0) 2 days ago', ports });
const inventories = [
  [{ context: 'native', available: false, error: 'Docker в Windows не запущен', containers: [] }, { context: 'wsl:Ubuntu', available: true, containers: [container('a', 'web', 'running', 'nginx:stable', '127.0.0.1:8080->80/tcp'), container('b', 'redis', 'exited', 'redis:7', '6379/tcp'), container('c', 'dev-postgres', 'running', 'postgres:17', '0.0.0.0:5432->5432/tcp')] }, { context: 'wsl:Debian', available: false, error: 'Дистрибутив остановлен', containers: [] }, { context: 'wsl:Fedora', available: false, error: 'Нет доступа к Docker socket', containers: [] }],
  [{ context: 'native', available: true, containers: [container('d', 'task-tracker', 'running', 'family/task-tracker:18b6959c387e00112233445566778899', '0.0.0.0:4193->3000/tcp, [::]:4193->3000/tcp'), container('e', 'postgres', 'running', 'postgres:17', '5432/tcp'), container('f', 'backup', 'exited', 'alpine:3.20')] }],
  [{ context: 'native', available: true, containers: [container('1', 'forgejo', 'running', 'codeberg.org/forgejo/forgejo:11', '0.0.0.0:3000->3000/tcp'), container('2', 'runner', 'running', 'forgejo/runner:latest')] }],
  [{ context: 'native', available: true, containers: [container('3', 'grafana', 'running', 'grafana/grafana:latest', '0.0.0.0:3001->3000/tcp'), container('4', 'prometheus', 'running', 'prom/prometheus:latest', '127.0.0.1:9090->9090/tcp')] }],
];
let configs = [
  { id: 'workstation', name: 'PC-X', address: '192.0.2.21', port: 22, user: 'alex', os: 'windows' },
  { id: 'family-apps', name: 'family-apps', address: '192.0.2.22', port: 22, user: 'homenet', os: 'linux' },
  { id: 'forgejo-ci', name: 'forgejo-ci', address: '192.0.2.23', port: 22, user: 'homenet', os: 'linux' },
  { id: 'home-server', name: 'home-server', address: '192.0.2.24', port: 22, user: 'homenet', os: 'linux' },
];
const events = [{ id: 'preview-1', host: 'workstation', kind: 'task_unknown', severity: 'warning', title: 'Результат операции неизвестен', message: 'Связь прервалась во время перезапуска web.', created_at: new Date(Date.now() - 60000).toISOString() }, { id: 'preview-2', host: 'family-apps', kind: 'connection_restored', severity: 'info', title: 'Связь восстановлена', message: 'Получен свежий снимок.', created_at: new Date(Date.now() - 360000).toISOString() }];
const eventData = () => ({ events, unread: events.filter(e => !e.read_at).length, ...(process.env.PREVIEW_EVENTS_STORAGE_ERROR ? { storage_error: "Тестовый сбой записи: хранилище недоступно" } : {}) });
function overview() {
  return { configured: !!configs.length, hosts: configs.map((h, i) => {
    const online = h.id !== process.env.PREVIEW_PC_OFFLINE, ts = Math.floor(Date.now() / 1000) - (online ? 2 : 1800);
    return { ...h, online, error: online ? '' : 'Нет ответа по SSH', latency_ms: 18, checked_at: new Date().toISOString(), last_ok: new Date(ts * 1000).toISOString(), current: {
      v: 1, ts, host: h.id, os: h.os, arch: 'amd64', agent: i ? '1.1.0' : '1.0.0', uptime: 345678,
      cpu: { percent: [2.5, 5, 18, 50][i], cores: i ? 2 : 32, model: i ? 'QEMU Virtual CPU' : 'Intel Core i9' }, memory: { total: (i ? 4 : 96) * GB, used: (i ? 2 : 53.7) * GB, available: (i ? 2 : 42.3) * GB },
      disks: [{ path: i ? '/' : 'C:', total: 512 * GB, used: (i ? 220 : 450) * GB, free: (i ? 292 : 62) * GB }],
      network: [{ name: 'Ethernet', rx_bytes: 42 * GB, tx_bytes: 8 * GB, aggregate: true }],
      wsl: i ? [] : wsl, docker: inventories[i] || [], capabilities: { docker_logs: i > 0, docker_actions: i ? [] : ['start', 'stop', 'restart'], wsl_actions: i ? [] : ['start', 'terminate'] }, errors: [],
    } };
  }) };
}
export function fakePc(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const send = (body, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const read = cb => { let body = ''; req.on('data', c => body += c); req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch { send({ error: 'Некорректный запрос' }, 400); } }); };
  if (url.pathname === '/api/pc/events' && req.method === 'GET') { send(eventData()); return true; }
  if (url.pathname === '/api/pc/events/read') { read(body => { if (process.env.PREVIEW_EVENTS_STORAGE_ERROR) { send({ error: 'Не удалось сохранить отметки о прочтении (пример)' }, 500); return; } events.forEach(e => { if (body.all || body.ids?.includes(e.id)) e.read_at = new Date().toISOString(); }); send(eventData()); }); return true; }
  if (url.pathname === '/api/pc/overview') { send(overview()); return true; }
  if (url.pathname === '/api/pc/placement') { const hosts = overview().hosts; send({ hosts: hosts.map(h => ({ id: h.id, name: h.name, ip: h.address, online: h.online, logs: h.current.capabilities.docker_logs })), containers: hosts.flatMap(h => h.current.docker.flatMap(d => d.containers.map(c => ({ ...c, host: h.id, host_name: h.name, ip: h.address, context: d.context, ports: [...c.ports.matchAll(/(127\.0\.0\.1|0\.0\.0\.0):(\d+)->(\d+)\/tcp/g)].map(m => ({ ip: m[1] === '0.0.0.0' ? '' : m[1], port: Number(m[2]), target: `${m[3]}/tcp` })) })))) }); return true; }
  if (url.pathname === '/api/pc/logs') { const h = overview().hosts.find(h => h.id === url.searchParams.get('host')); send(h?.current.capabilities.docker_logs ? { ok: true, text: Array.from({ length: Math.min(40, Number(url.searchParams.get('tail'))) }, (_, i) => `${new Date().toISOString()} INFO request=${i} status=200 local preview`).join('\n') + '\n' } : { ok: false, error: 'Агент не поддерживает логи' }); return true; }
  if (url.pathname === '/api/pc/config' && req.method === 'GET') { send({ hosts: configs.map(({ os, ...h }) => ({ ...h, pinned: true })), public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewKey homenet-pc@router' }); return true; }
  if (url.pathname === '/api/pc/config' && req.method === 'PUT') { read(body => { configs = body.hosts.map(h => ({ ...h, os: configs.find(old => old.id === h.id)?.os || 'linux' })); send({ ok: true }); }); return true; }
  if (url.pathname === '/api/pc/config/test') { read(() => send({ ok: true, pinned: true, host: 'workstation', agent: '1.0.0', os: 'windows', latency_ms: 18, fingerprint: 'SHA256:preview-only' })); return true; }
  if (url.pathname === '/api/pc/history') { const now = Math.floor(Date.now() / 60000) * 60; send({ step: 60, points: Array.from({ length: 1440 }, (_, i) => ({ t: now - (1439 - i) * 60, cpu: 25 + Math.sin(i / 5) * 12, mem_used: (12 + Math.sin(i / 8)) * GB, mem_total: 32 * GB, net_rx_bps: 2000000 + Math.sin(i / 6) * 800000, net_tx_bps: 420000, network_valid: true, disks: [{ path: url.searchParams.get('host') === 'workstation' ? 'C:' : '/', total: 512 * GB, used: (420 + i / 48) * GB }] })) }); return true; }
  if (url.pathname === '/api/pc/tasks') { send({ tasks }); return true; }
  if (url.pathname === '/api/pc/actions' && req.method === 'POST') {
    read(body => {
      const h = overview().hosts.find(h => h.id === body.host);
      const resource = body.target === 'docker' ? h?.current.docker.find(d => d.context === body.context)?.containers.find(c => c.id === body.id) : h?.current.wsl.find(w => w.name === body.name);
      const permissions = h?.current.capabilities[body.target === 'docker' ? 'docker_actions' : 'wsl_actions'];
      if (!resource || !h?.online || !permissions?.includes(body.action)) { send({ error: 'Действие недоступно' }, 409); return; }
      if (body.action !== 'start' && body.confirm !== resource.name) { send({ error: 'Подтвердите имя ресурса' }, 400); return; }
      const task = { id: `preview-${tasks.length + 1}`, host: body.host, target: body.target, context: body.context, resource_id: body.id, name: resource.name, action: body.action, status: 'running', message: 'Операция на локальном стенде', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      tasks.unshift(task); send({ ok: true, task }, 202);
      setTimeout(() => { task.status = 'done'; task.message = 'Операция завершена (пример)'; task.updated_at = new Date().toISOString(); resource.state = ['stop', 'terminate'].includes(body.action) ? body.target === 'wsl' ? 'stopped' : 'exited' : 'running'; resource.status = resource.state === 'running' ? 'Up just now' : 'Exited (0)'; }, 2000);
    }); return true;
  }
  if (url.pathname === '/api/pc/widgets/hosts') { send({ state: 'ok', updated_at: new Date().toISOString(), body: { label: 'Компьютеры', items: overview().hosts.map(h => ({ text: h.name, ok: h.online })) } }); return true; }
  if (url.pathname === '/api/pc/summary/attention') { send({ items: [] }); return true; }
  return false;
}
