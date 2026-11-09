// Isolated hosting UI fixture: no real key or provider request.
let accounts = [{id:'sample',name:'Основной аккаунт',provider:'ishosting',token_set:true,checked_at:Math.floor(Date.now()/1000),last_ok:Math.floor(Date.now()/1000),servers:1}];
const server={id:'482492',account:'sample',name:'Lite — Linux SSD',ip:'192.0.2.84',country:'Kazakhstan',country_code:'KZ',cpu:'Xeon 1×2.60 GHz',ram:'1 Gb',disk:'20GB SSD',os:'Ubuntu 22',status:'running',state:'Active'};
export function fakeHostings(req,res){
 const path=req.url.split('?')[0];if(!path.startsWith('/api/hostings/'))return false;
 const overview=()=>({ok:true,accounts,servers:accounts.length?[server]:[],providers:[{id:'ishosting',name:'is*hosting'}]});
 if(req.method==='GET'||path.endsWith('/refresh')){res.end(JSON.stringify(overview()));return true;}
 let body='';req.on('data',b=>body+=b);req.on('end',()=>{const value=JSON.parse(body||'{}');
 if(path.endsWith('/remove'))accounts=accounts.filter(a=>a.id!==value.id);
 else if(path.endsWith('/accounts')){const a={...accounts[0],id:value.id||'sample',name:value.name,provider:'ishosting',token_set:true};accounts=[a];}
 res.end(JSON.stringify({ok:true}));});return true;
}
