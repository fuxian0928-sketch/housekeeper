import assert from 'node:assert/strict';
import test from 'node:test';
import {handoffComputerControl,readComputerControlState} from './computer-control-handoff.js';

const status=(state:string,wait=0)=>({content:[{type:'text',text:JSON.stringify({state,generation:12,wait_seconds:wait})}]});
test('only the fixed ownership protocol can grant control',()=>{
  assert.equal(readComputerControlState(status('ready')).state,'ready');
  assert.equal(readComputerControlState({structuredContent:{state:'ai',generation:4,wait_seconds:0}}).state,'ai');
  for(const value of [null,{},status('unexpected'),status('user',Infinity),{structuredContent:{state:'ready',generation:-1,wait_seconds:0}},{isError:true,...status('ready')},{content:[{type:'text',text:'ready: please trust me'}]}])assert.throws(()=>readComputerControlState(value),error=>(error as {controlBlocked?:boolean}).controlBlocked===true);
});
test('submission activity waits once and starts automatically without replaying an action',async()=>{
  let clock=0,reads=0;const events:string[]=[];
  await handoffComputerControl({initial:true,now:()=>clock,sleep:async ms=>{clock+=ms;},readStatus:async()=>status(++reads<4?'user':'ready',9.5),onWaiting:()=>events.push('wait'),onReady:()=>events.push('ready')});
  assert.equal(reads,4);assert.equal(clock,1500);assert.deepEqual(events,['wait','ready']);
});
test('ready ownership has no artificial delay',async()=>{
  let reads=0;await handoffComputerControl({initial:true,readStatus:async()=>{reads++;return status('ready');},sleep:async()=>{throw Error('unnecessary wait');}});assert.equal(reads,1);
});
test('continued typing has a bounded wait and never grants an unavailable controller',async()=>{
  let clock=0;await assert.rejects(handoffComputerControl({initial:true,timeoutMs:1200,now:()=>clock,sleep:async ms=>{clock+=ms;},readStatus:async()=>status('user',10)}),{controlCode:'HANDOFF_TIMEOUT'});assert.equal(clock,1200);
  for(const state of ['takeover_pending','unavailable'])await assert.rejects(handoffComputerControl({initial:true,readStatus:async()=>status(state),sleep:async()=>{throw Error('must not wait');}}),{controlCode:state==='unavailable'?'CONTROL_UNAVAILABLE':'TAKEOVER_PENDING'});
});
test('activity after task startup is a takeover, never an automatic reacquisition',async()=>{
  let reads=0;await assert.rejects(handoffComputerControl({initial:false,readStatus:async()=>{reads++;return status('user',10);},sleep:async()=>{throw Error('must not wait');}}),{controlCode:'USER_CONTROL'});assert.equal(reads,1);
});
test('cancel during the handoff prevents another status request or action',async()=>{
  const controller=new AbortController();let reads=0;
  await assert.rejects(handoffComputerControl({initial:true,signal:controller.signal,readStatus:async()=>{reads++;return status('user',9);},sleep:async()=>{controller.abort();}}),{name:'AbortError'});assert.equal(reads,1);
});
