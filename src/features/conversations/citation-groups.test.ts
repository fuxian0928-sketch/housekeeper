import assert from 'node:assert/strict';
import {test} from 'node:test';
import {externalCitationUrl, groupCitations} from './citation-groups.js';
import type {ChatCitation} from '../../types';
const source: ChatCitation = {document:'项目进展',path:'项目/进展.md',excerpt:'# 项目进展\n\n本周完成评审。',documentId:'one',parentId:'p1',sourceRevision:'r1',locator:{startLine:3,endLine:4}};
test('four fragments of the same document become one source without losing evidence',()=>{
  const input=[source,...[2,3,4].map(index=>({...source,parentId:`p${index}`,excerpt:`第 ${index} 处依据`,locator:{startLine:index*3,endLine:index*3+1}}))];
  const groups=groupCitations(input);
  assert.equal(groups.length,1);assert.equal(groups[0].items.length,4);assert.equal(groups[0].excerpt,'本周完成评审。');
});
test('matching titles do not merge different documents',()=>{
  assert.equal(groupCitations([source,{...source,documentId:'two'}]).length,2);
});
test('source revisions and historical versions remain separate',()=>{
  assert.equal(groupCitations([source,{...source,sourceRevision:'r2'},{...source,version:2}]).length,3);
});
test('identical evidence is shown once while different locations are retained',()=>{
  const groups=groupCitations([source,{...source},{...source,parentId:'p2',locator:{startLine:9,endLine:10}}]);
  assert.equal(groups[0].items.length,2);
});
test('legacy records retain all excerpts without inventing document IDs',()=>{
  const groups=groupCitations([{document:'旧资料',path:'旧资料.md',excerpt:'第一处'},{document:'旧资料',path:'旧资料.md',excerpt:'第二处'}]);
  assert.equal(groups.length,1);assert.equal(groups[0].kind,'evidence');assert.equal(groups[0].items.length,2);assert.equal(groups[0].items[0].documentId,undefined);
});
test('only HTTP and HTTPS are external navigation targets',()=>{
  assert.equal(externalCitationUrl('https://example.com/a'),'https://example.com/a');
  for(const path of ['javascript:alert(1)','data:text/html,test','file:///private.md','self://query','C:/private/file.md','相对路径.md'])assert.equal(externalCitationUrl(path),null);
});
