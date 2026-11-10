#!/usr/bin/env python3
"""NPM-124: migrate KZ + OLC owner profiles, keep AI on KZ; run on router."""
import copy,json,os,pathlib,subprocess,sys,time,urllib.parse,urllib.request,urllib.error
ROOT=pathlib.Path('/opt/etc/mihomo');CONFIG=ROOT/'config.yaml';OWN=ROOT/'own-servers.yaml'
STATE=pathlib.Path('/opt/etc/homenet/mihomo/olcrtc.json');BASE=ROOT/'recovery-NPM-124'
NODE='Казахстан · VLESS';REFERENCE='./own-servers.yaml';SERVICE='/opt/etc/init.d/S90homenet-vpn'
def api(path,body=None,method=None):
 key=pathlib.Path('/opt/etc/homenet/core/credentials/vpn.token').read_text().strip()
 req=urllib.request.Request('http://127.0.0.1:63503'+path,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),method=method,headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=90) as r:
  raw=r.read();return json.loads(raw) if raw else {}
def read_yaml(path):return json.loads(subprocess.check_output(['/opt/sbin/yq','-o=json',str(path)]))
def write_yaml(path,data):
 raw=subprocess.check_output(['/opt/sbin/yq','-P','-o=yaml'],input=json.dumps(data,ensure_ascii=False).encode());tmp=path.with_suffix('.NPM124.tmp');tmp.write_bytes(raw);tmp.chmod(0o600);tmp.replace(path)
def write_json(path,data):
 tmp=path.with_suffix('.NPM124.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False,indent=2));tmp.chmod(0o600);tmp.replace(path)
def split(cfg,profiles):
 out=copy.deepcopy(cfg);own=[p for p in out.get('proxies',[]) if p.get('name')==NODE or p.get('type')=='olcrtc']
 kz=next(p for p in own if p.get('name')==NODE);assert kz['server']=='38.180.37.198' and kz['dialer-proxy']=='Каскад Казахстана'
 out['proxies']=[p for p in out['proxies'] if p not in own]
 out['proxy-files']=list(dict.fromkeys(out.get('proxy-files',[])+[REFERENCE]))
 return out,{'homenet-inventory':1,'proxies':own,'olcrtc-servers':profiles}
def service(action):
 p=subprocess.run(['sh',SERVICE,action],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30);assert p.returncode==0

def wait_worker():
 for _ in range(30):
  try:return api('/api/core/olcrtc')
  except Exception:time.sleep(1)
 raise RuntimeError('VPN worker unavailable')
def apply():
 os.umask(0o077);BASE.mkdir(mode=0o700,exist_ok=True)
 assert not (BASE/'applied.json').exists(),'Already migrated'
 assert not OWN.exists(),'Inspect existing own-servers.yaml before migration'
 report=api('/api/core/olcrtc');assert not (report.get('job')or{}).get('running'),'OLC setup is running'
 before=read_yaml(CONFIG);store=json.loads(STATE.read_text());profiles=store.get('servers')or[];assert len(profiles)==len(report.get('servers',[]))
 candidate,inventory=split(before,profiles)
 (BASE/'config-before.yaml').write_bytes(CONFIG.read_bytes());(BASE/'olcrtc-before.json').write_bytes(STATE.read_bytes())
 selected=api('/api/mihomo/proxies')['proxies']['ИИ']['now'];applied=False
 try:
  write_yaml(OWN,inventory)
  meta=api('/api/core/config');patch={k:candidate[k] for k in ['proxies','proxy-files']}
  check=api('/api/core/config/check',{'sha':meta['sha'],'set':patch});assert check.get('valid'),'Candidate validation failed'
  result=api('/api/core/config/apply',{'sha':meta['sha'],'set':patch});assert result.get('applied');applied=True
  api('/api/mihomo/proxies/'+urllib.parse.quote('ИИ',safe=''),{'name':NODE},'PUT')
  exit={}
  for _ in range(30):
   try:exit=api('/api/mihomo/proxies/'+urllib.parse.quote('ИИ',safe='')+'/exit?timeout=10000')
   except urllib.error.HTTPError:pass
   if exit.get('ip')=='38.180.37.198':break
   time.sleep(2)
  assert exit.get('ip')=='38.180.37.198','KZ exit failed'
  # Freeze only the inventory writer while removing its legacy duplicate.
  service('stop')
  try:
   latest=json.loads(STATE.read_text());current=read_yaml(OWN)
   if latest.get('servers'):current['olcrtc-servers']=latest['servers'];write_yaml(OWN,current)
   latest['servers']=None;latest.pop('own_servers_fallback',None);write_json(STATE,latest)
  finally:service('start')
  report=wait_worker();assert {s['id'] for s in report['servers']}=={s['id'] for s in profiles}
  assert api('/api/core/nodes')['nodes'][NODE]['server']=='38.180.37.198'
  route=api('/api/core/routing');valid=api('/api/core/routing/check',{'sha':route['sha'],'settings':route['settings']});assert valid.get('valid'),'Routing generator invalidates imported node'
  folders=api('/api/core/group-folders')
  if not folders['folders']:
   ai=['ИИ','Каскад Казахстана'];others=[g['name'] for g in candidate['proxy-groups'] if g['name'] not in ai+['GLOBAL']]
   api('/api/core/group-folders',{'revision':folders['revision'],'folders':[{'id':'ai','name':'ИИ','groups':ai},{'id':'other','name':'Остальные','groups':others}]})
  connections=api('/api/mihomo/connections').get('connections')or[];closed=0
  for connection in connections:
   chain=connection.get('chains')or[]
   if 'ИИ' in chain and NODE not in chain:
    api('/api/mihomo/connections/'+urllib.parse.quote(connection['id'],safe=''),method='DELETE');closed+=1
  final=read_yaml(CONFIG);assert NODE not in [n['name'] for n in final['proxies']]
  assert final['rules']==before['rules'] and final['proxy-groups']==before['proxy-groups']
  assert read_yaml(OWN)['proxies']==inventory['proxies']
  checkpoint={'backup':result.get('backup'),'inventory':str(OWN),'proxies':len(inventory['proxies']),'olc_servers':len(profiles),'AI':NODE,'exit':exit['ip'],'closed_old_AI':closed,'before_AI':selected}
  (BASE/'applied.json').write_text(json.dumps(checkpoint,ensure_ascii=False));print(json.dumps(checkpoint,ensure_ascii=False),flush=True)
 except BaseException:
  # Restore only owned sections and keep the latest OLC profiles, not stale copies.
  try:service('start')
  except Exception:pass
  wait_worker()
  if applied:
   current=read_yaml(CONFIG);proxies=[p for p in current.get('proxies',[]) if p.get('name')!=NODE]
   proxies+= [p for p in before['proxies'] if p.get('name')==NODE]
   files=[p for p in current.get('proxy-files',[]) if p!=REFERENCE]
   meta=api('/api/core/config');rollback=api('/api/core/config/apply',{'sha':meta['sha'],'set':{'proxies':proxies,'proxy-files':files or None}});assert rollback.get('applied')
   api('/api/mihomo/proxies/'+urllib.parse.quote('ИИ',safe=''),{'name':selected},'PUT')
  service('stop')
  try:
   latest=json.loads(STATE.read_text());latest['servers']=read_yaml(OWN).get('olcrtc-servers',profiles) if OWN.exists() else profiles;latest.pop('own_servers_fallback',None);write_json(STATE,latest)
   if OWN.exists():OWN.replace(BASE/'own-servers-failed.yaml')
  finally:service('start')
  raise
if __name__=='__main__':
 if sys.argv[1:]==['apply']:apply()
 else:print(json.dumps({'inventory':str(OWN),'AI':NODE,'changes':False},ensure_ascii=False))
