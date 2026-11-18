// The WebGL2 display, for engines without WebGPU (iOS before 26, older desktop browsers): the
// frame is uploaded with `texImage2D(VideoFrame)`, which converts it to RGB on the way.

import { type FrameRenderer, syncCanvasSize } from "./renderer.ts";
import { fitScale, VIDEO_FRAGMENT_GLSL, VIDEO_VERTEX_GLSL } from "./shaders.ts";

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

/** A WebGL2 renderer on `canvas`; throws when there is no WebGL2. */
export function createWebGl2Renderer(canvas: HTMLCanvasElement): FrameRenderer {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
  if (!gl) throw new Error("no webgl2 context");
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VIDEO_VERTEX_GLSL));
  gl.attachShader(
    program,
    compile(gl, gl.FRAGMENT_SHADER, VIDEO_FRAGMENT_GLSL),
  );
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program: ${gl.getProgramInfoLog(program)}`);
  }
  const scale = gl.getUniformLocation(program, "u_scale");
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  for (
    const [name, value] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ]
  ) gl.texParameteri(gl.TEXTURE_2D, name, value);
  // The vertex shader makes its own corners from gl_VertexID: an empty vertex array is enough.
  const vao = gl.createVertexArray();

  return {
    kind: "webgl2",
    draw(frame) {
      try {
        syncCanvasSize(canvas);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          frame,
        );
        const [sx, sy] = fitScale(
          frame.displayWidth,
          frame.displayHeight,
          canvas.width,
          canvas.height,
        );
        gl.uniform2f(scale, sx, sy);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      } finally {
        frame.close();
      }
    },
    destroy() {
      gl.deleteTexture(texture);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}
