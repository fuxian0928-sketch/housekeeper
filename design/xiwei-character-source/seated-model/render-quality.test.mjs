import test from "node:test";
import assert from "node:assert/strict";
import { chooseRenderSize, PortraitCamera } from "./render-quality.mjs";
test("drawing buffers follow physical screen pixels without treating UV size as screen size", () => {
  assert.deepEqual(chooseRenderSize(400, 600, 2), {
    width: 800,
    height: 1200,
    dpr: 2,
    cssWidth: 400,
    cssHeight: 600,
  });
  const fractional = chooseRenderSize(412.8, 619.2, 1.25);
  assert.equal(fractional.width, 516);
  assert.equal(fractional.height, 774);
  assert.equal(chooseRenderSize(0, 0, 2), null);
});
test("large monitors stay within bounded GPU memory and preserve aspect", () => {
  const size = chooseRenderSize(3000, 4500, 3);
  assert.ok(size.width * size.height <= 3145728);
  assert.ok(Math.max(size.width, size.height) <= 4096);
  assert.ok(Math.abs(size.width / size.height - 2 / 3) < 0.002);
});
test("zoom reverses continuously, settles, and supports motion reduction", () => {
  const camera = new PortraitCamera();
  camera.setZoom(true);
  camera.tick(0);
  const partial = camera.tick(100);
  assert.ok(partial > 1 && partial < 2.4);
  camera.setZoom(false);
  assert.equal(camera.scale, partial);
  camera.tick(200);
  assert.ok(camera.scale < partial && camera.scale > 1);
  camera.pause();
  for (let t = 0; t < 3000; t += 17) camera.tick(t);
  assert.equal(camera.scale, 1);
  assert.equal(camera.active, false);
  camera.setZoom(true, { immediate: true });
  assert.equal(camera.scale, 2.4);
  assert.equal(camera.active, false);
});
