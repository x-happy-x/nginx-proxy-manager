#!/usr/bin/env python3
"""NPM-125: fill observed AI domain gaps without changing other route groups."""
import json,pathlib,subprocess,sys,urllib.parse,urllib.request
DOMAINS=('deepseek.com','m365copilotapp.svc.cloud.microsoft')
def api(path,body=None,method=None):
 token=pathlib.Path('/opt/etc/homenet/core/credentials/vpn.token').read_text().strip()
 req=urllib.request.Request('http://127.0.0.1:63503'+path,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),method=method,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=90)as response:
  raw=response.read();return json.loads(raw)if raw else {}
def patch_rules(rules):
 add=['DOMAIN-SUFFIX,'+d+',ИИ' for d in DOMAINS];out=[r for r in rules if r not in add]
 at=out.index('RULE-SET,category-ai@domain,ИИ');return out[:at]+add+out[at:]
def main():
 cfg=json.loads(subprocess.check_output(['/opt/sbin/yq','-o=json','/opt/etc/mihomo/config.yaml']));rules=patch_rules(cfg['rules'])
 if sys.argv[1:]!=['apply']:print(json.dumps({'domains':DOMAINS,'changed':rules!=cfg['rules'],'apply':False}));return
 meta=api('/api/core/config');body={'sha':meta['sha'],'set':{'rules':rules}}
 assert api('/api/core/config/check',body).get('valid')
 result=api('/api/core/config/apply',body);assert result.get('applied')
 closed=0
 for connection in api('/api/mihomo/connections').get('connections')or[]:
  host=connection.get('metadata',{}).get('host','').lower()
  if any(host==d or host.endswith('.'+d)for d in DOMAINS)and 'ИИ'not in(connection.get('chains')or[]):
   api('/api/mihomo/connections/'+urllib.parse.quote(connection['id'],safe=''),method='DELETE');closed+=1
 route=api('/api/core/routing');preview=api('/api/core/routing/check',{'sha':route['sha'],'settings':route['settings']});assert preview.get('valid')
 print(json.dumps({'applied':True,'backup':result.get('backup'),'domains':DOMAINS,'closed_old_connections':closed},ensure_ascii=False))
if __name__=='__main__':main()
