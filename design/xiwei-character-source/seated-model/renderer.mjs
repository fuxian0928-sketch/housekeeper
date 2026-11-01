import { createMesh, deformMesh, validateRig } from "./rig.mjs";
import { chooseRenderSize, PortraitCamera } from "./render-quality.mjs";
const VERTEX = `attribute vec2 position;attribute vec2 texcoord;varying vec2 uv;uniform float viewScale,aspectScale;void main(){uv=texcoord;vec2 pivot=vec2(0.,.93);vec2 p=(position-pivot)*viewScale+pivot;p.x*=aspectScale;gl_Position=vec4(p,0.,1.);}`;
const FRAGMENT = `precision highp float;varying vec2 uv;uniform sampler2D character,closedEyes,openMouth,originalArt,uniformArt;uniform float eye,mouth;uniform vec4 leftEye,rightEye,mouthRegion,uniformRegion;uniform vec2 textureSize;
// Feather outside the feature, leaving the entire eyelid/lash area fully covered.
float patch(vec2 p,vec4 r){vec2 d=abs((p-r.xy)*textureSize)-r.zw*textureSize+4.;return 1.-smoothstep(0.,4.,max(d.x,d.y));}
vec4 sampleCharacter(vec2 p){
 vec2 pixel=p*textureSize-.5, f=fract(pixel), base=floor(pixel)+.5;
 vec2 f2=f*f,f3=f2*f;
 vec2 w0=-.5*f+f2-.5*f3,w1=vec2(1.)-2.5*f2+1.5*f3,w2=.5*f+2.*f2-1.5*f3,w3=-.5*f2+.5*f3;
 vec2 w12=w1+w2, p0=(base-1.)/textureSize,p12=(base+w2/w12)/textureSize,p3=(base+2.)/textureSize;
 return texture2D(character,vec2(p0.x,p0.y))*w0.x*w0.y+texture2D(character,vec2(p12.x,p0.y))*w12.x*w0.y+texture2D(character,vec2(p3.x,p0.y))*w3.x*w0.y
 +texture2D(character,vec2(p0.x,p12.y))*w0.x*w12.y+texture2D(character,vec2(p12.x,p12.y))*w12.x*w12.y+texture2D(character,vec2(p3.x,p12.y))*w3.x*w12.y
 +texture2D(character,vec2(p0.x,p3.y))*w0.x*w3.y+texture2D(character,vec2(p12.x,p3.y))*w12.x*w3.y+texture2D(character,vec2(p3.x,p3.y))*w3.x*w3.y;
}
void main(){vec4 art=sampleCharacter(uv);float alpha=clamp(art.a,0.,1.);vec3 color=clamp(art.rgb/max(art.a,.00001),0.,1.);
// Keep the approved seated RGB; the cutout provides alpha and fine transparent edges.
color=mix(color,texture2D(originalArt,uv).rgb,smoothstep(.85,.98,alpha));
// Only the uniform panel takes the retouched texture; identity and expression sources stay original.
vec2 garmentDistance=abs((uv-uniformRegion.xy)*textureSize)-uniformRegion.zw*textureSize+18.;
float garmentMask=1.-smoothstep(0.,18.,max(garmentDistance.x,garmentDistance.y));
color=mix(color,texture2D(uniformArt,uv).rgb,garmentMask*smoothstep(.85,.98,alpha));
float eyes=max(patch(uv,leftEye),patch(uv,rightEye));float lips=patch(uv,mouthRegion);
if(lips>0.){vec3 closed=texture2D(closedEyes,uv).rgb;vec3 opened=texture2D(openMouth,uv).rgb;color=mix(color,mix(closed,opened,smoothstep(.05,.85,mouth)),lips);}
if(eyes*eye>0.)color=mix(color,texture2D(closedEyes,uv).rgb,eyes*eye);
gl_FragColor=vec4(color,alpha);}`;
function compile(gl, type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error("坐姿模型着色器未能编译。");
  return s;
}
export class SeatedModelRenderer {
  constructor(canvas, images, model) {
    this.model = validateRig(model);
    this.mesh = createMesh(model);
    this.kind = "xiwei-artmesh-seated";
    this.canvas = canvas;
    this.camera = new PortraitCamera();
    this.disposed = false;
    this.details = {
      label: model.label,
      source: model.id,
      format: model.schema,
      cubismBound: false,
      vertices: this.mesh.uv.length / 2,
      triangles: this.mesh.indices.length / 3,
      textureFilter: "premultiplied Catmull-Rom",
      camera: "GPU redraw",
      facialSource: model.textures.source,
      uniformSource: model.textures.uniform,
    };
    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("本机未能开启二维模型渲染，请检查硬件加速。");
    this.gl = gl;
    this.maxSide = Math.min(4096, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    const program = gl.createProgram();
    this.program = program;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error("坐姿模型渲染程序未能连接。");
    gl.useProgram(program);
    this.positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.positions, gl.DYNAMIC_DRAW);
    const pos = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    const uvBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.uv, gl.STATIC_DRAW);
    const uv = gl.getAttribLocation(program, "texcoord");
    gl.enableVertexAttribArray(uv);
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 0, 0);
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.indices, gl.STATIC_DRAW);
    this.resources = [this.positionBuffer, uvBuffer, indexBuffer];
    this.textures = [];
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const textureKeys = [
      "character",
      "closedEyes",
      "openMouth",
      "originalArt",
      "uniformArt",
    ];
    for (const [index, key] of textureKeys.entries()) {
      const texture = gl.createTexture();
      this.textures.push(texture);
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, key === "character");
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        images[key],
      );
      gl.uniform1i(gl.getUniformLocation(program, key), index);
    }
    for (const key of ["leftEye", "rightEye", "mouth", "uniform"]) {
      const r = model.regions[key],
        [W, H] = model.canvas;
      gl.uniform4f(
        gl.getUniformLocation(program, key === "mouth" ? "mouthRegion" : key === "uniform" ? "uniformRegion" : key),
        (r.x + r.w / 2) / W,
        (r.y + r.h / 2) / H,
        r.w / 2 / W,
        r.h / 2 / H,
      );
    }
    this.eye = gl.getUniformLocation(program, "eye");
    this.mouth = gl.getUniformLocation(program, "mouth");
    this.viewScale = gl.getUniformLocation(program, "viewScale");
    this.aspectScale = gl.getUniformLocation(program, "aspectScale");
    gl.uniform2f(
      gl.getUniformLocation(program, "textureSize"),
      ...model.canvas,
    );
    gl.clearColor(0, 0, 0, 0);
    this.lastParameters = {};
    this.resize = () => {
      if (this.disposed) return;
      const rect = canvas.getBoundingClientRect(),
        size = chooseRenderSize(
          rect.width,
          rect.height,
          window.devicePixelRatio,
          { maxSide: this.maxSide },
        );
      if (!size) return;
      this.resolution = size;
      if (canvas.width !== size.width || canvas.height !== size.height) {
        canvas.width = size.width;
        canvas.height = size.height;
        if (this.lastFrame) this.draw(...this.lastFrame);
      }
    };
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(canvas);
    window.addEventListener("resize", this.resize);
    this.resize();
  }
  draw({ eye, mouth }, { time, body, hair }) {
    if (this.disposed) return;
    this.lastFrame = [
      { eye, mouth },
      { time, body, hair },
    ];
    const gl = this.gl;
    if (this.resolution?.dpr !== window.devicePixelRatio) this.resize();
    gl.useProgram(this.program);
    this.lastParameters = {
      headX: Math.sin(time * 0.47) * 0.35 * body,
      headRoll: Math.sin(time * 0.33) * 0.32 * body,
      breath: (Math.sin(time * 0.82) + 1) * 0.5 * body,
      hairSway: hair,
      eyeClose: eye,
      mouthOpen: mouth,
    };
    deformMesh(this.model, this.mesh, this.lastParameters, time);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.mesh.positions);
    gl.uniform1f(this.eye, eye);
    gl.uniform1f(this.mouth, mouth);
    gl.uniform1f(this.viewScale, this.camera.tick(performance.now()));
    gl.uniform1f(this.aspectScale, (this.model.canvas[0] / this.model.canvas[1]) / (this.canvas.width / this.canvas.height));
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawElements(
      gl.TRIANGLES,
      this.mesh.indices.length,
      gl.UNSIGNED_SHORT,
      0,
    );
  }
  state() {
    return {
      ...this.lastParameters,
      ...this.details,
      viewScale: this.camera.scale,
      resolution: this.resolution,
    };
  }
  setZoom(value, options) {
    this.camera.setZoom(value, options);
    this.resize();
  }
  animating() {
    return this.camera.active;
  }
  pause() {
    this.camera.pause();
  }
  pixels() {
    const data = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    this.gl.readPixels(
      0,
      0,
      this.canvas.width,
      this.canvas.height,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      data,
    );
    return data;
  }
  dispose() {
    this.disposed = true;
    this.resizeObserver.disconnect();
    window.removeEventListener("resize", this.resize);
    for (const buffer of this.resources) this.gl.deleteBuffer(buffer);
    for (const texture of this.textures) this.gl.deleteTexture(texture);
    this.gl.deleteProgram(this.program);
  }
}
