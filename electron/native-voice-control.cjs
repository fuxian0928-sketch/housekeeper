const {isVoiceSettingsSender}=require('./voice-settings-sender.cjs');
const actions=new Set(['wake','dismiss','preview']);

function createNativeVoiceControlHandler({windows,port,host}) {
  return (event,action)=>{
    const trusted=windows().some(window=>window&&
      !(typeof window.isDestroyed==='function'&&window.isDestroyed())&&
      isVoiceSettingsSender(event,window,port()));
    if(!trusted)throw Error('VOICE_CONTROL_NOT_ALLOWED');
    if(!actions.has(action))throw Error('VOICE_CONTROL_INVALID');
    return host()?.control(action)??false;
  };
}
module.exports={createNativeVoiceControlHandler};
