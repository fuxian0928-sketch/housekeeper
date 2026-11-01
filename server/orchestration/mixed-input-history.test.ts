import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

test('real chat API keeps voice, typed clarification and automatic project switch in one conversation',()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const output=execFileSync(process.execPath,[join(root,'node_modules/tsx/dist/cli.mjs'),fileURLToPath(new URL('./mixed-input-history.fixture.mjs',import.meta.url))],{cwd:root,encoding:'utf8',timeout:45000,windowsHide:true});
  assert.match(output,/REAL_API_REGRESSION_OK/);
  assert.match(output,/"clarificationHistoryRetained":true/);
  assert.match(output,/"automaticProjectSwitch":true/);
  assert.match(output,/"explicitScopeStillChecked":true/);
});
