const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {exportPreferences,parsePreferences,snapshotPreferences,preferenceLabels}=require('./voice-preference-transfer.cjs');
function createVoicePreferenceHistory(directory){
 const file=path.join(directory,'voice-preference-history.json');
 function read(){
  if(!fs.existsSync(file))return [];
  try{
   if(fs.statSync(file).size>200000)throw Error();
   const data=JSON.parse(fs.readFileSync(file,'utf8'));
   if(data.version!==1||!Array.isArray(data.entries)||data.entries.length>10)throw Error();
   const ids=new Set();
   for(const item of data.entries){if(!item||typeof item.id!=='string'||!/^[-a-f0-9]{36}$/.test(item.id)||ids.has(item.id)||typeof item.savedAt!=='string'||!Number.isFinite(Date.parse(item.savedAt)))throw Error();ids.add(item.id);parsePreferences(item.document);if(item.adjustedFields!==undefined&&(!Array.isArray(item.adjustedFields)||item.adjustedFields.length>Object.keys(preferenceLabels).length||new Set(item.adjustedFields).size!==item.adjustedFields.length||item.adjustedFields.some(field=>typeof field!=='string'||!Object.hasOwn(preferenceLabels,field))))throw Error();}
   return data.entries;
  }catch{throw Error('语音偏好历史无法读取，请先备份并检查本机配置文件。');}
 }
 return {
  list(){return read().map(({id,savedAt,adjustedFields=[]})=>({id,savedAt,adjustedLabels:adjustedFields.map(field=>preferenceLabels[field])}));},
  get(id){const item=read().find(entry=>entry.id===id);if(!item)throw Error('该偏好版本已不可用，请刷新历史列表。');return item.document;},
  beforeSave(previous,next){
   const nextDocument=exportPreferences(next);
   const {document,adjustedFields}=snapshotPreferences(previous);
   if(document===nextDocument&&!adjustedFields.length)return;
   const entries=read();
   if(entries[0]?.document===document&&JSON.stringify(entries[0].adjustedFields??[])===JSON.stringify(adjustedFields))return;
   entries.unshift({id:randomUUID(),savedAt:new Date().toISOString(),document,adjustedFields});
   const pending=file+'.tmp';
   try{fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(pending,JSON.stringify({version:1,entries:entries.slice(0,10)}),{encoding:'utf8',mode:0o600});fs.renameSync(pending,file);}
   catch{try{fs.unlinkSync(pending)}catch{}throw Error('旧语音偏好未能备份，本次设置尚未保存。');}
  }
 };
}
module.exports={createVoicePreferenceHistory};
