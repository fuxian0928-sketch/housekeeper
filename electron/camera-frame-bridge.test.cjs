const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createCameraFrameBridge}=require('./camera-frame-bridge.cjs');
function fixture(){
  const ipcMain=new EventEmitter(),webContents=new EventEmitter(),sent=[];
  Object.assign(webContents,{id:12,mainFrame:{frameTreeNodeId:13},send:(channel,value)=>sent.push({channel,...value})});
  const window={webContents},valid={sender:{id:12},senderFrame:{frameTreeNodeId:13,parent:null,url:'http://127.0.0.1:43110/?surface=companion'}};
  let enabled=true;
  const bridge=createCameraFrameBridge({ipcMain,window:()=>window,enabled:()=>enabled,port:()=>43110,timeoutMs:40});
  return{ipcMain,sent,bridge,valid,disable:()=>{enabled=false;},frame:'data:image/jpeg;base64,YQ=='};
}
test('camera capture requires consent and does not cache frames',async()=>{
  const f=fixture();f.disable();assert.equal(await f.bridge.capture(),null);assert.equal(f.sent.length,0);f.bridge.close();
  const g=fixture();const result=g.bridge.capture();const request=g.sent[0];
  assert.equal(await g.bridge.capture(),null,'one capture in flight');
  g.ipcMain.emit('companion:camera-frame',g.valid,{id:request.id,frame:g.frame});
  assert.equal(await result,g.frame);assert.equal(g.sent.at(-1).cancel,true);
  const next=g.bridge.capture();assert.notEqual(g.sent.at(-1).id,request.id);g.bridge.close();assert.equal(await next,null);
});
test('forged window, subframe, foreign origin and nonce cannot supply a camera frame',async()=>{
  for(const invalid of [
    {sender:{id:99},senderFrame:{frameTreeNodeId:99,parent:null,url:'http://127.0.0.1:43110/'}},
    {sender:{id:12},senderFrame:{frameTreeNodeId:14,parent:{},url:'http://127.0.0.1:43110/'}},
    {sender:{id:12},senderFrame:{frameTreeNodeId:13,parent:null,url:'https://foreign.invalid'}}
  ]){
    const f=fixture(),result=f.bridge.capture();f.ipcMain.emit('companion:camera-frame',invalid,{id:f.sent[0].id,frame:f.frame});f.bridge.close();assert.equal(await result,null);
  }
  const f=fixture(),result=f.bridge.capture();f.ipcMain.emit('companion:camera-frame',f.valid,{id:'wrong-nonce',frame:f.frame});f.bridge.close();assert.equal(await result,null);
});
test('timeout, cancellation and invalid image payload resolve without retaining the camera',async()=>{
  const f=fixture();assert.equal(await f.bridge.capture(),null);f.bridge.close();
  const g=fixture(),controller=new AbortController(),result=g.bridge.capture(controller.signal);controller.abort();assert.equal(await result,null);assert.equal(g.sent.at(-1).cancel,true);g.bridge.close();
  const h=fixture(),invalid=h.bridge.capture();h.ipcMain.emit('companion:camera-frame',h.valid,{id:h.sent[0].id,frame:'https://untrusted.invalid/image.jpg'});assert.equal(await invalid,null);h.bridge.close();
});
