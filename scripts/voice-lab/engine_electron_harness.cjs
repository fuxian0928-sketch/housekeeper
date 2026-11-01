// Isolated integration entry: actual packaged main/preload, fixture page, no capture.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),Module=require('node:module');
const profile=process.env.VOICE_TEST_PROFILE,application=process.env.VOICE_TEST_APPLICATION;
if(!profile||!application)throw Error('Explicit isolated test paths required');
fs.mkdirSync(profile,{recursive:true});app.setPath('appData',profile);
const personal=path.join(profile,'housekeeper');fs.mkdirSync(personal,{recursive:true});
fs.writeFileSync(path.join(personal,'desktop-companion.json'),JSON.stringify({enabled:false,voiceEnabled:false,mockMode:true,wakeWordEnabled:false}));
process.env.AI_SECRETARY_NATIVE_VOICE_BUNDLE=path.join(application,'resources/native-voice');
delete process.env.AI_SECRETARY_NATIVE_VOICE_CONFIG;
process.env.AI_SECRETARY_REMOTE_URL='http://127.0.0.1:1';delete process.env.AI_SECRETARY_REMOTE_TOKEN;
delete process.env.AI_SECRETARY_CONFIGURE_REMOTE_URL;delete process.env.AI_SECRETARY_CONFIGURE_REMOTE_TOKEN;
const appRoot=path.join(application,'resources/app.asar');app.getAppPath=()=>appRoot;
// Hide only UI presentation; renderer and real preload/IPC remain operational.
// Settings import must never alter the user's real Windows startup entry.
app.setLoginItemSettings=function(){};
BrowserWindow.prototype.show=function(){};
const server=http.createServer((req,res)=>{
 res.setHeader('Content-Type',req.url==='/api/health'?'application/json':'text/html');
 res.end(req.url==='/api/health'?JSON.stringify({version:app.getVersion(),serverConnected:true}):'<!doctype html><html><body>Isolated voice engine IPC test</body></html>');
});
server.listen(0,'127.0.0.1',()=>{
 const port=server.address().port,filename=path.join(appRoot,'electron/main.cjs');
 // Port is the sole source substitution: never discover/reuse the personal bridge.
 const original=fs.readFileSync(filename,'utf8');
 if(original.split('const DEFAULT_APP_PORT = 43120;').length!==2)throw Error('Unknown bridge entry; refusing non-isolated launch');
 const source=original.replace('const DEFAULT_APP_PORT = 43120;',`const DEFAULT_APP_PORT = ${port};`);
 const entry=new Module(filename,module);entry.filename=filename;entry.paths=Module._nodeModulePaths(path.dirname(filename));entry._compile(source,filename);
});
app.on('will-quit',()=>server.close());
