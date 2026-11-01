import assert from 'node:assert/strict';
import {test} from 'node:test';
import {documentTabId, emptyWorkbenchTabs, workbenchTabsReducer as reduce, type WorkbenchTab} from './workbench-tabs.js';

const chat: WorkbenchTab = {id: 'transcript', kind: 'transcript', title: '聊天记录'};
const settings: WorkbenchTab = {id: 'page:settings', kind: 'page', page: 'settings', title: '设置'};
const document: WorkbenchTab = {id: documentTabId('one'), kind: 'document', documentId: 'one', title: '项目进展'};
test('reopening a document reuses the tab and retains its resolved title', () => {
  let state = reduce(emptyWorkbenchTabs, {type: 'open', tab: document});
  state = reduce(state, {type: 'open', tab: settings});
  state = reduce(state, {type: 'open', tab: {...document, title: '文档原文'}});
  assert.equal(state.tabs.length, 2); assert.equal(state.activeId, document.id); assert.equal(state.tabs[0].title, '项目进展');
});
test('background results notify without interrupting settings', () => {
  let state = reduce(emptyWorkbenchTabs, {type: 'open', tab: settings});
  state = reduce(state, {type: 'open', tab: {id: 'results', kind: 'results', title: '成果与进展', attention: true}, background: true});
  assert.equal(state.activeId, settings.id); assert.equal(state.tabs[1].attention, true);
  state = reduce(state, {type: 'select', id: 'results'});
  assert.equal(state.tabs[1].attention, false);
});
test('closing the active tab returns to the most recently viewed page', () => {
  let state = reduce(emptyWorkbenchTabs, {type: 'open', tab: chat});
  state = reduce(state, {type: 'open', tab: settings});
  state = reduce(state, {type: 'open', tab: document});
  state = reduce(state, {type: 'select', id: chat.id});
  state = reduce(state, {type: 'select', id: document.id});
  state = reduce(state, {type: 'close', id: document.id});
  assert.equal(state.activeId, chat.id); assert.equal(state.tabs.length, 2);
});
test('closing a background tab keeps the active page', () => {
  let state = reduce(emptyWorkbenchTabs, {type: 'open', tab: chat});
  state = reduce(state, {type: 'open', tab: settings});
  state = reduce(state, {type: 'close', id: chat.id});
  assert.equal(state.activeId, settings.id);
});
test('collapsing the pane retains tabs and closing a hidden tab does not reopen it', () => {
  let state = reduce(emptyWorkbenchTabs, {type: 'open', tab: chat});
  state = reduce(state, {type: 'open', tab: settings});
  state = reduce(state, {type: 'hide'});
  assert.equal(state.tabs.length, 2); assert.equal(state.activeId, null);
  state = reduce(state, {type: 'close', id: settings.id});
  assert.equal(state.activeId, null); assert.equal(state.tabs[0].id, chat.id);
});
test('document identities distinguish versions, evidence and source revisions', () => {
  const values = [documentTabId('doc'), documentTabId('doc', 1), documentTabId('doc', 2), documentTabId('doc', undefined, {parentId: 'p', sourceRevision: 'a'}), documentTabId('doc', undefined, {parentId: 'p', sourceRevision: 'b'})];
  assert.equal(new Set(values).size, values.length);
});
test('the continuous chat stays a single tab across repeated opens', () => {
  let state = emptyWorkbenchTabs;
  for (let i = 0; i < 5; i++) state = reduce(state, {type: 'open', tab: chat});
  assert.equal(state.tabs.length, 1);
  state = reduce(state, {type: 'close', id: chat.id});
  assert.equal(state.activeId, null); assert.equal(state.tabs.length, 0);
});
test('closing an unknown tab and selecting a missing tab are harmless', () => {
  const state = reduce(emptyWorkbenchTabs, {type: 'open', tab: chat});
  assert.equal(reduce(state, {type: 'close', id: 'missing'}), state);
  assert.equal(reduce(state, {type: 'select', id: 'missing'}), state);
});
