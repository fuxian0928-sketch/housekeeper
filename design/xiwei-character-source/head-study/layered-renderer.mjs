const VERTEX = `attribute vec2 position;varying vec2 uv;void main(){uv=vec2((position.x+1.0)*0.5,(1.0-position.y)*0.5);gl_Position=vec4(position,0.0,1.0);}`;
const FRAGMENT = `precision highp float;
varying vec2 uv;uniform sampler2D originalArt,closedEyes,closedMouth,openMouth,motionMask;uniform float eye,mouth,clock,bodyMotion,hairMotion;
float ellipse(vec2 p,vec2 center,vec2 radius){return 1.0-smoothstep(0.72,1.0,length((p-center)/radius));}
vec3 guide(vec2 p){return texture2D(motionMask,vec2(p.x*0.8002853067+0.0998573466,p.y)).rgb;}
void main(){
 vec2 p=(uv-vec2(0.02,0.015))/vec2(0.96,0.97);
 float head=1.0-smoothstep(0.28,0.45,p.y);
 float roll=bodyMotion*(0.0009*sin(clock*0.71)+0.0016*sin(clock*0.57)*head);
 vec2 pivot=vec2(0.51,0.80),d=p-pivot;float c=cos(roll),s=sin(roll);p=mat2(c,-s,s,c)*d+pivot;
 p.x-=bodyMotion*(0.0023*sin(clock*0.71)+0.0017*sin(clock*0.53+0.4)*head);
 p.y-=bodyMotion*(0.0011*sin(clock*0.83+0.5)+0.0006*sin(clock*0.61)*head);
 float chest=smoothstep(0.32,0.45,p.y)*(1.0-smoothstep(0.90,1.0,p.y));
 p.x=0.51+(p.x-0.51)/(1.0+0.0017*sin(clock*0.92)*bodyMotion*chest);
 vec3 m=guide(p);float backTip=pow(clamp((p.y-0.12)/0.88,0.0,1.0),1.5),frontTip=pow(clamp((p.y-0.04)/0.20,0.0,1.0),1.5);
 p.x-=hairMotion*((0.0055*sin(clock*0.89+p.y*0.6+p.x*1.8)+0.0015*sin(clock*1.41-p.y*0.5))*m.g*backTip+0.0010*sin(clock*0.91+0.5)*m.b*frontTip);
 p.y-=hairMotion*0.0014*sin(clock*0.81+p.x*3.0)*m.g*backTip;
 if(p.x<0.0||p.x>1.0||p.y<0.0||p.y>1.0){gl_FragColor=vec4(0.0);return;}
 vec4 original=texture2D(originalArt,p),color=original;
 float eyeMask=max(ellipse(p,vec2(469.0/1122.0,317.0/1402.0),vec2(61.0/1122.0,38.0/1402.0)),ellipse(p,vec2(623.5/1122.0,281.0/1402.0),vec2(58.5/1122.0,39.0/1402.0)));
 float mouthMask=ellipse(p,vec2(570.5/1122.0,422.5/1402.0),vec2(68.5/1122.0,45.5/1402.0));
 vec4 lips=texture2D(closedMouth,p);if(mouth<=0.42)lips=mix(lips,original,mouth/0.42);else lips=mix(original,texture2D(openMouth,p),(mouth-0.42)/0.58);
 color=mix(color,lips,mouthMask);color=mix(color,texture2D(closedEyes,p),eyeMask*eye);
 float alpha=guide(p).r;gl_FragColor=vec4(color.rgb,alpha);
}`;

export class AmbientMotion {
  constructor() {
    this.time = 0;
    this.body = 0;
    this.hair = 0;
    this.last = null;
    this.active = false;
  }
  pause() {
    this.last = null;
  }
  tick(
    now,
    { body = true, hair = true, asleep = false, reduced = false } = {},
  ) {
    const dt =
      this.last === null
        ? 0
        : Math.max(0, Math.min(100, now - this.last)) / 1000;
    this.last = now;
    const b = reduced || !body ? 0 : asleep ? 0.1 : 1,
      h = reduced || !hair ? 0 : asleep ? 0.12 : 1;
    if (reduced) {
      this.body = 0;
      this.hair = 0;
    } else {
      const f = 1 - Math.exp(-dt / 0.25);
      this.body += (b - this.body) * f;
      this.hair += (h - this.hair) * f;
      if (Math.abs(this.body - b) < 0.001) this.body = b;
      if (Math.abs(this.hair - h) < 0.001) this.hair = h;
    }
    this.active = b > 0 || h > 0 || this.body > 0 || this.hair > 0;
    if (this.active) this.time += dt;
    return {
      time: this.time,
      body: this.body,
      hair: this.hair,
      active: this.active,
    };
  }
  snapshot() {
    return {
      time: this.time,
      body: this.body,
      hair: this.hair,
      active: this.active,
    };
  }
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

export class LayeredRenderer {
  constructor(canvas, images) {
    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!gl)
      throw new Error("本机未能开启分层动效，请开启浏览器硬件加速后重新载入。");
    this.gl = gl;
    this.canvas = canvas;
    const program = gl.createProgram();
    this.program = program;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error("人物动效着色器未能连接。");
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const location = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    for (const [name, image] of Object.entries(images)) {
      const index = Object.keys(images).indexOf(name);
      gl.activeTexture(gl.TEXTURE0 + index);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image,
      );
      gl.uniform1i(gl.getUniformLocation(program, name), index);
    }
    this.uniforms = Object.fromEntries(
      ["eye", "mouth", "clock", "bodyMotion", "hairMotion"].map((name) => [
        name,
        gl.getUniformLocation(program, name),
      ]),
    );
    gl.clearColor(0, 0, 0, 0);
  }
  draw({ eye, mouth }, { time, body, hair }) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    for (const [name, value] of Object.entries({
      eye,
      mouth,
      clock: time,
      bodyMotion: body,
      hairMotion: hair,
    }))
      gl.uniform1f(this.uniforms[name], value);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
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
}
