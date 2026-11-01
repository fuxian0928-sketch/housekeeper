const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createComputerBridgeHost,computerAutoConnect}=require('../electron/computer-bridge-host.cjs');

test('Windows connection survives app restart while explicit disconnect remains off',async t=>{
 const dataDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'xiwei-auto-connect-'));t.after(()=>fs.rmSync(dataDirectory,{recursive:true,force:true}));
 let starts=0,operations=0;
 const create=()=>createComputerBridgeHost({port:43110,deviceId:'saved-desktop',dataDirectory,
  driver:{status:()=>({}),async start(){starts++;},async stop(){},async listTools(){return[{name:'Snapshot'}];},async callTool(){operations++;}},
  encrypt:value=>Buffer.from(value),decrypt:value=>value.toString(),fetch:async url=>new Response(JSON.stringify(url.endsWith('/register')?{sessionId:'saved-session'}:{command:null}))});
 const first=create();assert.equal((await first.restore()).connected,false);assert.equal(starts,0);
 assert.equal((await first.connect()).connecting,false);await first.close();
 assert.equal(computerAutoConnect(dataDirectory),true);
 const next=create();assert.equal((await next.restore()).connected,true);assert.equal(starts,2);
 assert.equal(operations,0,'restoring a connection must not replay an old operation');
 await next.disconnect();await next.close();assert.equal(computerAutoConnect(dataDirectory),false);
 const off=create();assert.equal((await off.restore()).connected,false);assert.equal(starts,2);await off.close();
});

test('an existing Windows identity migrates once and corrupt preferences never auto-connect',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xiwei-connect-migrate-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'computer-bridge-token.bin'),'encrypted-existing-identity');
 assert.equal(computerAutoConnect(dir),true);
 fs.writeFileSync(path.join(dir,'computer-connection.json'),'{broken');assert.equal(computerAutoConnect(dir),false);
});
test('desktop bridge starts driver, preserves unknown outcome, strips image base64 and stops cleanly',async()=>{
  let ready=false,stopped=false,polls=0,receipt;
  let completed;const received=new Promise(resolve=>{completed=resolve;});
  const driver={status:()=>({state:ready?'ready':'stopped'}),async start(){ready=true;},async listTools(){assert.ok(ready);return[{name:'Snapshot',inputSchema:{type:'object'}}];},async callTool(){return{outcomeUnknown:true,result:{isError:true,content:[{type:'text',text:'控制权发生变化'},{type:'image',data:'must-not-forward'}]}};},async stop(){stopped=true;ready=false;}};
  const host=createComputerBridgeHost({port:43110,deviceId:'fake-device',dataDirectory:fs.mkdtempSync(path.join(os.tmpdir(),'xiwei-host-')),driver,encrypt:value=>Buffer.from(value),decrypt:value=>value.toString(),fetch:async(url,options)=>{
    const body=JSON.parse(options.body);let result={};
    if(url.endsWith('/register'))result={sessionId:'session-one'};
    if(url.endsWith('/poll'))result={command:polls++===0?{id:'command-one',sessionId:'session-one',tool:'Snapshot',arguments:{}}:null};
    if(url.endsWith('/receipt')){receipt=body;completed();}
    return new Response(JSON.stringify(result));
  }});
  await host.connect();await received;assert.equal(receipt.outcomeUnknown,true);assert.equal(receipt.result.content.length,1);assert.ok(!JSON.stringify(receipt.result).includes('must-not-forward'));assert.ok(!Object.hasOwn(host.status(),'token'));await host.disconnect();assert.ok(stopped);assert.equal(host.status().connected,false);
});
test('failed driver startup does not register a usable desktop',async()=>{
  let registered=false;
  const host=createComputerBridgeHost({port:43110,deviceId:'fake-device',dataDirectory:fs.mkdtempSync(path.join(os.tmpdir(),'xiwei-host-')),driver:{status:()=>({state:'failed'}),start:async()=>{throw Error('UVX缺失');},stop:async()=>{},listTools:async()=>{throw Error('should not list');}},encrypt:value=>Buffer.from(value),decrypt:value=>value.toString(),fetch:async()=>{registered=true;return new Response('{}');}});
  await assert.rejects(host.connect(),/UVX缺失/);assert.equal(registered,false);assert.equal(host.status().connected,false);
});
test('lost receipt acknowledgement retries the result without polling or executing again',async()=>{
 let polls=0,calls=0,receipts=0,firstReceipt,prematurePoll=false,complete;
 const done=new Promise(resolve=>{complete=resolve;});
 const driver={status:()=>({state:'ready'}),async start(){},async listTools(){return[{name:'Snapshot',inputSchema:{type:'object'}}];},async callTool(){calls++;return{result:{content:[{type:'text',text:'操作完成'}]}};},async stop(){}};
 const host=createComputerBridgeHost({port:43110,deviceId:'receipt-device',dataDirectory:fs.mkdtempSync(path.join(os.tmpdir(),'xiwei-receipt-')),driver,encrypt:value=>Buffer.from(value),decrypt:value=>value.toString(),fetch:async(url,options)=>{
  const body=JSON.parse(options.body);
  if(url.endsWith('/register'))return new Response('{"sessionId":"receipt-session"}');
  if(url.endsWith('/poll')){if(polls>0&&receipts<2)prematurePoll=true;return new Response(JSON.stringify({command:polls++===0?{id:'receipt-command',sessionId:'receipt-session',tool:'Snapshot',arguments:{}}:null}));}
  if(url.endsWith('/receipt')){receipts++;if(receipts===1){firstReceipt=body;throw Error('acknowledgement lost');}assert.deepEqual(body,firstReceipt);complete();return new Response('{"recorded":true,"duplicate":true}');}
  return new Response('{}');
 }});
 try{await host.connect();await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(Error('receipt not retried')),3000))]);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,1);assert.equal(receipts,2);assert.equal(prematurePoll,false);assert.equal(host.status().awaitingReceipt,false);}
 finally{await host.disconnect();}
});

test('disconnect while dependencies are starting prevents late connection and registration',async()=>{
  let started,registered=false,stopped=false;const starting=new Promise(resolve=>{started=resolve;});
  const driver={status:()=>({state:'starting'}),start:({signal})=>{started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},listTools:async()=>{throw Error('cancelled startup must not list');},stop:async()=>{stopped=true;}};
  const host=createComputerBridgeHost({port:43110,deviceId:'cancel-device',dataDirectory:fs.mkdtempSync(path.join(os.tmpdir(),'xiwei-host-')),driver,encrypt:value=>Buffer.from(value),decrypt:value=>value.toString(),fetch:async()=>{registered=true;return new Response('{}');}});
  const pending=host.connect();const failed=assert.rejects(pending);await starting;await host.disconnect();await failed;assert.equal(registered,false);assert.equal(host.status().connected,false);assert.equal(host.status().connecting,false);assert.ok(stopped);
});
