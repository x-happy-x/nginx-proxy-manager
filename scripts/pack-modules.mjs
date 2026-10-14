// Package already-built candidates using the matching DMS client. No deployment.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [arch,client,version='1.0.0',dmsRoot]=process.argv.slice(2);
if(!['amd64','arm64','arm','mips','mipsle'].includes(arch)||!client||!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Usage: node scripts/pack-modules.mjs ARCH /absolute/path/dms-client [VERSION]');
const build=path.join(root,'.runtime/modules',`linux-${arch}`);
const output=path.join(root,'.runtime/release',`linux-${arch}`);await mkdir(output,{recursive:true});
const gitRevision=cwd=>{const r=spawnSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'});if(r.status!==0)throw new Error('Cannot identify source revision');return r.stdout.trim();};
const release={schema:1,core_api:1,arch,sources:{homenet:gitRevision(root)},packages:[]};
if(!dmsRoot)throw new Error('Pass the matching DMS source directory as the fourth argument');
const dms=path.resolve(dmsRoot);release.sources.dms=gitRevision(dms);
const dmsFile=path.join(output,'dms-service');
const built=spawnSync('go',['build','-trimpath','-ldflags=-s -w','-o',dmsFile,'./cmd/dms-service'],{cwd:dms,env:{...process.env,CGO_ENABLED:'0',GOOS:'linux',GOARCH:arch,GOARM:'7',GOMIPS:'softfloat'},stdio:'inherit'});
if(built.error)throw built.error;if(built.status!==0)throw new Error('DMS build failed');
const dmsBody=await readFile(dmsFile);release.packages.push({id:'dms',version:'0.4.1',type:'service-binary',file:'dms-service',bytes:dmsBody.length,sha256:createHash('sha256').update(dmsBody).digest('hex')});
// Core is staged without restarting it: first migration needs an explicit
// guarded cutover. DMS remains available throughout that separate operation.
const coreManifest={version:'1',app:'homenet-core',metadata:{name:'HomeNet Core',version,os:'linux',arch},artifacts:[{source:'core',destination:`/opt/share/homenet/core/releases/${version}`,mode:493}]};
const coreConfig=path.join(build,'core.dms.json');await writeFile(coreConfig,JSON.stringify(coreManifest,null,2));
const coreName=`homenet-core-${version}-linux-${arch}.dms.tar.gz`;const coreFile=path.join(output,coreName);
const coreResult=spawnSync(path.resolve(client),['pack','--config',coreConfig,'--output',coreFile],{stdio:'inherit',shell:false});
if(coreResult.error)throw coreResult.error;if(coreResult.status!==0)throw new Error('Core packaging failed');
const coreBody=await readFile(coreFile);release.packages.push({id:'core',version,file:coreName,bytes:coreBody.length,sha256:createHash('sha256').update(coreBody).digest('hex')});
for(const id of ['proxy','network','vpn']){
 const module=JSON.parse(await readFile(path.join(build,id,version,'manifest.json'),'utf8'));
 if(module.version!==version||module.arch!==arch)throw new Error('Candidate identity mismatch');
 const manifest={version:'1',app:`homenet-${id}`,metadata:{name:module.name,description:module.description,version,os:'linux',arch},integration:{staged:true,schema:1,id,core_api:1,ui_api:module.ui_api,data_schema:module.data_schema,dependencies:module.dependencies||[]},artifacts:[{source:`${id}/${version}`,destination:`/opt/share/homenet/integrations/${id}/${version}`,mode:493}]};
 const config=path.join(build,`${id}.dms.json`);await writeFile(config,JSON.stringify(manifest,null,2));
 const name=`homenet-${id}-${version}-linux-${arch}.dms.tar.gz`;const file=path.join(output,name);
 const result=spawnSync(path.resolve(client),['pack','--config',config,'--output',file],{stdio:'inherit',shell:false});
 if(result.error)throw result.error;if(result.status!==0)throw new Error(`DMS packaging failed for ${id}`);
 const body=await readFile(file);release.packages.push({id,version,file:name,bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')});
}
await writeFile(path.join(output,'release-set.json'),JSON.stringify(release,null,2)+'\n');
console.log(`Staged integration packages and checksums: ${output}`);
