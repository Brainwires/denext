// The WebCodecs codec string for a negotiated WebRTC codec. Pure.

/** The fmtp parameters of an SDP `a=fmtp` line (`profile-level-id=42e01f;packetization-mode=1`). */
export function parseFmtp(line: string | undefined): Map<string, string> {
  const pairs = [...(line ?? "").matchAll(/([^;=\s]+)\s*=\s*([^;]*)/g)];
  return new Map(pairs.map(([, key, value]) => [key.toLowerCase(), value.trim()]));
}

/**
 * `VideoDecoder.configure`'s `codec` for a WebRTC codec (`video/VP8`, `video/H264` with its fmtp
 * line, …), or `null` for one it cannot name. H.264 and H.265 frames from WebRTC are Annex B, so
 * no `description` is needed: the decoder reads the parameter sets in band.
 */
export function codecString(
  mimeType: string,
  sdpFmtpLine?: string,
): string | null {
  const fmtp = parseFmtp(sdpFmtpLine);
  switch (mimeType.toLowerCase()) {
    case "video/vp8":
      return "vp8";
    case "video/vp9": {
      const profile = Number(fmtp.get("profile-id") ?? 0);
      return `vp09.0${profile}.10.${profile === 2 ? "10" : "08"}`;
    }
    case "video/h264": {
      const pli = (fmtp.get("profile-level-id") ?? "42e01f").toLowerCase();
      return /^[0-9a-f]{6}$/.test(pli) ? `avc1.${pli}` : "avc1.42e01f";
    }
    case "video/h265":
      return "hvc1.1.6.L93.B0";
    case "video/av1": {
      const profile = Number(fmtp.get("profile") ?? 0);
      const level = Number(fmtp.get("level-idx") ?? 5);
      return `av01.${profile}.${String(level).padStart(2, "0")}M.08`;
    }
    default:
      return null;
  }
}
