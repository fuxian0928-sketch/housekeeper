import test from "node:test";
import assert from "node:assert/strict";
import { HeadState, rms } from "./head-state.mjs";
import { AmbientMotion } from "./layered-renderer.mjs";

test("late audio start cannot wake a sleeping character", () => {
  const state = new HeadState();
  const token = state.preparePlayback();
  state.sleep(100);
  assert.equal(state.playbackStarted(token), false);
  state.tick(500, 0.3);
  assert.equal(state.phase, "asleep");
  assert.equal(state.eye, 1);
  assert.equal(state.mouth, 0);
});
test("cancelled audio completion cannot erase a newer reply", () => {
  const state = new HeadState();
  const old = state.preparePlayback();
  const current = state.preparePlayback();
  state.playbackStarted(current);
  assert.equal(state.playbackEnded(old), false);
  assert.equal(state.phase, "speaking");
});
test("sleep interrupts a blink and cannot be reopened by its deadline", () => {
  const state = new HeadState();
  state.blink(0);
  state.tick(70);
  state.sleep(80);
  state.tick(1000);
  assert.equal(state.eye, 1);
  assert.equal(state.blinkStart, null);
});
test("rapid wake and sleep continue from current eyelid position", () => {
  const state = new HeadState();
  state.sleep(0);
  state.tick(150);
  const eye = state.eye;
  state.wake(150);
  state.tick(150);
  assert.equal(state.eye, eye);
  state.tick(220);
  state.sleep(220);
  state.tick(1000);
  assert.equal(state.eye, 1);
});
test("repeated blink requests do not restart the same blink", () => {
  const state = new HeadState();
  assert.equal(state.blink(0), true);
  state.tick(90);
  assert.equal(state.blink(100), false);
  assert.equal(state.blinkStart, 0);
  state.tick(225);
  assert.equal(state.eye, 0);
});
test("pause and end close the mouth immediately", () => {
  const state = new HeadState();
  const token = state.preparePlayback();
  state.playbackStarted(token);
  state.tick(0, 0.15);
  state.tick(100, 0.15);
  assert.ok(state.mouth > 0.6);
  state.cancelPlayback();
  assert.equal(state.mouth, 0);
  assert.equal(state.phase, "idle");
});
test("silence keeps the mouth closed and speaking follows actual energy", () => {
  const state = new HeadState();
  const token = state.preparePlayback();
  state.playbackStarted(token);
  for (let t = 0; t < 300; t += 16) state.tick(t, 0);
  assert.equal(state.mouth, 0);
  for (let t = 300; t < 600; t += 16) state.tick(t, 0.1);
  assert.ok(state.mouth > 0.8);
  for (let t = 600; t < 1400; t += 16) state.tick(t, 0);
  assert.equal(state.mouth, 0);
});
test("neutral audio samples have zero energy; invalid manual values stay bounded", () => {
  assert.equal(rms(new Uint8Array(128).fill(128)), 0);
  const state = new HeadState();
  state.setManual(Number.NaN);
  assert.equal(state.mouth, 0);
  state.setManual(9);
  assert.equal(state.mouth, 1);
  state.sleep(0);
  state.setManual(0.5);
  assert.equal(state.mouth, 0);
});
test("hidden-tab time does not fast-forward ambient motion", () => {
  const motion = new AmbientMotion();
  motion.tick(0);
  motion.tick(100);
  const before = motion.time;
  motion.pause();
  motion.tick(100000);
  assert.equal(motion.time, before);
});
test("sleep damps motion without a pose discontinuity", () => {
  const motion = new AmbientMotion();
  for (let t = 0; t < 2000; t += 16) motion.tick(t);
  const before = motion.body;
  motion.tick(1990, { asleep: true });
  assert.ok(motion.body < before && motion.body > 0.8);
  for (let t = 2000; t < 5000; t += 16) motion.tick(t, { asleep: true });
  assert.equal(motion.body, 0.1);
  assert.equal(motion.hair, 0.12);
});
test("reduced motion switches off ambient movement immediately", () => {
  const motion = new AmbientMotion();
  motion.tick(0);
  motion.tick(100);
  motion.tick(116, { reduced: true });
  assert.equal(motion.body, 0);
  assert.equal(motion.hair, 0);
  assert.equal(motion.active, false);
});
