const fs=require('node:fs');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {saveJsonAtomically}=require('./atomic-json-store.cjs');

function computerAutoConnect(dataDirectory){
 const file=path.join(dataDirectory,'computer-connection.json');
 try{return JSON.parse(fs.readFileSync(file,'utf8')).autoConnect===true;}
 catch{
  // Existing identity proves this device was previously connected. An explicit
  // off preference always wins, including after application shutdown.
  return !fs.existsSync(file)&&fs.existsSync(path.join(dataDirectory,'computer-bridge-token.bin'));
 }
}

function createComputerBridgeHost({port,deviceId,dataDirectory,driver,encrypt,decrypt,fetch:request=fetch}){
  let controller=null,running=null,connected=false,error='',sessionId='',activeCommand=null,connecting=null,pendingReceipt=null,closed=false;
  const remember=value=>saveJsonAtomically(path.join(dataDirectory,'computer-connection.json'),{autoConnect:value});
  const tokenPath=path.join(dataDirectory,'computer-bridge-token.bin');
  function token(){
    if(fs.existsSync(tokenPath))return decrypt(fs.readFileSync(tokenPath));
    const value=randomBytes(32).toString('hex');fs.mkdirSync(dataDirectory,{recursive:true});fs.writeFileSync(tokenPath,encrypt(value),{mode:0o600,flag:'wx'});return value;
  }
  async function post(route,body,signal){const response=await request(`http://127.0.0.1:${port}/api/computer/${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal??AbortSignal.timeout(8000)});const payload=await response.json();if(!response.ok)throw Error(payload.message||'电脑连接未完成');return payload;}
  function publicStatus(){return {connected,connecting:!!connecting,autoConnect:computerAutoConnect(dataDirectory),active:connected&&!!activeCommand,awaitingReceipt:!!pendingReceipt,error,driver:driver.status(),deviceId};}
  async function loop(signal,key){
    while(!signal.aborted){
      try{
        if(pendingReceipt){
          await post('receipt',pendingReceipt,AbortSignal.any([signal,AbortSignal.timeout(8000)]));
          pendingReceipt=null;activeCommand=null;
        }else{
        const payload=await post('poll',{deviceId,token:key},AbortSignal.any([signal,AbortSignal.timeout(8000)]));
        const command=payload.command;
        if(command){
          activeCommand=command.id;let result=null,fault=null,outcomeUnknown=false;
          try{
            const output=await driver.callTool(command.tool,command.arguments,{signal});
            outcomeUnknown=output.outcomeUnknown===true;
            result=output.result??output;
            if(output.errorCode)result={...result,controlCode:output.errorCode};
            // The current Agent uses UI accessibility text. Never stuff image base64 into model history.
            if(Array.isArray(result.content))result={...result,content:result.content.filter(item=>item.type==='text').map(item=>({type:'text',text:String(item.text).slice(0,60000)}))};
            if(result.isError)fault=result.content?.map(item=>item.text).join('\n')||'Windows MCP 未执行该操作';
          }catch(reason){fault=reason instanceof Error?reason.message:'本机操作未完成';outcomeUnknown=reason?.outcomeUnknown===true||signal.aborted;}
          pendingReceipt={deviceId,token:key,id:command.id,sessionId:command.sessionId,result,error:fault,outcomeUnknown};
          await post('receipt',pendingReceipt,AbortSignal.any([signal,AbortSignal.timeout(8000)]));
          pendingReceipt=null;activeCommand=null;
        }
        }
        error='';
      }catch(reason){if(signal.aborted)break;error=pendingReceipt?'电脑操作结果等待上传确认，已暂停后续动作。':reason instanceof Error?reason.message:'本机连接中断';}
      await new Promise(resolve=>{const timer=setTimeout(done,600);function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});
    }
  }
  async function connect({rememberChoice=true}={}){
    if(closed)throw Error('本机连接已关闭。');
    if(rememberChoice)remember(true);
    if(connected)return publicStatus();if(connecting){await connecting;return publicStatus();}
    connecting=(async()=>{error='';try{
      controller=new AbortController();const signal=controller.signal,key=token();
      await driver.start({signal});signal.throwIfAborted();const tools=await driver.listTools({signal});signal.throwIfAborted();
      const registration=await post('register',{deviceId,token:key,tools:Array.isArray(tools)?tools:tools.tools},AbortSignal.any([signal,AbortSignal.timeout(8000)]));
      sessionId=registration.sessionId;signal.throwIfAborted();connected=true;running=loop(signal,key).finally(()=>{connected=false;});return publicStatus();
    }catch(reason){error=reason instanceof Error?reason.message:'无法连接本机控制';await driver.stop().catch(()=>{});throw Error(error);}finally{connecting=null;}})();await connecting;return publicStatus();
  }
  async function disconnect({rememberChoice=true}={}){
    if(rememberChoice)remember(false);
    controller?.abort();connected=false;
    await connecting?.catch(()=>{});
    try{if(sessionId)await post('disconnect',{deviceId,token:token()});}catch{}
    await driver.stop().catch(()=>{});await running?.catch(()=>{});sessionId='';return publicStatus();
  }
  return {connect,disconnect,status:publicStatus,
    restore:()=>computerAutoConnect(dataDirectory)?connect({rememberChoice:false}):Promise.resolve(publicStatus()),
    close(){closed=true;return disconnect({rememberChoice:false});},
    authorization:()=>connected?{deviceId,token:token()}:undefined};
}
module.exports={createComputerBridgeHost,computerAutoConnect};
