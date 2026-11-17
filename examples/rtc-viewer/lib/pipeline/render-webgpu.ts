// The WebGPU display: each `VideoFrame` becomes an external texture (`importExternalTexture`), so
// the GPU samples the decoder's own YUV planes and converts in the shader (lib/pipeline/shaders.ts).

import { type FrameRenderer, syncCanvasSize } from "./renderer.ts";
import { fitScale, videoWgsl } from "./shaders.ts";

/** A WebGPU renderer on `canvas`; rejects when there is no adapter or device. */
export async function createWebGpuRenderer(
  canvas: HTMLCanvasElement,
): Promise<FrameRenderer> {
  const gpu = navigator.gpu;
  const adapter = await gpu?.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) throw new Error("no webgpu canvas context");
  const format = gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const module = device.createShaderModule({
    label: "video",
    code: videoWgsl(),
  });
  const pipeline = device.createRenderPipeline({
    label: "video",
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-strip" },
  });
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });
  const fit = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const scale = new Float32Array(4);

  return {
    kind: "webgpu",
    draw(frame) {
      try {
        syncCanvasSize(canvas);
        const [sx, sy] = fitScale(
          frame.displayWidth,
          frame.displayHeight,
          canvas.width,
          canvas.height,
        );
        scale[0] = sx;
        scale[1] = sy;
        device.queue.writeBuffer(fit, 0, scale);
        // An external texture lives until the frame closes: bind it for this one draw.
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: sampler },
            {
              binding: 1,
              resource: device.importExternalTexture({ source: frame }),
            },
            { binding: 2, resource: { buffer: fit } },
          ],
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(4);
        pass.end();
        device.queue.submit([encoder.finish()]);
      } finally {
        frame.close();
      }
    },
    destroy() {
      context.unconfigure();
      fit.destroy();
      device.destroy();
    },
  };
}
