// NPM-121 isolated group-list acceptance fixture; never contacts a router.
const now=new Date().toISOString();
const node=(name,delay)=>({name,type:'Vless',alive:delay>0,history:delay===null?[]:[{time:now,delay}],udp:true});
const nodes=[node('Обычный · 531 мс',531),node('Быстрый · 31 мс',31),node('Средний · 104 мс',104),node('Медленный · 1500 мс',1500),node('Нет ответа',0),node('Не проверялся',null),...Array.from({length:16},(_,i)=>node(`Сервер ${i+1}`,i%3?70+i*5:0))];
const group={name:'AUTO',type:'Fallback',all:nodes.map(n=>n.name),now:nodes[0].name,history:[{time:now,delay:531}]};
const proxies={DIRECT:{name:'DIRECT',type:'Direct',history:[]},REJECT:{name:'REJECT',type:'Reject',history:[]},...Object.fromEntries(nodes.map(n=>[n.name,n])),AUTO:group,'ИИ':{name:'ИИ',type:'Selector',all:nodes.map(n=>n.name),now:nodes[1].name},GLOBAL:{name:'GLOBAL',type:'Selector',all:['AUTO','ИИ',...nodes.map(n=>n.name)],now:'AUTO'}};
export function fakeVpnNodes(req,res){
 const path=req.url.split('?')[0];let value;
 if(path==='/api/core/status')value={ok:true,status:{installed:true,running:true,controller_ok:true,version:'preview'}};
 if(path==='/api/mihomo/configs')value={mode:'rule'};
 if(path==='/api/core/devices')value={devices:[]};
 if(path==='/api/core/nodes')value={nodes:{}};
 if(path==='/api/mihomo/proxies')value={proxies};
 if(path==='/api/mihomo/providers/proxies')value={providers:{}};
 if(value){res.end(JSON.stringify(value));return true;}return false;
}
