const test=require('node:test'),assert=require('node:assert/strict');
const {createNativeVoiceControlHandler}=require('../../electron/native-voice-control.cjs');
function fixture(){
 let port=43110,windows=[{webContents:{id:7,mainFrame:{frameTreeNodeId:42}}},{webContents:{id:8,mainFrame:{frameTreeNodeId:43}}}],host={control:action=>{calls.push(action);return true;}};
 const calls=[],event=(id=7,frameTreeNodeId=42)=>({sender:{id},senderFrame:{frameTreeNodeId,parent:null,detached:false,url:'http://127.0.0.1:'+port+'/'}});
 return{calls,event,windows,handle:createNativeVoiceControlHandler({windows:()=>windows,port:()=>port,host:()=>host}),setWindows:value=>windows=value,setPort:value=>port=value,setHost:value=>host=value};
}
test('the workbench top frame can wake and dismiss through stable Electron IDs',()=>{
 const f=fixture();assert.equal(f.handle(f.event(),'wake'),true);assert.equal(f.handle(f.event(),'dismiss'),true);assert.deepEqual(f.calls,['wake','dismiss']);
});
test('the companion window retains wake, dismiss and preview controls',()=>{
 const f=fixture();for(const action of ['wake','dismiss','preview'])assert.equal(f.handle(f.event(8,43),action),true);assert.deepEqual(f.calls,['wake','dismiss','preview']);
});
test('other windows, subframes, detached frames and foreign origins never reach the voice host',()=>{
 const f=fixture(),event=f.event();
 for(const bad of [undefined,{},f.event(99,100),{...event,senderFrame:{...event.senderFrame,parent:{}}},{...event,senderFrame:{...event.senderFrame,detached:true}},{...event,senderFrame:{...event.senderFrame,url:'https://example.com/'}},{...event,senderFrame:{...event.senderFrame,url:'http://localhost:43110/'}},{...event,senderFrame:null}]){
  assert.throws(()=>f.handle(bad,'wake'),{message:'VOICE_CONTROL_NOT_ALLOWED'});
 }
 assert.deepEqual(f.calls,[]);
});
test('window recreation and bridge port changes are checked at invocation time',()=>{
 const f=fixture(),old=f.event();f.setWindows([{webContents:{id:10,mainFrame:{frameTreeNodeId:70}}}]);f.setPort(43111);
 assert.throws(()=>f.handle(old,'wake'),/NOT_ALLOWED/);assert.equal(f.handle(f.event(10,70),'wake'),true);
 f.setWindows([]);assert.throws(()=>f.handle(f.event(10,70),'wake'),/NOT_ALLOWED/);
});
test('destroyed windows and invalid actions fail before dispatch',()=>{
 const f=fixture();f.windows[0].isDestroyed=()=>true;assert.throws(()=>f.handle(f.event(),'wake'),/NOT_ALLOWED/);
 for(const value of ['',null,{},'connect','constructor'])assert.throws(()=>f.handle(f.event(8,43),value),{message:'VOICE_CONTROL_INVALID'});
 assert.deepEqual(f.calls,[]);
});
test('an unavailable or stopped host returns false without manufacturing success',()=>{
 const f=fixture();f.setHost(null);assert.equal(f.handle(f.event(),'wake'),false);
 f.setHost({control:()=>false});assert.equal(f.handle(f.event(),'dismiss'),false);
});
