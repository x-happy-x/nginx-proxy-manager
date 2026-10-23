// NPM-96: run candidate collectors without installing agents or changing keys.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hosts = [['s1','192.168.99.10'],['s2','192.168.99.20'],['s3','192.168.99.30']];
function run(command, args, input, timeout=45000) {
  return new Promise((accept,reject) => {
    const child=spawn(command,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let size=0; const stdout=[],stderr=[];
    const timer=setTimeout(()=>child.kill(),timeout);
    child.stdout.on('data',b=>{size+=b.length;if(size>8*1024*1024)child.kill();else stdout.push(b);});
    child.stderr.on('data',b=>{if(stderr.reduce((n,x)=>n+x.length,0)<4096)stderr.push(b);});
    child.on('error',err=>{clearTimeout(timer);reject(err);});
    child.on('close',code=>{clearTimeout(timer);if(code!==0){reject(new Error(Buffer.concat(stderr).toString('utf8').slice(-500)||'Collector did not complete'));return;}try{accept(JSON.parse(Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/,'')));}catch{reject(new Error('Collector returned invalid JSON'));}});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
export async function collectHardwareDesign() {
  const source=await readFile(resolve(root,'pve-agent/homenet-pve-agent'),'utf8');
  const probe=`import json,time\nscope={'__name__':'hardware_design_probe'}\nexec(${JSON.stringify(source)},scope)\ntemps,fans=scope['temperatures']()\nprint(json.dumps({'hardware':scope['hardware'](),'disks':scope['disks'](),'temps':temps,'fans':fans,'ts':int(time.time()),'host':scope['NODE']},ensure_ascii=False))\n`;
  const result={v:1,collected_at:new Date().toISOString(),machines:{},errors:{}};
  const jobs=[...hosts.map(([id,address])=>[id,()=>run('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=5',address,'python3','-'],Buffer.from(probe))]),['pc',()=>run(resolve(root,'.local/qa/NPM-96/pc-agent.exe'),['serve','hardware'],undefined,16000)]];
  await Promise.all(jobs.map(async([id,collect])=>{try{result.machines[id]=await collect();}catch(e){result.errors[id]=e.message;}}));
  return result;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const output=resolve(process.argv[2]||resolve(root,'.local/qa/NPM-96/hardware.json'));
  const result=await collectHardwareDesign();
  await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({output,machines:Object.keys(result.machines),errors:result.errors}));
  if(Object.keys(result.errors).length)process.exitCode=1;
}
