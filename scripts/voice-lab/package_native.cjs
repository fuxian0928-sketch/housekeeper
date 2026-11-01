// Explicit user-edition release entry. Builds locally; publication remains a separate step.
const fs=require('node:fs'),path=require('node:path');
const {run}=require('./package_preview.cjs');
function releaseInputs(env=process.env){
 const bundle=env.AI_SECRETARY_NATIVE_VOICE_BUNDLE;
 if(!bundle)throw Error('Set AI_SECRETARY_NATIVE_VOICE_BUNDLE to a sealed, verified runtime bundle before packaging');
 const root=path.resolve(__dirname,'../..');
 const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
 if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid release version');
 return {bundle:path.resolve(bundle),output:path.join(root,'outputs',`Housekeeper-v${version}`)};
}
module.exports={releaseInputs};
if(require.main===module){
 try{const {bundle,output}=releaseInputs();run(bundle,output,{installer:true}).catch(error=>{console.error(error.message);process.exitCode=1});}
 catch(error){console.error(error.message);process.exitCode=1;}
}
