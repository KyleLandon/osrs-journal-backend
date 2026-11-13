const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {stripTypeScriptTypes} = require('node:module');
const root = path.join(__dirname,'../functions');

function load(file,c) {
  const source=fs.readFileSync(path.join(root,file),'utf8')
    .replace(/^import .*;$/gm,'').replace(/^export /gm,'');
  vm.runInContext(stripTypeScriptTypes(source),c,{filename:file});
}
function environment(extra={}) {
  let handler;
  const c=vm.createContext({console,Request,Response,URL,crypto,
    Deno:{env:{get:()=>undefined},serve:fn=>handler=fn},
    handleOptions:()=>null,checkPluginClientId:()=>true,
    checkRateLimit:async()=>true,clientIp:()=> 'fixture-ip',
    jsonResponse:(data,status=200)=>Response.json(data,{status}),
    errorResponse:(error,status=400)=>Response.json({error},{status}),...extra});
  return {c,load:file=>load(file,c),request:async(body={},headers={})=>handler(new Request('https://fixture.invalid/',{
    method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}))};
}
function database(results={}) {
  const calls=[];
  return {calls,from(table){
    const q={};calls.push({table,operations:[]});const call=calls.at(-1);
    for(const method of ['select','delete','insert','eq','is','gt','lt','update']) q[method]=(...args)=>{
      call.operations.push({method,args});return q;
    };
    q.maybeSingle=async()=>results[table]||{data:null,error:null};
    q.then=(resolve,reject)=>Promise.resolve(results[table]||{data:null,error:null}).then(resolve,reject);
    return q;
  }};
}

test('pair-init always issues a fresh pending token without looking up existing credentials',async()=>{
  const db=database({user_characters:{data:{rsn:'Owner',sync_token:'old-secret'}}});
  const e=environment({adminClient:()=>db,generatePairCode:()=> 'ABCD-EFGH'});
  e.load('pair-init/index.ts');
  const res=await e.request({rsn:'Owner'}),body=await res.json();
  assert.equal(res.status,200);assert.equal(body.linked,false);
  assert.notEqual(body.sync_token,'old-secret');
  assert.match(body.sync_token,/^[a-f0-9-]{36}$/);
  assert.ok(!db.calls.some(c=>c.table==='user_characters'));
  const again=await (await e.request({rsn:'Owner'})).json();
  assert.notEqual(again.sync_token,body.sync_token);
  assert.ok(!db.calls.some(c=>c.operations.some(op=>op.method==='eq'&&op.args[0]==='rsn')));
});

test('malformed pairing bodies are rejected without throwing',async()=>{
  const e=environment();e.load('pair-init/index.ts');
  for(const body of [null,{rsn:12},{}]) assert.equal((await e.request(body)).status,400);
});

test('pending credentials cannot resolve to a character or mint a private session',async()=>{
  const db=database({pair_sessions:{data:{code:'ABCD-EFGH',rsn:'Owner'}}});
  const e=environment();e.load('_shared/supabase.ts');
  assert.equal(await e.c.resolveSyncToken(db,'pending-token'),null);
  assert.ok(!db.calls.some(c=>c.table==='pair_sessions'));
  e.c.adminClient=()=>db;e.load('localhost-session/index.ts');
  assert.equal((await e.request({}, {'X-Sync-Token':'pending-token'})).status,401);
  assert.ok(!db.calls.some(c=>c.table==='localhost_sessions'));
});

test('claimed credentials resolve and pending-code recognition grants no data access',async()=>{
  const db=database({user_characters:{data:{rsn:'Owner'}},pair_sessions:{data:{code:'ABCD-EFGH'}}});
  const e=environment();e.load('_shared/supabase.ts');
  const resolved=await e.c.resolveSyncToken(db,'claimed-token');
  assert.equal(resolved.rsn,'Owner');assert.equal(resolved.claimed,true);
  assert.equal(await e.c.hasPendingPairSession(db,'pending-token'),true);
  const ops=db.calls.at(-1).operations;
  assert.ok(ops.some(op=>op.method==='is'&&op.args[0]==='claimed_by'&&op.args[1]===null));
  assert.ok(ops.some(op=>op.method==='gt'&&op.args[0]==='expires_at'));
});

test('database verification errors fail closed',async()=>{
  const db=database({user_characters:{error:{message:'offline'}}});
  const e=environment();e.load('_shared/supabase.ts');
  await assert.rejects(e.c.resolveSyncToken(db,'token'),/Could not verify/);
});

test('sync waits for a pending code without writing or triggering plugin token repair',async()=>{
  const writes=[];
  const e=environment({adminClient:()=>({from:()=>writes.push(true)}),
    resolveSyncToken:async()=>null,hasPendingPairSession:async()=>true});
  e.load('sync/index.ts');
  const res=await e.request({rsn:'Owner',player_skills:[{skill:'attack',level:99}]},{'X-Sync-Token':'pending'});
  assert.equal(res.status,409);assert.equal(writes.length,0);
  assert.match((await res.json()).error,/claim the code/);
});

test('an expired or unknown token is rejected so the plugin can repair it',async()=>{
  const e=environment({adminClient:()=>({}),resolveSyncToken:async()=>null,hasPendingPairSession:async()=>false});
  e.load('sync/index.ts');
  assert.equal((await e.request({}, {'X-Sync-Token':'expired'})).status,401);
});

test('claim endpoint uses the verified auth user and atomic RPC, never caller-supplied identity',async()=>{
  const calls=[];
  const e=environment({userClient:()=>({auth:{getUser:async()=>({data:{user:{id:'verified-owner'}}})}}),
    adminClient:()=>({rpc:async(name,args)=>(calls.push({name,args}),{data:'Owner',error:null})})});
  e.load('pair-claim/index.ts');
  const res=await e.request({code:'abcd-efgh',user_id:'attacker'},{Authorization:'Bearer fixture'});
  assert.equal(res.status,200);
  assert.equal(calls[0].name,'claim_pair_session');
  assert.equal(calls[0].args.p_user_id,'verified-owner');
  assert.equal(calls[0].args.p_code,'ABCD-EFGH');
});

test('claim endpoint denies missing identity, other owners, and consumed codes',async()=>{
  let message='Character already linked to another account';
  const e=environment({userClient:()=>({auth:{getUser:async()=>({data:{user:{id:'owner'}}})}}),
    adminClient:()=>({rpc:async()=>({data:null,error:{message}})})});
  e.load('pair-claim/index.ts');
  assert.equal((await e.request({code:'ABCD-EFGH'})).status,401);
  assert.equal((await e.request({code:'ABCD-EFGH'},{Authorization:'Bearer fixture'})).status,403);
  message='Invalid or expired pairing code';
  assert.equal((await e.request({code:'ABCD-EFGH'},{Authorization:'Bearer fixture'})).status,404);
});
