// Exact perspective mapping of the placeholder content onto the mockup quad.
// The fragment shader inverts the homography per output pixel, samples with mipmaps
// and antialiases the quad edges. Large outputs are rendered in tiles.

import { applyH, invert3, quadBounds, type Mat3, type Quad } from '../../geometry';

const VS = `#version 300 es
in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform mat3 inv;        // target px -> normalised texture coords
uniform vec2 origin;     // tile origin in target px
uniform float tileH;
out vec4 color;
void main() {
  vec2 p = vec2(origin.x + gl_FragCoord.x, origin.y + (tileH - gl_FragCoord.y));
  vec3 q = inv * vec3(p, 1.0);
  vec2 uv = q.xy / q.z;
  vec2 d = min(uv, 1.0 - uv);
  vec2 fw = max(fwidth(uv), vec2(1e-6));
  float cov = clamp(min(d.x / fw.x, d.y / fw.y) + 0.5, 0.0, 1.0);
  if (cov <= 0.0) { color = vec4(0.0); return; }
  color = texture(tex, clamp(uv, 0.0, 1.0)) * cov;
}`;

let shared: { canvas: HTMLCanvasElement; gl: WebGL2RenderingContext; prog: WebGLProgram; maxTex: number; maxView: number } | null = null;

function getGl() {
  if (shared && !shared.gl.isContextLost()) return shared;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
  if (!gl) throw new Error('WebGL2 is not available, so perspective placeholders cannot be rendered.');
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  shared = { canvas, gl, prog, maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE), maxView: Math.min(dims[0], dims[1]) };
  return shared;
}

export function maxTextureSize(): number { return getGl().maxTex; }

/**
 * Draws `src` (a w x h raster of the placeholder content) onto `target` so that its
 * corners land on `quad` (target pixels). Pixels outside the target are not rendered.
 */
export function warpInto(target: CanvasRenderingContext2D, src: HTMLCanvasElement, quad: Quad) {
  const { canvas, gl, prog, maxView } = getGl();
  // Normalised texture coords -> target px, then invert.
  const H: Mat3 = homographyUnitToQuad(quad);
  const inv = invert3(H);
  const b = quadBounds(quad);
  const W = target.canvas.width, Ht = target.canvas.height;
  const x0 = Math.max(0, Math.floor(b.left) - 1), y0 = Math.max(0, Math.floor(b.top) - 1);
  const x1 = Math.min(W, Math.ceil(b.right) + 1), y1 = Math.min(Ht, Math.ceil(b.bottom) + 1);
  if (x1 <= x0 || y1 <= y0) return;

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.useProgram(prog);
  // GLSL mat3 is column-major.
  gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'inv'), false, [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]]);
  gl.uniform1i(gl.getUniformLocation(prog, 'tex'), 0);

  const tile = Math.min(4096, maxView);
  for (let ty = y0; ty < y1; ty += tile) {
    for (let tx = x0; tx < x1; tx += tile) {
      const tw = Math.min(tile, x1 - tx), th = Math.min(tile, y1 - ty);
      canvas.width = tw; canvas.height = th;
      gl.viewport(0, 0, tw, th);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(gl.getUniformLocation(prog, 'origin'), tx, ty);
      gl.uniform1f(gl.getUniformLocation(prog, 'tileH'), th);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      target.drawImage(canvas, tx, ty);
    }
  }
  gl.deleteTexture(tex);
}

function homographyUnitToQuad(q: Quad): Mat3 {
  // Closed-form square -> quad (Heckbert). Unit square corners map to q in TL, TR, BR, BL order.
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
    g, h, 1,
  ];
}

/** Exposed for tests: maps a point of the w x h content into the quad. */
export function mapContentPoint(quad: Quad, w: number, h: number, x: number, y: number) {
  return applyH(homographyUnitToQuad(quad), { x: x / w, y: y / h });
}
