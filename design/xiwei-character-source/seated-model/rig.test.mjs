import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMesh, deformMesh, weightsAt, validateRig } from "./rig.mjs";
const model = JSON.parse(
  await readFile(new URL("./model.json", import.meta.url), "utf8"),
);
test("hand contact and crossed legs stay pinned under maximal head, breath and hair controls", () => {
  const mesh = createMesh(model);
  deformMesh(
    model,
    mesh,
    { headX: 1, headRoll: 1, breath: 1, hairSway: 1 },
    10,
  );
  let pinned = 0,
    moved = 0;
  for (let i = 0; i < mesh.uv.length / 2; i++) {
    const u = mesh.uv[i * 2],
      v = mesh.uv[i * 2 + 1],
      weight = weightsAt(model, u, v),
      dx = mesh.positions[i * 2] - (u * 2 - 1),
      dy = mesh.positions[i * 2 + 1] - (1 - v * 2);
    if (
      v >= model.pinned.lowerBodyStartsAt ||
      (u >= 0.44 && u <= 0.64 && v >= 0.37 && v <= 0.445)
    ) {
      pinned++;
      assert.deepEqual(weight, [0, 0, 0]);
      assert.ok(Math.abs(dx) < 1e-7 && Math.abs(dy) < 1e-7);
    } else if (Math.abs(dx) + Math.abs(dy) > 0.0001) moved++;
  }
  assert.ok(pinned > 2000);
  assert.ok(moved > 50);
});
test("zero and invalid parameters produce a finite stationary mesh", () => {
  const mesh = createMesh(model);
  deformMesh(model, mesh, { headX: NaN, headRoll: Infinity }, NaN);
  for (let i = 0; i < mesh.uv.length / 2; i++) {
    assert.ok(
      Math.abs(mesh.positions[i * 2] - (mesh.uv[i * 2] * 2 - 1)) < 1e-7,
    );
    assert.ok(
      Math.abs(mesh.positions[i * 2 + 1] - (1 - mesh.uv[i * 2 + 1] * 2)) < 1e-7,
    );
  }
});
test("indices remain within the declared mesh and invalid rigs fail before GPU allocation", () => {
  const mesh = createMesh(model);
  assert.ok(mesh.indices.every((i) => i < mesh.uv.length / 2));
  for (const change of [
    { grid: [256, 256] },
    { canvas: [0, 1536] },
    { textures: { ...model.textures, character: "../../secret.png" } },
    { pinned: { ...model.pinned, hands: [0.6, 0.2, 0.4, 0.3] } },
  ])
    assert.throws(() => validateRig({ ...model, ...change }));
});
