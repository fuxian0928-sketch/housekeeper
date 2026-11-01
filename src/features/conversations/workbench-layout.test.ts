import assert from 'node:assert/strict';
import test from 'node:test';
import {clampPaneWidth,DEFAULT_PANE_WIDTH,readPaneWidth} from './workbench-layout';

test('pane width leaves both conversation and detail usable after resizing',()=>{
  for(const container of [760,960,1280,1920])for(const desired of [-100,0,300,520,5000,NaN,Infinity]){
    const width=clampPaneWidth(desired,container);assert.ok(width>=300);assert.ok(width<=container-370);assert.ok(Number.isInteger(width));
  }
});
test('unavailable or invalid saved widths fall back without blocking the workbench',()=>{
  for(const value of [null,'','bad','NaN','Infinity','0','-500','999999'])assert.equal(readPaneWidth({getItem:()=>value}),DEFAULT_PANE_WIDTH);
  assert.equal(readPaneWidth({getItem:()=>{throw Error('disabled storage');}}),DEFAULT_PANE_WIDTH);
  assert.equal(readPaneWidth({getItem:()=> '640'}),640);
});
