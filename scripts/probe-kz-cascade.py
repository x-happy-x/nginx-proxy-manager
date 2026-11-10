#!/usr/bin/env python3
"""NPM-123: compare KZ through isolated local Mihomo instances, no live config edits."""
import subprocess

REMOTE = r"""
import copy,json,pathlib,socket,subprocess,tempfile,time,urllib.request
root=pathlib.Path('/opt/etc/mihomo');cfg=json.loads(subprocess.check_output(['/opt/sbin/yq','-o=json',str(root/'config.yaml')]))
k=pathlib.Path('/opt/etc/homenet/core/credentials/vpn.token').read_text().strip()
with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:63503/api/mihomo/proxies',headers={'Authorization':'Bearer '+k}),timeout=10) as r:runtime=json.load(r)['proxies']
kz=next(n for n in cfg['proxies'] if n['name']=='Казахстан · VLESS')
entries={n['name']:n for n in cfg.get('proxies',[])}
for provider in cfg.get('proxy-providers',{}).values():
 path=(root/provider.get('path','')).resolve()
 if not path.is_relative_to(root) or not path.is_file():continue
 raw=json.loads(subprocess.check_output(['/opt/sbin/yq','-o=json',str(path)]));over=provider.get('override',{})
 for n in raw.get('proxies',[]):
  n=copy.deepcopy(n);name=over.get('additional-prefix','')+n['name']+over.get('additional-suffix','')
  n.update({k:v for k,v in over.items() if k not in ['additional-prefix','additional-suffix']});entries[name]=n
chosen=runtime['Обходы'].get('now');candidates=[('Напрямую',{'type':'direct'}),(chosen,entries[chosen])]
for hint in ['node-06','node-02','node-03']:
 name=next((n for n in runtime['Обходы'].get('all',[]) if n.startswith('PAUK') and hint in n and n in entries),None)
 if name and name!=chosen:candidates.append((name,entries[name]))
for title,entry in candidates:
 with tempfile.TemporaryDirectory(prefix='NPM-123-probe-') as td:
  with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
  entry=copy.deepcopy(entry);entry['name']='PROBE-ENTRY';entry.pop('dialer-proxy',None)
  node=copy.deepcopy(kz);node.update({'name':'PROBE-KZ','dialer-proxy':'PROBE-ENTRY'})
  test={'mixed-port':port,'bind-address':'127.0.0.1','allow-lan':False,'mode':'rule','log-level':'silent','routing-mark':255,'ipv6':False,'tun':{'enable':False},'dns':{'enable':False},'proxies':[entry,node],'rules':['MATCH,PROBE-KZ']}
  f=pathlib.Path(td)/'config.json';f.write_text(json.dumps(test));f.chmod(0o600)
  p=subprocess.Popen(['/opt/sbin/mihomo','-d',td,'-f',str(f)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  try:
   ready=False
   for _ in range(40):
    if p.poll() is not None:break
    try:
     with socket.create_connection(('127.0.0.1',port),timeout=.2):ready=True;break
    except OSError:time.sleep(.1)
   if not ready:print(json.dumps({'entry':title,'ready':False},ensure_ascii=False),flush=True);continue
   result=subprocess.run(['/opt/bin/curl','-sS','--proxy','http://127.0.0.1:'+str(port),'--max-time','10','-o','/dev/null','-w','%{http_code}','https://api.openai.com/v1/models'],capture_output=True,timeout=13)
   print(json.dumps({'entry':title,'status':result.stdout.decode(),'error':result.stderr.decode()[:150]},ensure_ascii=False),flush=True)
  finally:
   p.terminate()
   try:p.wait(timeout=3)
   except subprocess.TimeoutExpired:p.kill();p.wait()
"""
if __name__ == '__main__':
    result = subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','keenetic','/opt/bin/python3','-'],input=REMOTE.encode(),capture_output=True,timeout=110)
    print(result.stdout.decode())
    if result.returncode:raise RuntimeError(result.stderr.decode()[-900:])
