const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
function oval(u, v, x, y, rx, ry) {
  return 1 - smooth(0.5, 1, Math.hypot((u - x) / rx, (v - y) / ry));
}
export function validateRig(model) {
  if (model?.schema !== "xiwei-artmesh-1")
    throw new Error("无法识别二维模型格式。");
  if (
    !Array.isArray(model.canvas) ||
    model.canvas.length !== 2 ||
    !model.canvas.every((v) => Number.isInteger(v) && v >= 128 && v <= 4096)
  )
    throw new Error("模型画布尺寸无效。");
  if (
    !Array.isArray(model.grid) ||
    model.grid.length !== 2 ||
    !model.grid.every((v) => Number.isInteger(v) && v >= 8 && v <= 128) ||
    (model.grid[0] + 1) * (model.grid[1] + 1) > 65535
  )
    throw new Error("模型网格尺寸无效。");
  for (const key of [
    "character",
    "closedEyes",
    "openMouth",
    "uniform",
    "background",
    "source",
  ])
    if (!/^[a-z0-9][a-z0-9.-]*\.png$/i.test(model.textures?.[key] ?? ""))
      throw new Error("模型纹理路径无效。");
  for (const key of ["leftEye", "rightEye", "mouth", "uniform"]) {
    const r = model.regions?.[key];
    if (
      !r ||
      ![r.x, r.y, r.w, r.h].every(Number.isFinite) ||
      r.x < 0 ||
      r.y < 0 ||
      r.w <= 0 ||
      r.h <= 0 ||
      r.x + r.w > model.canvas[0] ||
      r.y + r.h > model.canvas[1]
    )
      throw new Error("模型面部区域无效。");
  }
  const hands = model.pinned?.hands;
  if (
    !Array.isArray(hands) ||
    hands.length !== 4 ||
    !hands.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
    hands[0] >= hands[2] ||
    hands[1] >= hands[3] ||
    !Number.isFinite(model.pinned.lowerBodyStartsAt) ||
    model.pinned.lowerBodyStartsAt <= hands[3] ||
    model.pinned.lowerBodyStartsAt > 1
  )
    throw new Error("模型固定区域无效。");
  return model;
}
export function weightsAt(model, u, v) {
  const [left, top, right, bottom] = model.pinned.hands;
  if (
    v >= model.pinned.lowerBodyStartsAt ||
    (u >= left && u <= right && v >= top && v <= bottom)
  )
    return [0, 0, 0];
  const head =
    (1 - smooth(0.17, 0.225, v)) *
    smooth(0.29, 0.4, u) *
    (1 - smooth(0.61, 0.72, u));
  const chest =
    oval(u, v, 0.5, 0.285, 0.19, 0.12) * (1 - smooth(0.35, 0.385, v));
  const hair = Math.max(
    oval(u, v, 0.28, 0.35, 0.16, 0.225),
    oval(u, v, 0.72, 0.35, 0.16, 0.225),
    oval(u, v, 0.5, 0.082, 0.14, 0.065) * 0.17,
  );
  return [head, chest, hair * smooth(0.04, 0.28, v)];
}
export function createMesh(model) {
  validateRig(model);
  const [cols, rows] = model.grid,
    count = (cols + 1) * (rows + 1);
  const uv = new Float32Array(count * 2),
    weights = new Float32Array(count * 3),
    indices = new Uint16Array(cols * rows * 6);
  for (let y = 0; y <= rows; y++)
    for (let x = 0; x <= cols; x++) {
      const i = y * (cols + 1) + x,
        u = x / cols,
        v = y / rows;
      uv.set([u, v], i * 2);
      weights.set(weightsAt(model, u, v), i * 3);
    }
  let p = 0;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const i = y * (cols + 1) + x;
      indices.set(
        [i, i + 1, i + cols + 1, i + 1, i + cols + 2, i + cols + 1],
        p,
      );
      p += 6;
    }
  return { uv, weights, indices, positions: new Float32Array(count * 2) };
}
export function deformMesh(model, mesh, parameters = {}, time = 0) {
  const finite = (v) => (Number.isFinite(v) ? v : 0);
  const headX = clamp(finite(parameters.headX), -1, 1),
    angle = clamp(finite(parameters.headRoll), -1, 1) * 0.006;
  const breath = clamp(finite(parameters.breath)),
    hair = clamp(finite(parameters.hairSway));
  const [W, H] = model.canvas,
    clock = finite(time),
    c = Math.cos(angle),
    s = Math.sin(angle);
  for (let i = 0; i < mesh.uv.length / 2; i++) {
    const u = mesh.uv[i * 2],
      v = mesh.uv[i * 2 + 1],
      h = mesh.weights[i * 3],
      b = mesh.weights[i * 3 + 1],
      a = mesh.weights[i * 3 + 2];
    const px = (u - 0.5) * W,
      py = (v - 0.195) * H;
    const dx =
      (c * px - s * py - px + headX * 2.8) * h +
      (u - 0.5) * W * breath * 0.002 * b +
      hair *
        a *
        (1.5 * Math.sin(clock * 0.76 + v * 3.7) +
          0.35 * Math.sin(clock * 1.23 + u));
    const dy =
      (s * px + c * py - py) * h -
      breath * 0.35 * b +
      hair * a * 0.25 * Math.sin(clock * 0.61 + u * 3);
    mesh.positions[i * 2] = (u + dx / W) * 2 - 1;
    mesh.positions[i * 2 + 1] = 1 - (v + dy / H) * 2;
  }
  return mesh.positions;
}
