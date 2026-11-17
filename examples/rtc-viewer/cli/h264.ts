// A tiny H.264 encoder for the CLI sender's test pattern: every frame an IDR picture of I_PCM
// macroblocks (the raw samples, no prediction or transform), Constrained Baseline, Annex B. It is
// big (≈1.5 bytes a pixel) but needs no codec library, and every H.264 decoder takes it, the
// browsers' hardware ones included. Pure TypeScript; the tests parse what it writes.

/** One 4:2:0 picture: `y` is width×height, `u` and `v` are (width/2)×(height/2). */
export interface YuvFrame {
  width: number;
  height: number;
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
}

/** The SDP `profile-level-id` the stream matches: Constrained Baseline, level 3.1. */
const PROFILE_LEVEL_ID = "42e01f";

/** The fmtp line an `EncodedMediaTrack` carrying this stream declares. */
export const H264_FMTP =
  `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${PROFILE_LEVEL_ID}`;

/** An MSB-first bit writer with Exp-Golomb codes. */
export class BitWriter {
  #bytes: number[] = [];
  #current = 0;
  #bits = 0;

  bit(b: number): void {
    this.#current = (this.#current << 1) | (b & 1);
    if (++this.#bits === 8) {
      this.#bytes.push(this.#current);
      this.#current = 0;
      this.#bits = 0;
    }
  }

  bits(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) this.bit((value >>> i) & 1);
  }

  /** ue(v): unsigned Exp-Golomb. */
  ue(value: number): void {
    const code = value + 1;
    const length = 32 - Math.clz32(code);
    this.bits(0, length - 1);
    this.bits(code, length);
  }

  /** se(v): signed Exp-Golomb. */
  se(value: number): void {
    this.ue(value <= 0 ? -2 * value : 2 * value - 1);
  }

  /** Zero bits up to the next byte boundary. */
  align(): void {
    while (this.#bits !== 0) this.bit(0);
  }

  /** Whole bytes (the writer must be aligned). */
  bytes(data: ArrayLike<number>): void {
    if (this.#bits !== 0) {
      throw new Error("bytes() needs a byte-aligned writer");
    }
    for (let i = 0; i < data.length; i++) this.#bytes.push(data[i]);
  }

  /** rbsp_trailing_bits: a stop bit, then alignment. */
  trailing(): void {
    this.bit(1);
    this.align();
  }

  finish(): Uint8Array<ArrayBuffer> {
    if (this.#bits !== 0) {
      throw new Error("finish() needs a byte-aligned writer");
    }
    return Uint8Array.from(this.#bytes);
  }
}

/** Inserts emulation-prevention bytes (`00 00 0x` → `00 00 03 0x` for x ≤ 3). */
export function escapeRbsp(rbsp: Uint8Array): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

/** A NAL unit with its Annex B start code. */
function nal(
  refIdc: number,
  type: number,
  rbsp: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const body = escapeRbsp(rbsp);
  const out = new Uint8Array(5 + body.length);
  out.set([0, 0, 0, 1, (refIdc << 5) | type]);
  out.set(body, 5);
  return out;
}

function macroblocks(
  width: number,
  height: number,
): { mbW: number; mbH: number } {
  return { mbW: Math.ceil(width / 16), mbH: Math.ceil(height / 16) };
}

/** The sequence parameter set for a `width`×`height` stream (even sizes; cropped to them). */
export function sps(width: number, height: number): Uint8Array<ArrayBuffer> {
  const { mbW, mbH } = macroblocks(width, height);
  const w = new BitWriter();
  w.bits(0x42, 8); // profile_idc 66: Baseline
  w.bits(0xe0, 8); // constraint_set0/1/2: Constrained Baseline
  w.bits(31, 8); // level_idc 3.1
  w.ue(0); // seq_parameter_set_id
  w.ue(0); // log2_max_frame_num_minus4
  w.ue(2); // pic_order_cnt_type 2: output order = decode order
  w.ue(1); // max_num_ref_frames
  w.bit(0); // gaps_in_frame_num_value_allowed_flag
  w.ue(mbW - 1); // pic_width_in_mbs_minus1
  w.ue(mbH - 1); // pic_height_in_map_units_minus1
  w.bit(1); // frame_mbs_only_flag
  w.bit(1); // direct_8x8_inference_flag
  const cropRight = (mbW * 16 - width) / 2;
  const cropBottom = (mbH * 16 - height) / 2;
  w.bit(cropRight || cropBottom ? 1 : 0); // frame_cropping_flag
  if (cropRight || cropBottom) {
    w.ue(0); // left
    w.ue(cropRight);
    w.ue(0); // top
    w.ue(cropBottom);
  }
  w.bit(0); // vui_parameters_present_flag
  w.trailing();
  return nal(3, 7, w.finish());
}

/** The picture parameter set. */
export function pps(): Uint8Array<ArrayBuffer> {
  const w = new BitWriter();
  w.ue(0); // pic_parameter_set_id
  w.ue(0); // seq_parameter_set_id
  w.bit(0); // entropy_coding_mode_flag: CAVLC
  w.bit(0); // bottom_field_pic_order_in_frame_present_flag
  w.ue(0); // num_slice_groups_minus1
  w.ue(0); // num_ref_idx_l0_default_active_minus1
  w.ue(0); // num_ref_idx_l1_default_active_minus1
  w.bit(0); // weighted_pred_flag
  w.bits(0, 2); // weighted_bipred_idc
  w.se(0); // pic_init_qp_minus26
  w.se(0); // pic_init_qs_minus26
  w.se(0); // chroma_qp_index_offset
  w.bit(1); // deblocking_filter_control_present_flag
  w.bit(0); // constrained_intra_pred_flag
  w.bit(0); // redundant_pic_cnt_present_flag
  w.trailing();
  return nal(3, 8, w.finish());
}

/** I_PCM's mb_type in an I slice. */
const MB_TYPE_I_PCM = 25;

/** Copies one macroblock's `size`×`size` block of a plane, edge pixels repeated past the picture. */
function block(
  w: BitWriter,
  plane: Uint8Array,
  stride: number,
  rows: number,
  x0: number,
  y0: number,
  size: number,
): void {
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    const row = Math.min(y0 + y, rows - 1) * stride;
    for (let x = 0; x < size; x++) {
      // A sample of 0 was forbidden in early editions of the standard; keep to 1–255.
      out[y * size + x] = Math.max(
        1,
        plane[row + Math.min(x0 + x, stride - 1)],
      );
    }
  }
  w.bytes(out);
}

/** One IDR slice of I_PCM macroblocks. `idrPicId` must differ between consecutive IDRs. */
export function idrSlice(
  frame: YuvFrame,
  idrPicId: number,
): Uint8Array<ArrayBuffer> {
  const { width, height } = frame;
  const { mbW, mbH } = macroblocks(width, height);
  const w = new BitWriter();
  w.ue(0); // first_mb_in_slice
  w.ue(7); // slice_type: I (every slice of the picture)
  w.ue(0); // pic_parameter_set_id
  w.bits(0, 4); // frame_num (0 for an IDR picture)
  w.ue(idrPicId & 0xffff); // idr_pic_id
  w.bit(0); // no_output_of_prior_pics_flag
  w.bit(0); // long_term_reference_flag
  w.se(0); // slice_qp_delta
  w.ue(1); // disable_deblocking_filter_idc: off (I_PCM is never filtered anyway)
  for (let my = 0; my < mbH; my++) {
    for (let mx = 0; mx < mbW; mx++) {
      w.ue(MB_TYPE_I_PCM);
      w.align(); // pcm_alignment_zero_bit
      block(w, frame.y, width, height, mx * 16, my * 16, 16);
      block(w, frame.u, width / 2, height / 2, mx * 8, my * 8, 8);
      block(w, frame.v, width / 2, height / 2, mx * 8, my * 8, 8);
    }
  }
  w.trailing();
  return nal(3, 5, w.finish());
}

/** One access unit: SPS + PPS + the IDR slice (so a viewer can start at any frame). */
export function encodeFrame(
  frame: YuvFrame,
  index: number,
): Uint8Array<ArrayBuffer> {
  if (frame.width % 2 || frame.height % 2) {
    throw new RangeError("width and height must be even");
  }
  const parts = [
    sps(frame.width, frame.height),
    pps(),
    idrSlice(frame, index % 2),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
