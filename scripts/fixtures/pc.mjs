// Isolated synthetic computer inventory. No SSH, Docker or WSL process is run.
const GB = 1024 ** 3;
const startedAt = Date.now();
const tasks = [];
const container = (id, name, state, image) => ({ id: id.repeat(64), name, state, image, status: state === 'running' ? 'Up 3 hours' : 'Exited (0)', ports: name === 'web' ? '127.0.0.1:8080->80/tcp' : '' });
const docker = [
  { context: 'native', available: true, containers: [container('a', 'web', 'running', 'nginx:stable'), container('b', 'redis', 'exited', 'redis:7')] },
  { context: 'wsl:Ubuntu', available: true, containers: [container('c', 'dev-postgres', 'running', 'postgres:17')] },
  { context: 'wsl:Debian', available: false, error: 'Дистрибутив остановлен', containers: [] },
];
const wsl = [{ name: 'Ubuntu', state: 'running', version: 2 }, { name: 'Debian', state: 'stopped', version: 2 }];
let configs = [
  { id: 'workstation', name: 'Рабочий компьютер', address: '192.0.2.21', port: 22, user: 'alex', os: 'windows' },
  { id: 'linux-mini', name: 'Домашний Linux', address: '192.0.2.22', port: 22, user: 'homenet', os: 'linux' },
  { id: 'laptop', name: 'Ноутбук', address: '192.0.2.23', port: 22, user: 'alex', os: 'windows' },
];
function overview() {
  return { configured: !!configs.length, error: '', hosts: configs.map((h, i) => {
    const online = h.id !== 'laptop', ts = Math.floor(Date.now() / 1000) - (online ? 2 : 1800);
    return { ...h, online, error: online ? '' : 'Нет ответа по SSH', latency_ms: 18, checked_at: new Date().toISOString(), last_ok: new Date(ts * 1000).toISOString(), current: {
      v: 1, ts, host: h.id, os: h.os, arch: 'amd64', agent: '1.0.0', uptime: 345678,
      cpu: { percent: 24 + i * 11, cores: 16, model: 'Intel Core i7-13700' }, memory: { total: 32 * GB, used: (12 + i * 2) * GB, available: (20 - i * 2) * GB },
      disks: [{ path: h.os === 'windows' ? 'C:\\' : '/', total: 512 * GB, used: 220 * GB, free: 292 * GB }],
      network: [{ name: 'Ethernet', rx_bytes: 42 * GB + (Date.now() - startedAt) * 100, tx_bytes: 8 * GB + (Date.now() - startedAt) * 10, aggregate: true }],
      wsl: h.id === 'workstation' ? wsl : [], docker: h.id === 'workstation' ? docker : [{ context: 'native', available: true, containers: [container('d', 'monitoring', 'running', 'grafana/grafana:latest')] }],
      capabilities: { docker_actions: i === 1 ? [] : ['start', 'stop', 'restart'], wsl_actions: h.id === 'workstation' ? ['start', 'terminate'] : [] }, errors: [],
    } };
  }) };
}

export function fakePc(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const send = (body, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const read = callback => { let body = ''; req.on('data', c => body += c); req.on('end', () => { try { callback(JSON.parse(body || '{}')); } catch { send({ error: 'Некорректный запрос' }, 400); } }); };
  if (url.pathname === '/api/pc/overview') { send(overview()); return true; }
  if (url.pathname === '/api/pc/config' && req.method === 'GET') { send({ hosts: configs.map(({ os, ...h }) => ({ ...h, pinned: true })), public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewKey homenet-pc@router' }); return true; }
  if (url.pathname === '/api/pc/config' && req.method === 'PUT') { read(body => { configs = body.hosts.map(h => ({ ...h, os: configs.find(old => old.id === h.id)?.os || 'linux' })); send({ ok: true }); }); return true; }
  if (url.pathname === '/api/pc/config/test') { read(() => send({ ok: true, pinned: true, host: 'workstation', agent: '1.0.0', os: 'windows', latency_ms: 18, fingerprint: 'SHA256:preview-only' })); return true; }
  if (url.pathname === '/api/pc/history') { const now = Math.floor(Date.now() / 1000); send({ step: 60, points: Array.from({ length: 90 }, (_, i) => ({ t: now - (89 - i) * 60, cpu: 25 + Math.sin(i / 5) * 12, mem_used: (12 + Math.sin(i / 8)) * GB, mem_total: 32 * GB, net_rx_bps: 2000000 + Math.sin(i / 6) * 800000, net_tx_bps: 420000 })) }); return true; }
  if (url.pathname === '/api/pc/tasks') { send({ tasks }); return true; }
  if (url.pathname === '/api/pc/actions' && req.method === 'POST') {
    read(body => {
      const h = overview().hosts.find(h => h.id === body.host);
      const resource = body.target === 'docker' ? h?.current.docker.find(d => d.context === body.context)?.containers.find(c => c.id === body.id) : wsl.find(w => w.name === body.name);
      if (!resource || !h?.online) { send({ error: 'Ресурс недоступен' }, 409); return; }
      if (body.action !== 'start' && body.confirm !== resource.name) { send({ error: 'Подтвердите имя ресурса' }, 400); return; }
      const task = { id: `preview-${tasks.length + 1}`, host: body.host, target: body.target, context: body.context, resource_id: body.id, name: resource.name, action: body.action, status: 'running', message: 'Операция на локальном стенде', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      tasks.unshift(task); send({ ok: true, task }, 202);
      setTimeout(() => { task.status = 'done'; task.message = 'Операция завершена (пример)'; task.updated_at = new Date().toISOString(); resource.state = ['stop', 'terminate'].includes(body.action) ? body.target === 'wsl' ? 'stopped' : 'exited' : 'running'; resource.status = resource.state === 'running' ? 'Up just now' : 'Exited (0)'; }, 2000);
    }); return true;
  }
  if (url.pathname === '/api/pc/widgets/hosts') { const hosts = overview().hosts; send({ state: 'warn', updated_at: new Date().toISOString(), body: { label: 'Компьютеры', items: hosts.map(h => ({ text: h.name, ok: h.online })) } }); return true; }
  if (url.pathname === '/api/pc/summary/attention') { send({ items: [] }); return true; }
  return false;
}
