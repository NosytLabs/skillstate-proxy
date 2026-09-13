import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session-store.js';
import { startProxy, type ProxyConfig, type ProxyResult } from '../src/proxy.js';

const proxies: ProxyResult[]=[]; const servers:Server[]=[]; const dirs:string[]=[];
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const p of proxies.splice(0)) await p.close();
  for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}
  for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});
});
const transition='```json\n{"state_patch":{"n":1},"action":"done"}\n```';
const completion=(usage:any={prompt_tokens:10,completion_tokens:5})=>JSON.stringify({model:'returned-model',choices:[{index:0,message:{role:'assistant',content:transition},finish_reason:'stop'}],usage});
const frame=(text:string)=>'data: '+JSON.stringify({model:'returned-model',choices:[{index:0,delta:{content:text}}]})+'\n\n';
async function setup(handler:(res:ServerResponse)=>void|Promise<void>, cfg:Partial<ProxyConfig>={}) {
 const s=createServer(async(req,res)=>{for await(const _ of req){} await handler(res);}); servers.push(s);
 await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));
 const dir=mkdtempSync(join(tmpdir(),'ss-review-'));dirs.push(dir);
 const ledger=join(dir,'cost.jsonl');
 const p=await startProxy({listenPort:0,stateDir:join(dir,'state'),costLedgerPath:ledger,initialState:{n:0},schema:['n'],maxRetries:0,retryMaxAttempts:1,...cfg,upstreams:[{name:'mock',url:`http://127.0.0.1:${(s.address() as any).port}/v1`,priority:0}]});proxies.push(p);
 const base=`http://127.0.0.1:${p.port}`;
 const send=(stream=false,signal?:AbortSignal)=>fetch(base+'/v1/chat/completions',{method:'POST',signal,headers:{'content-type':'application/json','x-skillstate-session':'review'},body:JSON.stringify({model:'requested-model',stream,messages:[{role:'system',content:'spec'},{role:'user',content:'go'}]})});
 return{p,base,send,ledger};
}
describe('reviewed persistence boundaries',()=>{
 it('does not commit a stream that exceeded the capture limit',async()=>{
  const {base,send}=await setup(res=>{res.setHeader('content-type','text/event-stream');res.end(frame(transition)+': padding '+ 'x'.repeat(1024)+'\n\ndata: [DONE]\n\n');},{maxResponseCaptureBytes:256});
  await (await send(true)).text();
  const state:any=await fetch(base+'/state?session=review').then(r=>r.json());
  expect(state.step).toBe(0);expect(state.state).toEqual({n:0});
 });
 it('bounds non-stream response buffering without committing it',async()=>{
  const {base,send}=await setup(res=>{res.setHeader('content-type','application/json');res.end(completion()+' '.repeat(1024));},{maxResponseCaptureBytes:256});
  const result=await send();await result.text();expect(result.status).toBe(502);
  const state:any=await fetch(base+'/state?session=review').then(r=>r.json());expect(state.step).toBe(0);
 });
 it('serializes reset with an already active generation',async()=>{
  let started!:()=>void, release!:()=>void;
  const entered=new Promise<void>(r=>{started=r;});const gate=new Promise<void>(r=>{release=r;});
  const {base,send,p}=await setup(async res=>{started();await gate;res.setHeader('content-type','application/json');res.end(completion());});
  const request=send();await entered;
  // Observe actual request arrival; release only after its handler has reached the lock.
  let observed!:()=>void; const resetArrived=new Promise<void>(r=>{observed=r;});
  p.server.on('request',(req)=>{if(req.method==='DELETE')setImmediate(observed);});
  const resetting=fetch(base+'/state?session=review',{method:'DELETE'});
  try{await resetArrived;}finally{release();}
  await (await request).text();expect((await resetting).status).toBe(204);
  expect((await fetch(base+'/state?session=review')).status).toBe(404);
 });
 it('records reported model identity rather than the requested alias',async()=>{
  const {send,ledger}=await setup(res=>{res.setHeader('content-type','application/json');res.end(completion());});
  await (await send()).text();
  const row=JSON.parse(readFileSync(ledger,'utf8').trim().split('\n')[0]);expect(row.model).toBe('returned-model');
 });
 it('retains a usage-unavailable attempt instead of omitting the generation',async()=>{
  const {send,ledger}=await setup(res=>{res.setHeader('content-type','application/json');res.end(completion(undefined).replace(/,"usage":.*}$/, '}'));});
  const result=await send();await result.text();expect(result.headers.get('x-skillstate-pricing')).toBe('usage-unavailable');
  const rows=readFileSync(ledger,'utf8').trim().split('\n').filter(Boolean);expect(rows).toHaveLength(1);const row=JSON.parse(rows[0]);expect(row.pricingStatus).toBe('usage-unavailable');expect(row.costUsd).toBeUndefined();
 });
});

describe('reviewed failure lifecycle',()=>{
 it('keeps cached state unchanged when persistence fails',async()=>{
  const original=SessionStore.prototype.save;
  vi.spyOn(SessionStore.prototype,'save').mockImplementation(function(this:SessionStore,id,session){
    if(session.step>0)throw new Error('simulated disk write failure');
    return original.call(this,id,session);
  });
  const {base,send}=await setup(res=>{res.setHeader('content-type','application/json');res.end(completion());});
  const result=await send();await result.text();expect(result.status).toBe(500);
  const state:any=await fetch(base+'/state?session=review').then(r=>r.json());
  expect(state.step).toBe(0);expect(state.state).toEqual({n:0});
 });
 it('bounds upstream error response buffering as well as success responses',async()=>{
  const {send}=await setup(res=>{res.statusCode=500;res.end('x'.repeat(4096));},{maxResponseCaptureBytes:256});
  const result=await send();const text=await result.text();
  expect(result.status).toBe(502);expect(Buffer.byteLength(text)).toBeLessThan(256);
 });
 it('aborts the upstream when the client disconnects before response headers',async()=>{
  let entered!:()=>void,closed!:()=>void;let pending:ServerResponse|undefined;
  const started=new Promise<void>(r=>{entered=r;});const disconnected=new Promise<void>(r=>{closed=r;});
  const {send}=await setup(res=>{pending=res;res.once('close',closed);entered();},{connectTimeoutMs:2000,requestTimeoutMs:5000});
  const controller=new AbortController();const request=send(false,controller.signal).catch(()=>undefined);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    await started;controller.abort();await request;
    const stopped=await Promise.race([disconnected.then(()=>true),new Promise<boolean>(r=>{timer=setTimeout(()=>r(false),700);})]);
    expect(stopped).toBe(true);
  }finally{clearTimeout(timer);pending?.end(completion());}
 });
});
