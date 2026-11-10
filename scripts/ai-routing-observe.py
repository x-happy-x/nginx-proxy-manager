#!/usr/bin/env python3
"""Read-only router observer for UI-driven AI probes; never stores payloads/credentials."""
import argparse,datetime,json,pathlib,time,urllib.request
FAMILIES=('chatgpt.com','openai.com','cursor.sh','cursor.com','deepseek.com','kimi.ai','kimi.com','moonshot.cn','grok.com','x.ai','gemini.google.com','googleapis.com','copilot.microsoft.com','copilot.com','bing.com','githubcopilot.com','copilot.cloud.microsoft','microsoft.com','cloud.microsoft')
def selected(host):
 return any(host==d or host.endswith('.'+d) for d in FAMILIES)
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--seconds',type=int,default=1800);args=parser.parse_args()
 token=pathlib.Path('/opt/etc/homenet/core/credentials/vpn.token').read_text().strip()
 req=urllib.request.Request('http://127.0.0.1:63503/api/mihomo/connections',headers={'Authorization':'Bearer '+token})
 previous={};end=time.monotonic()+args.seconds;initial=True
 while time.monotonic()<end:
  stamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
  try:
   with urllib.request.urlopen(req,timeout=10) as response:data=json.load(response)
   current={}
   for c in data.get('connections')or[]:
    m=c.get('metadata',{});host=m.get('host','').lower()
    if m.get('sourceIP')!='192.168.1.10' or not selected(host):continue
    count=(c.get('upload',0),c.get('download',0));current[c['id']]=count;old=previous.get(c['id'],(0,0))
    if count==old:continue
    print(json.dumps({'at':stamp,'id':c['id'],'host':host,'network':m.get('network'),'sourcePort':m.get('sourcePort'),'rule':c.get('rule'),'payload':c.get('rulePayload'),'chains':c.get('chains'),'upload':count[0],'download':count[1],'du':max(0,count[0]-old[0]),'dd':max(0,count[1]-old[1]),'initial':initial},ensure_ascii=False),flush=True)
   previous=current;initial=False
  except Exception as e:print(json.dumps({'at':stamp,'error':type(e).__name__}),flush=True)
  time.sleep(.5)
if __name__=='__main__':main()
