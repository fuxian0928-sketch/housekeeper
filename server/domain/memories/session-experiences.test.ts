import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionExperienceStore } from './session-experiences.js';

test('session experiences retain evidence, isolate scopes and never extend emotion age on reads',()=>{
  let time=Date.parse('2026-09-20T00:00:00Z');const store=new SessionExperienceStore(()=>time,1000);
  const evidence={sourceMessageId:'message',sourceText:'这次汇报我很紧张',observedAt:new Date(time).toISOString(),projectId:'project'};
  const rows=[{eventId:'presentation',content:'用户表示这次汇报紧张',excerpt:'这次汇报我很紧张',explicit:true}];
  const ticket=store.begin('conversation');assert.equal(store.apply(ticket,evidence,rows),true);
  assert.equal(store.apply(ticket,evidence,rows),false);
  assert.deepEqual(store.list('other',['project']),[]);assert.deepEqual(store.list('conversation',[]),[]);
  const selected=store.list('conversation',['project']);assert.equal(selected[0].excerpt,evidence.sourceText);
  selected[0].content='mutated';assert.notEqual(store.list('conversation',['project'])[0].content,'mutated');
  time+=900;store.begin('conversation');assert.equal(store.list('conversation',['project']).length,1);
  time+=101;assert.deepEqual(store.list('conversation',['project']),[]);
});

test('correction, deletion, disable, end and eviction retire pending extraction',()=>{
 const store=new SessionExperienceStore();const evidence={sourceMessageId:'m',sourceText:'现在紧张',observedAt:new Date().toISOString(),projectId:null};
 const rows=[{eventId:'event',content:'这次紧张',excerpt:'现在紧张',explicit:true}];
 for(const retire of [()=>store.begin('c'),()=>store.invalidate('c','event'),()=>store.invalidate('c'),()=>store.setEnabled('c',false),()=>store.end('c')]) {
  store.end('c');const ticket=store.begin('c');retire();assert.equal(store.apply(ticket,evidence,rows),false);
 }
 store.setEnabled('c',false);assert.equal(store.apply(store.begin('c'),evidence,rows),false);
 store.setEnabled('c',true);assert.equal(store.apply(store.begin('c'),evidence,rows),true);
 store.invalidate('c','event');assert.deepEqual(store.list('c',[]),[]);
 store.end('c');const stale=store.begin('c');for(let i=0;i<128;i++)store.begin('other'+i);
 store.begin('c');assert.equal(store.apply(stale,evidence,rows),false);
});

test('inference and unsupported evidence are rejected atomically; event updates replace rather than accumulate',()=>{
 const store=new SessionExperienceStore();const evidence={sourceMessageId:'m',sourceText:'现在不紧张了',observedAt:new Date().toISOString(),projectId:null};
 const good={eventId:'event',content:'用户表示现在不紧张了',excerpt:'不紧张了',explicit:true};
 assert.equal(store.apply(store.begin('c'),evidence,[good,{...good,eventId:'bad',explicit:false}]),false);
 assert.deepEqual(store.list('c',[]),[]);
 assert.equal(store.apply(store.begin('c'),evidence,[{...good,excerpt:'用户很焦虑'}]),false);
 assert.equal(store.apply(store.begin('c'),{...evidence,observedAt:'2099-01-01'},[good]),false);
 assert.equal(store.apply(store.begin('c'),evidence,[good]),true);
 assert.equal(store.apply(store.begin('c'),evidence,[good]),true);assert.equal(store.list('c',[]).length,1);
 for(let i=0;i<40;i++)store.apply(store.begin('c'),evidence,[{...good,eventId:'e'+i}]);
 assert.equal(store.list('c',[]).length,32);
});
