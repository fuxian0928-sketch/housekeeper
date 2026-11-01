const {randomUUID}=require('node:crypto');
const {isVoiceSettingsSender}=require('./voice-settings-sender.cjs');

// One on-demand snapshot, not a recording or a durable image cache. Renderer
// replies must belong to the actual companion top frame and the pending nonce.
function createCameraFrameBridge({ipcMain,window:readWindow,enabled,port,timeoutMs=4000}){
  let active=null;
  const receive=(event,value)=>{
    const pending=active;
    if(!pending||!isVoiceSettingsSender(event,pending.window,port())||value?.id!==pending.id)return;
    const frame=value.frame;
    pending.finish(typeof frame==='string'&&frame.length<=2_000_000&&/^data:image\/(?:jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(frame)?frame:null);
  };
  ipcMain.on('companion:camera-frame',receive);
  return {
    capture(signal){
      if(signal?.aborted||!enabled())return Promise.resolve(null);
      if(active)return Promise.resolve(null);
      const win=readWindow();if(!win||win.isDestroyed?.())return Promise.resolve(null);
      return new Promise(resolve=>{
        const id=randomUUID();let settled=false;
        const finish=frame=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);win.webContents.removeListener?.('did-finish-load',send);active=null;try{win.webContents.send('companion:capture-camera',{id,cancel:true});}catch{}resolve(frame);};
        const abort=()=>finish(null);
        const timer=setTimeout(()=>finish(null),timeoutMs);
        const send=()=>{if(!settled){try{win.webContents.send('companion:capture-camera',{id,cancel:false});}catch{finish(null);}}};
        active={id,window:win,finish};signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted){finish(null);return;}
        if(win.webContents.isLoadingMainFrame?.())win.webContents.once('did-finish-load',send);else send();
      });
    },
    close(){active?.finish(null);ipcMain.removeListener('companion:camera-frame',receive);}
  };
}
module.exports={createCameraFrameBridge};
