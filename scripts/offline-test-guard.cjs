// Optional test preload: never allow a test to call a paid or personal service.
const {syncBuiltinESMExports}=require('node:module');
const net=require('node:net');
const {mkdtempSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
for(const key of Object.keys(process.env))if(/API_KEY|(?:ACCESS|AUTH|REMOTE)_TOKEN|DEEPSEEK|DASHSCOPE/.test(key))delete process.env[key];
process.env.AI_SECRETARY_REMOTE_URL='';process.env.AI_SECRETARY_REMOTE_TOKEN='';
process.env.AI_SECRETARY_DB_PATH ||= join(mkdtempSync(join(tmpdir(),'housekeeper-offline-')),'isolated.db');
const allowed=new Set(['127.0.0.1','localhost','::1']);
const deniedPorts=new Set([4310,43110,43120,4361]);
const original=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
  const options=Array.isArray(args[0])?args[0][0]:args[0];
  const port=typeof options==='object'?Number(options.port):Number(options);
  const host=typeof options==='object'?(options.host||'localhost'):typeof args[1]==='string'?args[1]:'localhost';
  if(!allowed.has(host)||deniedPorts.has(port))throw Error(`OFFLINE_TEST_NETWORK_BLOCKED: ${host}:${port}`);
  return original.apply(this,args);
};
syncBuiltinESMExports();
