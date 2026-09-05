// A small User-Agent parser (Next.js `userAgent(request)`), stdlib-only. It reads
// the request's `user-agent` header and derives coarse browser/OS/device info —
// enough for feature-gating and bot detection, not a full UA database.

/** Parsed User-Agent details. */
export interface UserAgent {
  isBot: boolean;
  ua: string;
  browser: { name?: string; version?: string; major?: string };
  os: { name?: string; version?: string };
  /** `type` is `undefined` for a desktop browser, as in Next.js (ua-parser-js). */
  device: {
    type?: "mobile" | "tablet" | "console" | "smarttv" | "wearable" | "embedded";
    vendor?: string;
    model?: string;
  };
  engine: { name?: string; version?: string };
  cpu: { architecture?: string };
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
  if (/smart-?tv|appletv|googletv|hbbtv|roku/i.test(ua)) return { type: "smarttv" };
  return {}; // desktop: `type` is undefined (Next.js / ua-parser-js parity)
}

/** Add ua-parser-js's `major` (the first version component). */
function withMajor(b: { name?: string; version?: string }): UserAgent["browser"] {
  return b.version ? { ...b, major: b.version.split(".")[0] } : b;
}

/** `cpu.architecture` from the common UA tokens. */
function cpuOf(ua: string): UserAgent["cpu"] {
  if (/aarch64|arm64|armv8/i.test(ua)) return { architecture: "arm64" };
  if (/\barm\b|armv7/i.test(ua)) return { architecture: "arm" };
  if (/x86_64|x64|win64|wow64|amd64/i.test(ua)) return { architecture: "amd64" };
  if (/i[3-6]86|x86|win32/i.test(ua)) return { architecture: "ia32" };
  return {};
}

function engineOf(ua: string): UserAgent["engine"] {
  if (/firefox/i.test(ua)) return { name: "Gecko", version: match(ua, /rv:([\d.]+)/i) };
  if (/edg\//i.test(ua) || /chrome\//i.test(ua) || /opr\//i.test(ua)) {
    return { name: "Blink", version: match(ua, /(?:chrome|crios)\/([\d.]+)/i) };
  }
  if (/applewebkit/i.test(ua)) {
    return { name: "WebKit", version: match(ua, /applewebkit\/([\d.]+)/i) };
  }
  if (/trident/i.test(ua)) return { name: "Trident", version: match(ua, /trident\/([\d.]+)/i) };
  return {};
}

/**
 * Parse a raw `user-agent` string into structured details (Next's
 * `userAgentFromString`).
 *
 * @param ua The user-agent string (an empty/absent string yields empty details).
 */
export function userAgentFromString(ua?: string): UserAgent {
  const s = ua ?? "";
  return {
    isBot: BOT_RE.test(s),
    ua: s,
    browser: withMajor(browserOf(s)),
    os: osOf(s),
    device: deviceOf(s),
    engine: engineOf(s),
    cpu: cpuOf(s),
  };
}

/**
 * Parse the request's `user-agent` header into structured details.
 *
 * @param request The incoming request (or an object with `headers`).
 */
export function userAgent(request: { headers: Headers }): UserAgent {
  return userAgentFromString(request.headers.get("user-agent") ?? "");
}
