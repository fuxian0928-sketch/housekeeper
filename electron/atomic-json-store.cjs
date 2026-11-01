const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
// Same-directory replace: readers see the previous or complete next JSON file.
function saveJsonAtomically(file,value,io=fs){
 const temporary=file+'.'+randomUUID()+'.tmp';let descriptor,created=false;
 try{
  const data=JSON.stringify(value,null,2);
  if(typeof data!=='string')throw Error();
  io.mkdirSync(path.dirname(file),{recursive:true});
  descriptor=io.openSync(temporary,'wx',0o600);created=true;
  io.writeFileSync(descriptor,data,'utf8');io.fsyncSync(descriptor);io.closeSync(descriptor);descriptor=undefined;
  io.renameSync(temporary,file);created=false;
 }catch{
  if(descriptor!==undefined)try{io.closeSync(descriptor)}catch{}
  if(created)try{io.unlinkSync(temporary)}catch{}
  throw Error('设置未能完整保存，原配置已保留，请检查磁盘空间或文件占用后重试。');
 }
}
module.exports={saveJsonAtomically};
