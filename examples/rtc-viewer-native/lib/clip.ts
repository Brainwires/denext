// A file as the frame source (`RTCV_PLAY=<file>`): no sender, no WebRTC. Two formats:
//
// - `.bin`: the Deno runtime's fake-camera clips (`<u32 little-endian length><frame>` records;
//   native/tests/fixtures/h264.bin and friends), the codec named by the file (`h264`, `h265`,
//   `vp9`);
// - `.h264` / `.264` / `.h265` / `.265` / `.hevc`: a raw Annex B stream with access unit
//   delimiters (ffmpeg's `-x264-params aud=1`, `-x265-params aud=1`), split at each delimiter.

import type { CodecName } from "./native.ts";

/** A clip: its codec and frames. */
export interface Clip {
  readonly codec: CodecName;
  readonly frames: Uint8Array[];
}

/** The records of a `.bin` clip. */
export function parseRecords(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Uint8Array[] = [];
  let at = 0;
  while (at + 4 <= bytes.length) {
    const len = view.getUint32(at, true);
    if (at + 4 + len > bytes.length) break;
    out.push(bytes.subarray(at + 4, at + 4 + len));
    at += 4 + len;
  }
  return out;
}

/** Whether the NAL unit whose header byte is `header` is an access unit delimiter. */
function isAud(codec: CodecName, header: number): boolean {
  return codec === "h264" ? (header & 0x1f) === 9 : ((header >> 1) & 0x3f) === 35;
}

/** The offset of each start code (`00 00 01`, or `00 00 00 01` from its first zero) in `bytes`. */
function* startCodes(bytes: Uint8Array): Generator<{ at: number; header: number }> {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0 || bytes[i + 2] !== 1) continue;
    yield { at: i > 0 && bytes[i - 1] === 0 ? i - 1 : i, header: bytes[i + 3] };
    i += 2;
  }
}

/** An Annex B stream's access units, each starting at its delimiter (and its start code). */
export function splitAnnexB(bytes: Uint8Array, codec: "h264" | "h265"): Uint8Array[] {
  const starts = [...startCodes(bytes)].filter((s) => isAud(codec, s.header)).map((s) => s.at);
  if (starts.length === 0) return bytes.length ? [bytes] : [];
  starts.push(bytes.length);
  return starts.slice(0, -1).map((start, n) => bytes.subarray(start, starts[n + 1]));
}

/** The clip in `bytes`, named `name` (its codec and format come from the name). */
export function parseClip(name: string, bytes: Uint8Array): Clip {
  const lower = name.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (base.endsWith(".bin")) {
    const codec = (["h264", "h265", "vp9"] as const).find((c) => base.startsWith(c));
    if (!codec) {
      throw new Error(`${name}: name a .bin clip after its codec (h264.bin, h265.bin, vp9.bin)`);
    }
    return { codec, frames: parseRecords(bytes) };
  }
  if (/\.(h264|264)$/.test(base)) return { codec: "h264", frames: splitAnnexB(bytes, "h264") };
  if (/\.(h265|265|hevc)$/.test(base)) return { codec: "h265", frames: splitAnnexB(bytes, "h265") };
  throw new Error(`${name}: play a .bin clip or an Annex B .h264 / .h265 stream`);
}
