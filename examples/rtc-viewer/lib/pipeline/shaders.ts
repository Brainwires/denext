// The display shaders and the aspect-fit math. Pure strings and numbers: the tests compile the
// WGSL on Deno's own WebGPU and check the fit without a page.

/**
 * The quad's scale in clip space that fits a `srcW`×`srcH` picture inside a `dstW`×`dstH`
 * surface with its aspect ratio kept (letterbox or pillarbox), centred: `[1, 1]` fills it.
 */
export function fitScale(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): [number, number] {
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return [1, 1];
  const src = srcW / srcH;
  const dst = dstW / dstH;
  return src > dst ? [1, dst / src] : [src / dst, 1];
}

/** The texture type the fragment shader samples: the video's external texture, or a plain one. */
export type VideoTextureType = "texture_external" | "texture_2d<f32>";

/**
 * The WGSL for the video quad. With `texture_external` (the page), `importExternalTexture`
 * hands the shader the decoder's `VideoFrame` as is, and the sampling converts YUV to RGB with the
 * frame's own colour space: no copy, no conversion pass. `texture_2d<f32>` is the same shader
 * over an ordinary texture (what a test can make on an adapter without external textures).
 *
 * Four vertices drawn as a triangle strip cover the quad; `fit.scale` shrinks it to the picture's
 * aspect ratio (see {@link fitScale}), and the clear colour fills the bars.
 */
export function videoWgsl(
  texture: VideoTextureType = "texture_external",
): string {
  return /* wgsl */ `
struct Fit {
  scale: vec2f,
  pad: vec2f,
};

@group(0) @binding(0) var videoSampler: sampler;
@group(0) @binding(1) var video: ${texture};
@group(0) @binding(2) var<uniform> fit: Fit;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  // 0 → (0,0), 1 → (1,0), 2 → (0,1), 3 → (1,1): a strip of two triangles.
  let corner = vec2f(f32(index & 1u), f32(index >> 1u));
  var out: VertexOut;
  out.position = vec4f((corner * 2.0 - 1.0) * fit.scale, 0.0, 1.0);
  // Texture rows run top to bottom; clip space runs bottom to top.
  out.uv = vec2f(corner.x, 1.0 - corner.y);
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  return vec4f(textureSampleBaseClampToEdge(video, videoSampler, in.uv).rgb, 1.0);
}
`;
}

/** The WebGL2 fallback's vertex shader: the same strip and fit as {@link videoWgsl}. */
export const VIDEO_VERTEX_GLSL = /* glsl */ `#version 300 es
uniform vec2 u_scale;
out vec2 v_uv;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  gl_Position = vec4((corner * 2.0 - 1.0) * u_scale, 0.0, 1.0);
  v_uv = vec2(corner.x, 1.0 - corner.y);
}
`;

/**
 * The WebGL2 fallback's fragment shader. `texImage2D(VideoFrame)` has the browser convert the
 * frame to RGB on upload (one copy per frame, which the WebGPU path avoids).
 */
export const VIDEO_FRAGMENT_GLSL = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_video;
in vec2 v_uv;
out vec4 color;
void main() {
  color = vec4(texture(u_video, v_uv).rgb, 1.0);
}
`;
