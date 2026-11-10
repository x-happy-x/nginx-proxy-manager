#!/usr/bin/env python3
"""NPM-123: configure an automatic, cascade-verified entry group; run on router."""
import copy,json,os,pathlib,subprocess,sys,time,urllib.parse,urllib.request,urllib.error
BASE=pathlib.Path('/opt/etc/mihomo/recovery-NPM-123')
CONFIG=pathlib.Path('/opt/etc/mihomo/config.yaml')
NODE='Казахстан · VLESS'
ENTRY='Каскад Казахстана'

def transform(cfg,providers):
 out=copy.deepcopy(cfg)
 n=next(n for n in out['proxies'] if n['name']==NODE)
 assert n['server']=='38.180.37.198' and n['type']=='vless'
 n['dialer-proxy']=ENTRY
 group={'name':ENTRY,'type':'fallback','use':providers,'url':'https://www.gstatic.com/generate_204','expected-status':'204','interval':30,'timeout':5000,'lazy':False,'empty-fallback':'REJECT','health-check-via':NODE}
 old=next((g for g in out['proxy-groups'] if g['name']==ENTRY),None)
 assert old is None or old==group or (old.get('type')=='select' and old.get('filter')=='node-06$'),'Existing entry group differs'
 out['proxy-groups']=[g for g in out['proxy-groups'] if g['name']!=ENTRY]+[group]
 return out

def api(path,body=None,method=None):
 k=pathlib.Path('/opt/etc/homenet/core/credentials/vpn.token').read_text().strip()
 r=urllib.request.Request('http://127.0.0.1:63503'+path,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),method=method,headers={'Authorization':'Bearer '+k,'Content-Type':'application/json'})
 with urllib.request.urlopen(r,timeout=90) as reply:
  raw=reply.read();return json.loads(raw) if raw else {}
def read():return json.loads(subprocess.check_output(['/opt/sbin/yq','-o=json',str(CONFIG)]))
def apply():
 os.umask(0o077);BASE.mkdir(mode=0o700,exist_ok=True)
 assert not (BASE/'applied-auto.json').exists(),'Already applied'
 before=read();runtime=api('/api/mihomo/proxies')['proxies'];selection=runtime['ИИ']['now'];bypass=runtime['Обходы']['now']
 providers=[key for key,p in before['proxy-providers'].items() if p.get('type') in ['http','file'] and key!='olcrtc']
 assert providers
 after=transform(before,providers);assert transform(after,providers)==after
 patch={k:after[k] for k in ['proxies','proxy-groups']};meta=api('/api/core/config')
 check=api('/api/core/config/check',{'sha':meta['sha'],'set':patch});assert check.get('valid'),check.get('detail')
 (BASE/'config-auto-before.yaml').write_bytes(CONFIG.read_bytes())
 result=api('/api/core/config/apply',{'sha':meta['sha'],'set':patch});assert result.get('applied')
 try:
  api('/api/mihomo/proxies/'+urllib.parse.quote(ENTRY,safe=''),method='DELETE')
  exit={}
  for _ in range(25):
   try:exit=api('/api/mihomo/proxies/'+urllib.parse.quote(NODE,safe='')+'/exit?timeout=10000')
   except urllib.error.HTTPError:pass
   if exit.get('ip')=='38.180.37.198':break
   time.sleep(2)
  assert exit.get('ip')=='38.180.37.198','No verified KZ cascade entry'
  runtime=api('/api/mihomo/proxies')['proxies'];assert runtime['ИИ']['now']==selection and runtime['Обходы']['now']==bypass
  assert runtime[ENTRY].get('cascadeTarget')==NODE and not runtime[ENTRY].get('fixed')
  assert len(runtime[ENTRY]['all'])>1
  assert runtime[ENTRY].get('cascadeHealth',{}).get(runtime[ENTRY]['now'],{}).get('alive')
  (BASE/'applied-auto.json').write_text(json.dumps(result))
  print(json.dumps({'applied':True,'backup':result.get('backup'),'group':ENTRY,'entry':runtime[ENTRY]['now'],'automatic':True,'candidates':len(runtime[ENTRY]['all']),'exit':exit.get('ip'),'country':exit.get('country'),'ai_selection':selection,'bypass_selection_preserved':True},ensure_ascii=False))
 except BaseException:
  current=api('/api/core/config');assert current['sha']==result['sha'],'Concurrent config edit; automatic rollback cancelled'
  rollback=api('/api/core/config/apply',{'sha':current['sha'],'set':{k:before[k] for k in ['proxies','proxy-groups']}});assert rollback.get('applied');raise
if __name__=='__main__':
 if sys.argv[1:]!=['apply']:print(json.dumps({'entry_group':ENTRY,'members':'all server subscriptions; full VLESS health check; no fixed entry','network_changes':False},ensure_ascii=False))
 else:apply()
