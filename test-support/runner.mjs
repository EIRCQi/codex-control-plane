import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
export async function until(fn,label,timeout=8000){const start=Date.now();while(Date.now()-start<timeout){const value=await fn();if(value)return value;await delay(25);}throw new Error('Timeout: '+label);}
export async function fixture(){
  const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'ccp-reliability-')));
  const repo=path.join(dir,'repo'),data=path.join(dir,'data'),fake=path.join(dir,'codex'),marker=path.join(dir,'descendant.json');
  await mkdir(repo);await mkdir(data);
  const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q');git('config','user.email','audit@example.invalid');git('config','user.name','Audit');
  await writeFile(path.join(repo,'README.md'),'baseline\n');git('add','.');git('commit','-qm','Initial');
  const helper=path.join(dir,'tool.cjs');
  await writeFile(helper,`const fs=require('node:fs');let n=0;const tick=()=>{fs.writeFileSync('ongoing-tool.txt',String(++n));fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,n}));};tick();process.on('SIGTERM',()=>{});setInterval(tick,50);setTimeout(()=>process.exit(0),20000);`);
  await writeFile(fake,`#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex-cli 1.2.3');process.exit(0);}
if(args.includes('login')){process.exit(0);}
if(args.at(-1).includes('quota peer')){
  console.log(JSON.stringify({type:'output',message:'peer ready'}));setInterval(()=>{},1000);
}else if(args.includes('workspace-write') && args.at(-1).includes('tree cancellation')){
  require('node:child_process').spawn(process.execPath,[${JSON.stringify(helper)}],{stdio:['ignore','inherit','inherit']});
  setInterval(()=>{},1000);
}else{
  if(args.includes('workspace-write'))fs.writeFileSync('README.md','approved change\\n');
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Ready'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
}
`,{mode:0o755});
  const servers=[];
  async function launch({expectFailure=false}={}){
    const child=spawn(process.execPath,['server.mjs'],{cwd:root,detached:true,env:{...process.env,PORT:'0',CODEX_CONTROL_PLANE_DATA_DIR:data,CODEX_CONTROL_PLANE_CODEX_BIN:fake,CODEX_CONTROL_PLANE_GIT_BIN:''},stdio:['ignore','pipe','pipe']});
    const record={child,closed:false,output:''};servers.push(record);
    record.done=new Promise(resolve=>child.once('exit',(code,signal)=>{record.closed=true;resolve({code,signal});}));
    child.stdout.on('data',c=>record.output+=c);child.stderr.on('data',c=>record.output+=c);
    if(expectFailure){await until(()=>record.closed,'rejected startup');return record;}
    record.url=await until(()=>record.output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0],'runner startup');
    record.request=async(route,method='GET',body)=>{
      const response=await fetch(record.url+route,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)});
      return {status:response.status,body:await response.json()};
    };
    record.run=async id=>(await record.request('/api/runs/'+id)).body;
    record.state=(id,state)=>until(async()=>{const value=await record.run(id);return value.state===state&&!value.starting&&value;},'state '+state);
    return record;
  }
  async function stop(record,signal='SIGTERM'){
    if(record.closed)return;
    record.child.kill(signal);
    const result=await Promise.race([record.done,delay(4500).then(()=>null)]);
    if(!result){try{process.kill(-record.child.pid,'SIGKILL');}catch{}await record.done;}
  }
  async function cleanup(){
    try{const info=JSON.parse(await readFile(marker,'utf8'));if(alive(info.pid))process.kill(info.pid,'SIGKILL');}catch{}
    for(const record of servers)await stop(record);
    const worktrees=await realpath(path.join(os.tmpdir(),'codex-control-plane-worktrees'));
    for(const line of git('worktree','list','--porcelain').split('\n'))if(line.startsWith('worktree ')){
      const file=line.slice(9);if(file!==repo&&file.startsWith(worktrees+path.sep))await rm(file,{recursive:true,force:true});
    }
    await rm(dir,{recursive:true,force:true});
  }
  return{dir,repo,data,marker,git,launch,stop,cleanup};
}
