// A small User-Agent parser (Next.js `userAgent(request)`), stdlib-only. It reads
// the request's `user-agent` header and derives coarse browser/OS/device info —
// enough for feature-gating and bot detection, not a full UA database.

/** Parsed User-Agent details. */
export interface UserAgent {
  /** True when the UA looks like a crawler/bot. */
  isBot: boolean;
  /** The raw `user-agent` header value. */
  ua: string;
  /** Detected browser. */
  browser: { name?: string; version?: string };
  /** Detected operating system. */
  os: { name?: string; version?: string };
  /** Device class inferred from the UA. */
  device: { type?: "mobile" | "tablet" | "console" | "desktop"; vendor?: string };
  /** Detected layout engine. */
  engine: { name?: string };
}

const BOT_RE =
  /bot|crawl|spider|slurp|bingpreview|mediapartners|facebookexternalhit|embedly|quora link preview|pinterest|slackbot|vkshare|w3c_validator|whatsapp|telegrambot|discordbot|googlebot|duckduckbot|baiduspider|yandex/i;

function match(ua: string, re: RegExp): string | undefined {
  const m = re.exec(ua);
  return m ? (m[1] ?? m[0]) : undefined;
}

function browserOf(ua: string): { name?: string; version?: string } {
  // Order matters: Edge/Opera masquerade as Chrome; Chrome as Safari.
  if (/edg(?:e|ios|a)?\//i.test(ua)) {
    return { name: "Edge", version: match(ua, /edg(?:e|ios|a)?\/([\d.]+)/i) };
  }
  if (/opr\/|opera/i.test(ua)) {
    return { name: "Opera", version: match(ua, /(?:opr|opera)[/ ]([\d.]+)/i) };
  }
  if (/firefox\//i.test(ua)) return { name: "Firefox", version: match(ua, /firefox\/([\d.]+)/i) };
  if (/chrome\/|crios\//i.test(ua)) {
    return { name: "Chrome", version: match(ua, /(?:chrome|crios)\/([\d.]+)/i) };
  }
  if (/safari\//i.test(ua)) return { name: "Safari", version: match(ua, /version\/([\d.]+)/i) };
  return {};
}

function osOf(ua: string): { name?: string; version?: string } {
  if (/windows nt/i.test(ua)) {
    return { name: "Windows", version: match(ua, /windows nt ([\d.]+)/i) };
  }
  if (/iphone|ipad|ipod/i.test(ua)) {
    return { name: "iOS", version: match(ua, /os ([\d_]+)/i)?.replace(/_/g, ".") };
  }
  if (/mac os x/i.test(ua)) {
    return { name: "macOS", version: match(ua, /mac os x ([\d_]+)/i)?.replace(/_/g, ".") };
  }
  if (/android/i.test(ua)) return { name: "Android", version: match(ua, /android ([\d.]+)/i) };
  if (/linux/i.test(ua)) return { name: "Linux" };
  return {};
}

function deviceOf(ua: string): UserAgent["device"] {
  if (/ipad|tablet|playbook|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) {
    return { type: "tablet" };
  }
  if (/mobi|iphone|ipod|android.*mobile|windows phone/i.test(ua)) return { type: "mobile" };
  if (/playstation|xbox|nintendo/i.test(ua)) return { type: "console" };
  return { type: "desktop" };
}

function engineOf(ua: string): { name?: string } {
  if (/firefox/i.test(ua)) return { name: "Gecko" };
  if (/edg\//i.test(ua) || /chrome\//i.test(ua) || /opr\//i.test(ua)) return { name: "Blink" };
  if (/applewebkit/i.test(ua)) return { name: "WebKit" };
  if (/trident/i.test(ua)) return { name: "Trident" };
  return {};
}

/**
 * Parse the request's `user-agent` header into structured details.
 *
 * @param request The incoming request (or an object with `headers`).
 */
export function userAgent(request: { headers: Headers }): UserAgent {
  const ua = request.headers.get("user-agent") ?? "";
  return {
    isBot: BOT_RE.test(ua),
    ua,
    browser: browserOf(ua),
    os: osOf(ua),
    device: deviceOf(ua),
    engine: engineOf(ua),
  };
}
