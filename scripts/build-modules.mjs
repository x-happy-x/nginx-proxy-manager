import { readFile, mkdir, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arch = process.argv[2] || 'arm64';
if (!['amd64', 'arm64', 'arm', 'mipsle', 'mips'].includes(arch)) throw new Error('Unsupported GOARCH');
const version = '1.0.0';
const output = path.join(root, '.runtime', 'modules', `linux-${arch}`);
const catalog = JSON.parse(await readFile(path.join(root, 'integrations/catalog.json'), 'utf8'));
function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
const goEnv = { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: arch, GOARM: '7', GOMIPS: 'softfloat' };
const frontend = path.join(root, 'frontend');
run(process.execPath, ['node_modules/typescript/bin/tsc', '-b'], frontend);
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.core.config.ts', '--logLevel', 'warn'], frontend);
await mkdir(path.join(output, 'core'), { recursive: true });
run('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', path.join(output, 'core/core'), './core'], path.join(root, 'backend'), goEnv);
await cp(path.join(frontend, 'static/core'), path.join(output, 'core/ui'), { recursive: true });
for (const item of catalog) {
  const destination = path.join(output, item.id, version);
  await mkdir(destination, { recursive: true });
  run('go', ['build', '-trimpath', '-tags=integration_worker', `-ldflags=-s -w -X main.workerID=${item.id}`, '-o', path.join(destination, 'worker'), './manager'], path.join(root, 'backend'), goEnv);
  run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.integration.config.ts', '--mode', item.id, '--logLevel', 'warn'], frontend);
  await cp(path.join(frontend, 'static/integrations', item.id), path.join(destination, 'ui'), { recursive: true });
  const manifest = {
    schema: 1, id: item.id, name: item.name, description: item.description, version, arch, core_api: 1, ui_api: 1,
    ui: { entry: 'entry.js', css: ['style.css'], pages: item.pages.map(id => ({ id, title: id, ...(id === 'subs' ? { aliases: ['tailscale', 'olcrtc'] } : {}) })) },
    backend: { endpoint: `http://127.0.0.1:${item.port}`, health: '/health', paths: item.paths, service: `S90homenet-${item.id}` },
    data_schema: 1, data_directories: item.data, package: `homenet-${item.id}`,
  };
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
console.log(`Built development candidates in ${output}; migration/release-set activation is required before deployment.`);
