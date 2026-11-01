const test=require('node:test'),assert=require('node:assert/strict');
const {setTimeout:delay}=require('node:timers/promises');
const {createStartupRestore}=require('../../electron/startup-restore.cjs');

test('startup restores a temporarily unavailable connection once without blocking other connections',async()=>{
 let attempts=0,enabled=true;
 const first=createStartupRestore({enabled:()=>enabled,delays:[0,5,5],start:async()=>{attempts++;if(attempts===1)throw Error('service cold');return true;}});
 const pending=first.restore();assert.equal(first.restore(),pending);
 let independent=false;
 const second=createStartupRestore({enabled:()=>true,start:async()=>{independent=true;return true;}});
 assert.equal(await second.restore(),true);assert.equal(independent,true);
 assert.equal(await pending,true);assert.equal(attempts,2);
 enabled=false;assert.equal(await first.restore(),false);assert.equal(attempts,2);
 first.close();second.close();
});

test('manual off and shutdown cancel scheduled recovery; permanent failure is bounded',async()=>{
 for(const action of ['off','quit']){
  let enabled=true,calls=0;
  const recovery=createStartupRestore({enabled:()=>enabled,delays:[20,5],start:async()=>{calls++;return true;}});
  const pending=recovery.restore();
  if(action==='off'){enabled=false;recovery.cancel();}else recovery.close();
  assert.equal(await pending,false);await delay(25);assert.equal(calls,0);
 }
 let calls=0;
 const recovery=createStartupRestore({enabled:()=>true,delays:[0,1,1],start:async()=>{calls++;throw Error('missing');}});
 assert.equal(await recovery.restore(),false);assert.equal(calls,3);recovery.close();
});
