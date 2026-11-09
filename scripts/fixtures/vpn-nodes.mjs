// NPM-121/NPM-122 isolated group-list and category fixture; never contacts a router.
const now=new Date().toISOString();
const node=(name,delay)=>({name,type:'Vless',alive:delay>0,history:delay===null?[]:[{time:now,delay}],udp:true});
const nodes=[node('Обычный · 531 мс',531),node('Быстрый · 31 мс',31),node('Средний · 104 мс',104),node('Медленный · 1500 мс',1500),node('Нет ответа',0),node('Не проверялся',null),...Array.from({length:16},(_,i)=>node(`Сервер ${i+1}`,i%3?70+i*5:0))];
const group={name:'AUTO',type:'Fallback',all:nodes.map(n=>n.name),now:nodes[0].name,history:[{time:now,delay:531}]};
const proxies={DIRECT:{name:'DIRECT',type:'Direct',history:[]},REJECT:{name:'REJECT',type:'Reject',history:[]},...Object.fromEntries(nodes.map(n=>[n.name,n])),AUTO:group,'ИИ':{name:'ИИ',type:'Selector',all:nodes.map(n=>n.name),now:nodes[1].name},GLOBAL:{name:'GLOBAL',type:'Selector',all:['AUTO','ИИ',...nodes.map(n=>n.name)],now:'AUTO'}};
const meta=Object.fromEntries(nodes.map((n,i)=>[n.name,{provider:i===0?'':i%2?'SL-demo-a':'SL-demo-b',source:i===0?'':i%2?'Подписка Альфа':'Подписка Бета',type:'vless',server:`192.0.2.${i+1}`,port:443}]));
const providers=Object.fromEntries(['SL-demo-a','SL-demo-b'].map(key=>[key,{name:key,type:'Proxy',vehicleType:'File',proxies:nodes.filter(n=>meta[n.name].provider===key),adaptive:{mode:'normal',results:Object.fromEntries(nodes.filter(n=>meta[n.name].provider===key&&n.history.length).map((n,i)=>[n.name,{available:n.alive,country:i%2?'DE':'FI'}]))}}]));
proxies['Игры']={name:'Игры',type:'Fallback',all:['AUTO','DIRECT'],now:'AUTO'};
proxies['GLOBAL'].all.unshift('Игры');
export function fakeVpnNodes(req,res){
 const path=req.url.split('?')[0];let value;
 const selected=path.match(/^\/api\/mihomo\/proxies\/([^/]+)$/);
 if(req.method==='PUT'&&selected){
  let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
   const g=proxies[decodeURIComponent(selected[1])];const name=JSON.parse(body).name;
   if(!g?.all?.includes(name)){res.statusCode=400;res.end('{}');return;}
   g.now=name;if(g.type!=='Selector')g.fixed=name;res.statusCode=204;res.end();
  });return true;
 }
 if(path==='/api/core/status')value={ok:true,status:{installed:true,running:true,controller_ok:true,version:'preview'}};
 if(path==='/api/mihomo/configs')value={mode:'rule'};
 if(path==='/api/core/devices')value={devices:[]};
 if(path==='/api/core/nodes')value={nodes:meta};
 if(path==='/api/mihomo/proxies')value={proxies};
 if(path==='/api/mihomo/providers/proxies')value={providers};
 if(value){res.end(JSON.stringify(value));return true;}return false;
}
