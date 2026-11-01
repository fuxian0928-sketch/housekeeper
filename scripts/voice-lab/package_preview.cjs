const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const {verifyNativeVoiceBundle}=require('../../electron/native-voice-bundle.cjs');
const root=path.resolve(__dirname,'../..');
function previewConfig(bundle,output){
 const source=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).build;
 return {...source,publish:null,directories:{...source.directories,output},extraResources:[...source.extraResources.filter(item=>item.to!=='native-voice/scripts/voice-lab'),{from:bundle,to:'native-voice',filter:['**/*']} ]};
}
function verifySourceResources(bundle){
 const manifest=JSON.parse(fs.readFileSync(path.join(bundle,'bundle.json'),'utf8'));
 const source=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).build.extraResources.find(item=>item.to==='native-voice/scripts/voice-lab');
 if(!source || !Array.isArray(source.filter))throw Error('Missing voice resource source list');
 const wanted=[...source.filter.map(name=>['scripts/voice-lab/'+name,path.join(root,source.from,name)]),['keywords.txt',path.join(root,'scripts/voice-lab/xiao-e-keywords.txt')]];
 for(const [name,file] of wanted){
   const row=manifest.files.find(item=>item.path===name);
   const hash=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
   if(!row || row.sha256!==hash)throw Error('Voice bundle differs from current source: '+name);
 }
}
async function run(bundle,output,{installer=false}={}){
 bundle=path.resolve(bundle);output=path.resolve(output);
 const relative=path.relative(path.join(root,'outputs'),output);
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||fs.existsSync(output))throw Error('Use a new preview directory inside outputs');
 const before=await verifyNativeVoiceBundle(bundle);
 if(installer)verifySourceResources(bundle);
 const manifest=fs.readFileSync(path.join(bundle,'bundle.json'));
 const config=output+'.builder.json';fs.mkdirSync(path.dirname(output),{recursive:true});
 fs.writeFileSync(config,JSON.stringify(previewConfig(bundle,output),null,2));
 await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(root,'node_modules/electron-builder/cli.js'),'--win','--x64',...(installer?[]:['--dir']),'--publish','never','--config',config],{cwd:root,windowsHide:true,stdio:'inherit'});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Preview build failed')));
 });
 const copied=path.join(output,'win-unpacked/resources/native-voice');
 const after=await verifyNativeVoiceBundle(copied);
 if(installer)verifySourceResources(copied);
 if(!manifest.equals(fs.readFileSync(path.join(copied,'bundle.json')))||!manifest.equals(fs.readFileSync(path.join(bundle,'bundle.json'))))throw Error('Bundle changed during packaging');
 let artifact;
 if(installer){
   const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
   const filename=`Housekeeper-Setup-${version}.exe`,file=path.join(output,filename);
   const stat=fs.statSync(file);if(!stat.isFile()||stat.size<1024)throw Error('Installer artifact missing');
   const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);
   artifact={filename,bytes:stat.size,sha256:hash.digest('hex')};
 }
 const report={schema:1,...(artifact?{artifact}:{}),kind:installer?'user-installer':'local-unpacked-preview',voiceResourceFiles:after.files,sourceFiles:before.files,published:false,installed:false,releaseApproved:false};
 fs.writeFileSync(path.join(output,'voice-preview-verification.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}
module.exports={previewConfig,verifySourceResources,run};
if(require.main===module){if(process.argv.length!==4)throw Error('Usage: node package_preview.cjs <bundle> <new outputs directory>');run(process.argv[2],process.argv[3]).catch(error=>{console.error(error.message);process.exitCode=1})}
