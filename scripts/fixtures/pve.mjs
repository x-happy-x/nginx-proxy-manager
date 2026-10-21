// Synthetic Proxmox data and operations, used only by the loopback preview server.
const GB = 1024 ** 3;
const tasks = [];
const guests = [
  { vmid: 100, name: 'home-assistant', type: 'qemu', status: 'running', mem: 3 * GB, maxmem: 4 * GB, cpu: 12, cpus: 2, tags: 'home;automation' },
  { vmid: 101, name: 'media-server', type: 'lxc', status: 'stopped', mem: 0, maxmem: 8 * GB, cpu: 0, cpus: 4, tags: 'media' },
  { vmid: 102, name: 'development', type: 'qemu', status: 'paused', mem: 4 * GB, maxmem: 8 * GB, cpu: 0, cpus: 4, tags: 'dev' },
  { vmid: 900, name: 'debian-template', type: 'lxc', status: 'stopped', template: true, mem: 0, maxmem: GB, cpu: 0, cpus: 1, tags: '' },
].map(g => ({ template: false, disk: 12 * GB, maxdisk: 64 * GB, uptime: 123456, lock: '', netin_rate: 120000, netout_rate: 64000, ...g }));

function host(index) {
  const id = `lab-${index + 1}`, now = Date.now(), offline = index === 2;
  const ts = Math.floor(now / 1000) - (offline ? 1800 : 2);
  return {
    id, name: ['Основной сервер', 'Медиа и архив', 'Резервный узел', 'Тестовая лаборатория'][index],
    address: `192.0.2.${10 + index}`, online: !offline, error: offline ? 'Нет ответа по SSH' : '',
    latency_ms: 12, checked_at: new Date(now).toISOString(), last_ok: new Date(ts * 1000).toISOString(),
    capabilities: { control: index !== 1, guest_actions: index === 1 ? [] : ['start', 'shutdown', 'reboot', 'stop'], node_actions: index === 1 ? [] : ['reboot', 'shutdown'] },
    current: {
      host: id, ts, interval: 10,
      node: { cpu: [23, 46, 9, 12][index], iowait: 1.2, load: [0.8, 0.6, 0.5], threads: 8, freq_mhz: 3200, uptime: 1234567,
        mem: { total: 32 * GB, used: (8 + index * 3) * GB, avail: (24 - index * 3) * GB, cached: GB, ksm: 0 }, swap: { total: 4 * GB, used: 0 }, cpu_temp: 48 + index * 4 },
      temps: [{ chip: 'coretemp', label: 'Package id 0', c: 48 + index * 4, crit: 100 }], fans: [{ chip: 'it87', label: 'CPU', rpm: 1400 }],
      net: [{ iface: 'enp1s0', rx: 1200000, tx: 540000, state: 'up', speed: 1000, bridge: false }],
      io: [{ dev: 'nvme0n1', r: 350000, w: 240000, util: 8 }],
      guests: index === 0 ? guests : [{ ...guests[0], vmid: 200 + index, name: ['archive', 'backup', 'test-node'][index - 1] }],
      storage: [{ name: 'local', type: 'dir', used: 160 * GB, total: 512 * GB, active: true, enabled: true, shared: false, content: 'backup,iso' }],
      zfs: [], disks: [{ dev: 'nvme0n1', kind: 'nvme', model: 'Preview NVMe', serial: 'PREVIEW', size: 512 * GB, transport: 'nvme', firmware: '1.0', health: true, temp: 43, hours: 1500, cycles: 22, wear: 3, written: 2000 * GB, media_errors: 0, reallocated: 0 }],
      updates: 3, failed_units: [], backups: [{ id: '100', status: 'OK', start: ts - 3600, end: ts - 3500 }],
      versions: { pve: '8.4 (пример)', kernel: '6.8.12-pve', agent: '1.2.0' },
      cluster: { name: 'home-lab', quorate: true, nodes: [{ name: 'lab-1', ip: '192.0.2.10', online: true, local: index === 0 }, { name: 'lab-2', ip: '192.0.2.11', online: true, local: index === 1 }] },
    },
    hardware: { vendor: 'HomeLab', product: 'Mini Server', board: 'Preview', bios: '1.0', cpu: { model: 'Intel Core i5-12400', threads: 8, cores: 4, sockets: 1, max_mhz: 4400, virt: 'VT-x', arch: 'x86_64' }, memory: { total: 32 * GB, slots: 2, modules: [] }, nics: [{ iface: 'enp1s0', mac: '02:00:00:00:00:01', driver: 'igc', speed: 1000, state: 'up' }], gpus: [], controllers: [] },
  };
}

export function fakePve(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (url.pathname === '/api/pve/overview') { send({ configured: true, error: '', hosts: Array.from({ length: 4 }, (_, i) => host(i)) }); return true; }
  if (url.pathname === '/api/pve/history') {
    const now = Math.floor(Date.now() / 1000), points = Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * 60, cpu: 20 + Math.sin(i / 5) * 10, mem: 8 * GB, io: 1, load: 0.8, temp: 48 + Math.sin(i / 7) * 4, rx: 1200000, tx: 540000, r: 350000, w: 240000 }));
    const h = host(Number(url.searchParams.get('host')?.split('-')[1] || 1) - 1);
    send({ step: 60, points, guests: Object.fromEntries(h.current.guests.map(g => [g.vmid, points.map(p => [p.t, g.cpu + Math.sin(p.t), g.mem])])) }); return true;
  }
  if (url.pathname === '/api/pve/tasks') { send({ tasks }); return true; }
  if (url.pathname === '/api/pve/actions' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      let request; try { request = JSON.parse(body); } catch { send({ error: 'Некорректный JSON' }, 400); return; }
      const task = { ...request, id: `preview-${tasks.length + 1}`, status: request.target === 'node' ? 'accepted' : 'running', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), message: 'Пример: операция на локальном стенде' };
      tasks.unshift(task); send({ ok: true, task }, 202);
      if (task.target === 'guest') setTimeout(() => { task.status = 'done'; task.message = 'Операция завершена (пример)'; task.updated_at = new Date().toISOString(); const g = guests.find(g => g.vmid === task.vmid); if (g) g.status = ['stop', 'shutdown'].includes(task.action) ? 'stopped' : 'running'; }, 2500);
    }); return true;
  }
  if (url.pathname === '/api/pve/config' && req.method === 'GET') { send({ hosts: Array.from({ length: 4 }, (_, i) => ({ ...host(i), port: 22, user: 'root', pinned: true })), public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewKey homenet-preview' }); return true; }
  return false;
}
