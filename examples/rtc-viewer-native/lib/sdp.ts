// The little SDP reading the receiver does: which video codec an answer settled on, and the
// codec preference order it offers the sender.

import { codecFromMime, type CodecName } from "./native.ts";

/** The codecs the native decoder takes, best first (HEVC: half H.264's bitrate for the same picture). */
export const DECODABLE: readonly CodecName[] = ["h265", "h264", "vp9"];

/**
 * The video codec an SDP settled on: the first payload type of its first `m=video` section that
 * names a codec (retransmission, RED and FEC formats are not codecs). `null` without one.
 */
export function negotiatedVideoCodec(sdp: string): CodecName | null {
  const lines = sdp.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith("m=video "));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("m="));
  const section = lines.slice(start, end < 0 ? undefined : end);
  const payloads = section[0].split(" ").slice(3);
  const names = new Map<string, string>();
  for (const line of section) {
    const m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(line);
    if (m) names.set(m[1], m[2]);
  }
  for (const pt of payloads) {
    const name = names.get(pt);
    const codec = name ? codecFromMime(`video/${name}`) : null;
    if (codec) return codec;
  }
  return null;
}

/** A codec capability, as `RTCRtpReceiver.getCapabilities("video").codecs` lists them. */
export interface CodecCapability {
  readonly mimeType: string;
  readonly [key: string]: unknown;
}

/**
 * `codecs` reordered for `setCodecPreferences`: the decodable ones in {@link DECODABLE}'s order
 * (`prefer` first when given), then nothing else — a codec the viewer can't decode is left out,
 * so the sender can't pick it. Retransmission / RED / FEC entries are kept at the end.
 */
export function preferDecodable(
  codecs: readonly CodecCapability[],
  prefer?: CodecName,
): CodecCapability[] {
  const order = prefer ? [prefer, ...DECODABLE.filter((c) => c !== prefer)] : [...DECODABLE];
  const rank = (c: CodecCapability) => {
    const codec = codecFromMime(c.mimeType);
    return codec ? order.indexOf(codec) : -1;
  };
  const media = codecs.filter((c) => rank(c) >= 0).sort((a, b) => rank(a) - rank(b));
  const helpers = codecs.filter((c) => /\/(rtx|red|ulpfec|flexfec-03)$/i.test(c.mimeType));
  return [...media, ...helpers];
}
