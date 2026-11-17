// examples/rtc-viewer on the runtime itself: the CLI sender's H.264 I_PCM encoder (parsed back
// bit by bit), the display's WGSL on Deno's WebGPU (compiled, and drawn to check the aspect fit)
// and the whole send path over a real WebRTC connection on loopback: the hub on Deno.serve, the
// CLI's pattern track offered by the sender, a Deno viewer answering and reading the RTP.

import { assert, assertEquals } from "@std/assert";
import {
  BitWriter,
  encodeFrame,
  escapeRbsp,
  H264_FMTP,
  idrSlice,
  pps,
  sps,
} from "../examples/rtc-viewer/cli/h264.ts";
import { rgbToYuv, testPattern } from "../examples/rtc-viewer/cli/pattern.ts";
import { patternSource } from "../examples/rtc-viewer/cli/send.ts";
import { SignalHub } from "../examples/rtc-viewer/lib/signal/hub.ts";
import { startSender, startViewer } from "../examples/rtc-viewer/lib/rtc/peers.ts";
import { fitScale, videoWgsl } from "../examples/rtc-viewer/lib/pipeline/shaders.ts";

// ---------------------------------------------------------------------------------------------
// H.264: a reader for what the encoder writes.

/** Removes emulation-prevention bytes (the inverse of escapeRbsp). */
function unescapeRbsp(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of data) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

class BitReader {
  #pos = 0;
  constructor(readonly data: Uint8Array) {}
  bit(): number {
    const b = (this.data[this.#pos >> 3] >> (7 - (this.#pos & 7))) & 1;
    this.#pos++;
    return b;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) zeros++;
    return (1 << zeros) - 1 + this.bits(zeros);
  }
  se(): number {
    const k = this.ue();
    return k % 2 ? (k + 1) / 2 : -k / 2;
  }
  align(): void {
    while (this.#pos & 7) {
      assertEquals(this.bit(), 0, "alignment bits are zero");
    }
  }
  bytes(n: number): Uint8Array {
    const start = this.#pos >> 3;
    this.#pos += n * 8;
    return this.data.slice(start, start + n);
  }
}

/** The NAL units of an Annex B stream (start codes removed, still escaped). */
function annexB(stream: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 3 < stream.length; i++) {
    if (
      stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 0 &&
      stream[i + 3] === 1
    ) {
      starts.push(i + 4);
      i += 3;
    }
  }
  return starts.map((s, i) =>
    stream.slice(s, i + 1 < starts.length ? starts[i + 1] - 4 : undefined)
  );
}

/** The picture size an SPS (NAL header included) describes, read the way a decoder reads it. */
function spsSize(
  nal: Uint8Array,
): { width: number; height: number; profile: string } {
  const r = new BitReader(unescapeRbsp(nal.slice(1)));
  const profile = [r.bits(8), r.bits(8), r.bits(8)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  r.ue(); // sps id
  r.ue(); // log2_max_frame_num_minus4
  assertEquals(r.ue(), 2, "pic_order_cnt_type");
  r.ue(); // max_num_ref_frames
  r.bit();
  const mbW = r.ue() + 1;
  const mbH = r.ue() + 1;
  assertEquals(r.bit(), 1, "frame_mbs_only");
  r.bit();
  let [right, bottom] = [0, 0];
  if (r.bit()) {
    r.ue();
    right = r.ue();
    r.ue();
    bottom = r.ue();
  }
  return {
    width: mbW * 16 - right * 2,
    height: mbH * 16 - bottom * 2,
    profile,
  };
}

/** The first macroblock's luma samples of an IDR I_PCM slice (NAL header included). */
function firstMacroblockLuma(nal: Uint8Array): Uint8Array {
  assertEquals(nal[0] & 0x1f, 5, "an IDR slice");
  const r = new BitReader(unescapeRbsp(nal.slice(1)));
  assertEquals(r.ue(), 0, "first_mb_in_slice");
  assertEquals(r.ue(), 7, "slice_type I");
  r.ue(); // pps id
  r.bits(4); // frame_num
  r.ue(); // idr_pic_id
  r.bits(2); // dec_ref_pic_marking
  assertEquals(r.se(), 0, "slice_qp_delta");
  assertEquals(r.ue(), 1, "deblocking off");
  assertEquals(r.ue(), 25, "mb_type I_PCM");
  r.align();
  return r.bytes(256);
}

Deno.test("rtc-viewer h264: Exp-Golomb codes and emulation prevention", () => {
  const w = new BitWriter();
  for (const v of [0, 1, 2, 25, 300]) w.ue(v);
  for (const v of [0, 1, -1, 7, -8]) w.se(v);
  w.trailing();
  const r = new BitReader(w.finish());
  assertEquals([r.ue(), r.ue(), r.ue(), r.ue(), r.ue()], [0, 1, 2, 25, 300]);
  assertEquals([r.se(), r.se(), r.se(), r.se(), r.se()], [0, 1, -1, 7, -8]);
  assertEquals([...escapeRbsp(Uint8Array.of(0, 0, 1, 0, 0, 0, 0, 0, 3, 5))], [
    0,
    0,
    3,
    1,
    0,
    0,
    3,
    0,
    0,
    3,
    0,
    3,
    5,
  ]);
  const random = crypto.getRandomValues(new Uint8Array(4096));
  random.set([0, 0, 0, 0, 0, 1, 0, 0, 2], 100);
  assertEquals(unescapeRbsp(escapeRbsp(random)), random, "round trip");
  const escaped = escapeRbsp(random);
  for (let i = 0; i + 2 < escaped.length; i++) {
    assert(
      !(escaped[i] === 0 && escaped[i + 1] === 0 && escaped[i + 2] <= 2),
      "no start code",
    );
  }
});

Deno.test("rtc-viewer h264: SPS / PPS / IDR parse back (cropping, I_PCM samples)", () => {
  for (const [w, h] of [[320, 180], [256, 144], [640, 360], [18, 20]]) {
    const frame = testPattern(w, h, 0);
    const nals = annexB(encodeFrame(frame, 0));
    assertEquals(nals.map((n) => n[0] & 0x1f), [7, 8, 5], "SPS, PPS, IDR");
    assertEquals(nals[0], sps(w, h).slice(4));
    assertEquals(nals[1], pps().slice(4));
    assertEquals(spsSize(nals[0]), { width: w, height: h, profile: "42e01f" });
    // The first macroblock is the picture's top-left 16×16 luma (edge-repeated past it).
    const luma = firstMacroblockLuma(nals[2]);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const src = frame.y[Math.min(y, h - 1) * w + Math.min(x, w - 1)];
        assertEquals(
          luma[y * 16 + x],
          Math.max(1, src),
          `sample ${x},${y} of ${w}x${h}`,
        );
      }
    }
  }
  assertEquals(H264_FMTP.includes("packetization-mode=1"), true);
  // Consecutive IDR pictures differ in idr_pic_id.
  const frame = testPattern(32, 32, 0);
  assert(idrSlice(frame, 0).join() !== idrSlice(frame, 1).join());
});

Deno.test("rtc-viewer pattern: colour bars in BT.601 limited range, a moving square", () => {
  assertEquals(rgbToYuv(0, 0, 0), [16, 128, 128]);
  assertEquals(rgbToYuv(255, 255, 255), [235, 128, 128]);
  const a = testPattern(320, 180, 0);
  const b = testPattern(320, 180, 10);
  assertEquals([a.y.length, a.u.length, a.v.length], [
    320 * 180,
    160 * 90,
    160 * 90,
  ]);
  assert(a.y.join() !== b.y.join(), "the square moves");
  assertEquals(a.y[0], rgbToYuv(191, 191, 191)[0], "grey bar at the left edge");
});

// ---------------------------------------------------------------------------------------------
// WGSL on Deno's WebGPU.

const adapter = await navigator.gpu?.requestAdapter().catch(() => null) ?? null;

Deno.test({
  name: "rtc-viewer WGSL: compiles and aspect-fits a picture (Deno's WebGPU)",
  ignore: adapter === null,
  async fn() {
    const device = await adapter!.requestDevice();
    try {
      // Deno's WebGPU has no external textures: the same shader over a texture_2d<f32>.
      device.pushErrorScope("validation");
      const module = device.createShaderModule({
        code: videoWgsl("texture_2d<f32>"),
      });
      const info = await module.getCompilationInfo();
      assertEquals(
        info.messages.filter((m) => m.type === "error").map((m) => m.message),
        [],
      );
      const format = "rgba8unorm";
      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-strip" },
      });
      assertEquals(await device.popErrorScope(), null);

      // A 16:9 red picture on a square 64×64 target: letterboxed to rows 14–49.
      const source = device.createTexture({
        size: [16, 9],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture: source },
        new Uint8Array(16 * 9 * 4).map((
          _,
          i,
        ) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0)),
        { bytesPerRow: 64 },
        [16, 9],
      );
      const target = device.createTexture({
        size: [64, 64],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      const fit = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM,
        mappedAtCreation: true,
      });
      new Float32Array(fit.getMappedRange()).set([
        ...fitScale(16, 9, 64, 64),
        0,
        0,
      ]);
      fit.unmap();
      const readback = device.createBuffer({
        size: 64 * 64 * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: target.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: device.createSampler() },
            { binding: 1, resource: source.createView() },
            { binding: 2, resource: { buffer: fit } },
          ],
        }),
      );
      pass.draw(4);
      pass.end();
      encoder.copyTextureToBuffer({ texture: target }, {
        buffer: readback,
        bytesPerRow: 256,
      }, [
        64,
        64,
      ]);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const pixels = new Uint8Array(readback.getMappedRange().slice(0));
      readback.unmap();
      const red = (x: number, y: number) => pixels[(y * 64 + x) * 4];
      // 64 × 9/16 = 36 rows of picture, centred: 14 rows of bar above and below.
      for (const y of [0, 13, 50, 63]) {
        assertEquals(red(32, y), 0, `bar row ${y}`);
      }
      for (const y of [14, 32, 49]) {
        assertEquals(red(32, y), 255, `picture row ${y}`);
      }
      for (const x of [0, 63]) assertEquals(red(x, 32), 255, "full width");
      for (const r of [source, target]) r.destroy();
      for (const b of [fit, readback]) b.destroy();
    } finally {
      device.destroy();
    }
  },
});

// ---------------------------------------------------------------------------------------------
// The send path over WebRTC, on loopback.

const hasMedia = typeof (Deno as { webrtc?: unknown }).webrtc === "object";

/** Reassembles H.264 NAL units from RTP packets (single NAL, STAP-A, FU-A; RFC 6184). */
/** An RTP packet's payload: past the header, its CSRCs and extension, before any padding. */
function rtpPayload(packet: Uint8Array): Uint8Array {
  let offset = 12 + (packet[0] & 0x0f) * 4;
  if (packet[0] & 0x10) offset += 4 + ((packet[offset + 2] << 8) | packet[offset + 3]) * 4;
  const end = packet[0] & 0x20 ? packet.length - packet[packet.length - 1] : packet.length;
  return packet.subarray(offset, end);
}

class Depacketizer {
  #fu: number[] | null = null;
  readonly nals: Uint8Array[] = [];

  push(packet: Uint8Array): void {
    const payload = rtpPayload(packet);
    const type = payload[0] & 0x1f;
    if (type === 24) this.#stapA(payload);
    else if (type === 28) this.#fuA(payload);
    else if (type >= 1 && type <= 23) this.nals.push(payload.slice());
  }

  /** STAP-A: 16-bit size, NAL unit, repeated. */
  #stapA(payload: Uint8Array): void {
    for (let i = 1; i + 2 <= payload.length;) {
      const size = (payload[i] << 8) | payload[i + 1];
      this.nals.push(payload.slice(i + 2, i + 2 + size));
      i += 2 + size;
    }
  }

  /** FU-A: a NAL unit cut into fragments (start and end bits in the FU header). */
  #fuA(payload: Uint8Array): void {
    const [indicator, header] = payload;
    if (header & 0x80) this.#fu = [(indicator & 0xe0) | (header & 0x1f)];
    if (!this.#fu) return;
    this.#fu.push(...payload.subarray(2));
    if (header & 0x40) {
      this.nals.push(Uint8Array.from(this.#fu));
      this.#fu = null;
    }
  }
}

Deno.test({
  name: "rtc-viewer send path: the CLI's pattern track reaches a viewer over WebRTC (loopback)",
  ignore: !hasMedia,
  async fn() {
    const hub = new SignalHub();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      (request) => hub.handle(request),
    );
    const url = `http://127.0.0.1:${server.addr.port}/api/signal`;
    // Loopback only: no host candidates on the machine's other interfaces, no mDNS.
    const network = Deno.webrtc.createNetwork({
      bindAddresses: ["127.0.0.1"],
      mdns: false,
    });
    const rtcConfig = { denoNetwork: network } as RTCConfiguration;
    const source = patternSource(320, 180, 15);
    const depacketizer = new Depacketizer();
    let reading: Promise<void> = Promise.resolve();
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => resolveDone = r);
    const viewer = startViewer({
      url,
      room: "loopback",
      rtcConfig,
      onTrack(event) {
        reading = (async () => {
          let payloadType = -1;
          for await (const packet of Deno.webrtc.readRtp(event.receiver)) {
            payloadType = payloadType < 0 ? packet[1] & 0x7f : payloadType;
            if ((packet[1] & 0x7f) !== payloadType) continue; // RTX / FEC
            depacketizer.push(packet);
            if (depacketizer.nals.some((n) => (n[0] & 0x1f) === 5)) break;
          }
          resolveDone();
        })();
      },
    });
    const sender = startSender({
      url,
      room: "loopback",
      track: source.track,
      rtcConfig,
    });
    const timeout = setTimeout(resolveDone, 20_000);
    try {
      await done;
      const types = depacketizer.nals.map((n) => n[0] & 0x1f);
      assert(
        types.includes(5),
        `an IDR picture arrived (got NAL types ${types.join(",")})`,
      );
      assertEquals(
        depacketizer.nals.find((n) => (n[0] & 0x1f) === 7),
        sps(320, 180).slice(4),
      );
      assertEquals(
        depacketizer.nals.find((n) => (n[0] & 0x1f) === 8),
        pps().slice(4),
      );
      const idr = depacketizer.nals.find((n) => (n[0] & 0x1f) === 5)!;
      const grey = rgbToYuv(191, 191, 191)[0];
      assertEquals(
        [...firstMacroblockLuma(idr)],
        new Array(256).fill(grey),
        "the grey bar",
      );
      assertEquals(sender.viewers, 1);
    } finally {
      clearTimeout(timeout);
      sender.close();
      viewer.close();
      source.stop();
      await reading.catch(() => {});
      hub.close();
      await server.shutdown();
      network.close();
    }
  },
});
