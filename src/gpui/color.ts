/**
 * Colour parsing for the NTB1 encoder: a React Native colour string to the `u32` RGBA (straight
 * alpha, red in the high byte) the `color` value tag carries. Accepts the CSS named colours and
 * `transparent`, `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, and `rgb()` / `rgba()` in the comma and
 * the space (`rgb(1 2 3 / 50%)`) syntax, with numeric or percentage channels. Anything else
 * (`hsl()`, `PlatformColor`, a number) is not a colour here: {@linkcode parseColor} returns null
 * and the encoder leaves the prop out.
 *
 * @module
 */

/** The CSS named colours (CSS Color 4), as `0xRRGGBB`. */
const NAMED: Readonly<Record<string, number>> = {
  aliceblue: 0xf0f8ff,
  antiquewhite: 0xfaebd7,
  aqua: 0x00ffff,
  aquamarine: 0x7fffd4,
  azure: 0xf0ffff,
  beige: 0xf5f5dc,
  bisque: 0xffe4c4,
  black: 0x000000,
  blanchedalmond: 0xffebcd,
  blue: 0x0000ff,
  blueviolet: 0x8a2be2,
  brown: 0xa52a2a,
  burlywood: 0xdeb887,
  cadetblue: 0x5f9ea0,
  chartreuse: 0x7fff00,
  chocolate: 0xd2691e,
  coral: 0xff7f50,
  cornflowerblue: 0x6495ed,
  cornsilk: 0xfff8dc,
  crimson: 0xdc143c,
  cyan: 0x00ffff,
  darkblue: 0x00008b,
  darkcyan: 0x008b8b,
  darkgoldenrod: 0xb8860b,
  darkgray: 0xa9a9a9,
  darkgreen: 0x006400,
  darkgrey: 0xa9a9a9,
  darkkhaki: 0xbdb76b,
  darkmagenta: 0x8b008b,
  darkolivegreen: 0x556b2f,
  darkorange: 0xff8c00,
  darkorchid: 0x9932cc,
  darkred: 0x8b0000,
  darksalmon: 0xe9967a,
  darkseagreen: 0x8fbc8f,
  darkslateblue: 0x483d8b,
  darkslategray: 0x2f4f4f,
  darkslategrey: 0x2f4f4f,
  darkturquoise: 0x00ced1,
  darkviolet: 0x9400d3,
  deeppink: 0xff1493,
  deepskyblue: 0x00bfff,
  dimgray: 0x696969,
  dimgrey: 0x696969,
  dodgerblue: 0x1e90ff,
  firebrick: 0xb22222,
  floralwhite: 0xfffaf0,
  forestgreen: 0x228b22,
  fuchsia: 0xff00ff,
  gainsboro: 0xdcdcdc,
  ghostwhite: 0xf8f8ff,
  gold: 0xffd700,
  goldenrod: 0xdaa520,
  gray: 0x808080,
  green: 0x008000,
  greenyellow: 0xadff2f,
  grey: 0x808080,
  honeydew: 0xf0fff0,
  hotpink: 0xff69b4,
  indianred: 0xcd5c5c,
  indigo: 0x4b0082,
  ivory: 0xfffff0,
  khaki: 0xf0e68c,
  lavender: 0xe6e6fa,
  lavenderblush: 0xfff0f5,
  lawngreen: 0x7cfc00,
  lemonchiffon: 0xfffacd,
  lightblue: 0xadd8e6,
  lightcoral: 0xf08080,
  lightcyan: 0xe0ffff,
  lightgoldenrodyellow: 0xfafad2,
  lightgray: 0xd3d3d3,
  lightgreen: 0x90ee90,
  lightgrey: 0xd3d3d3,
  lightpink: 0xffb6c1,
  lightsalmon: 0xffa07a,
  lightseagreen: 0x20b2aa,
  lightskyblue: 0x87cefa,
  lightslategray: 0x778899,
  lightslategrey: 0x778899,
  lightsteelblue: 0xb0c4de,
  lightyellow: 0xffffe0,
  lime: 0x00ff00,
  limegreen: 0x32cd32,
  linen: 0xfaf0e6,
  magenta: 0xff00ff,
  maroon: 0x800000,
  mediumaquamarine: 0x66cdaa,
  mediumblue: 0x0000cd,
  mediumorchid: 0xba55d3,
  mediumpurple: 0x9370db,
  mediumseagreen: 0x3cb371,
  mediumslateblue: 0x7b68ee,
  mediumspringgreen: 0x00fa9a,
  mediumturquoise: 0x48d1cc,
  mediumvioletred: 0xc71585,
  midnightblue: 0x191970,
  mintcream: 0xf5fffa,
  mistyrose: 0xffe4e1,
  moccasin: 0xffe4b5,
  navajowhite: 0xffdead,
  navy: 0x000080,
  oldlace: 0xfdf5e6,
  olive: 0x808000,
  olivedrab: 0x6b8e23,
  orange: 0xffa500,
  orangered: 0xff4500,
  orchid: 0xda70d6,
  palegoldenrod: 0xeee8aa,
  palegreen: 0x98fb98,
  paleturquoise: 0xafeeee,
  palevioletred: 0xdb7093,
  papayawhip: 0xffefd5,
  peachpuff: 0xffdab9,
  peru: 0xcd853f,
  pink: 0xffc0cb,
  plum: 0xdda0dd,
  powderblue: 0xb0e0e6,
  purple: 0x800080,
  rebeccapurple: 0x663399,
  red: 0xff0000,
  rosybrown: 0xbc8f8f,
  royalblue: 0x4169e1,
  saddlebrown: 0x8b4513,
  salmon: 0xfa8072,
  sandybrown: 0xf4a460,
  seagreen: 0x2e8b57,
  seashell: 0xfff5ee,
  sienna: 0xa0522d,
  silver: 0xc0c0c0,
  skyblue: 0x87ceeb,
  slateblue: 0x6a5acd,
  slategray: 0x708090,
  slategrey: 0x708090,
  snow: 0xfffafa,
  springgreen: 0x00ff7f,
  steelblue: 0x4682b4,
  tan: 0xd2b48c,
  teal: 0x008080,
  thistle: 0xd8bfd8,
  tomato: 0xff6347,
  turquoise: 0x40e0d0,
  violet: 0xee82ee,
  wheat: 0xf5deb3,
  white: 0xffffff,
  whitesmoke: 0xf5f5f5,
  yellow: 0xffff00,
  yellowgreen: 0x9acd32,
};

/** Pack four 0–255 channels into the `u32` the encoder writes. */
function rgba(r: number, g: number, b: number, a: number): number {
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, else null. */
function parseHex(hex: string): number | null {
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  if (hex.length === 3 || hex.length === 4) {
    const full = [...hex].map((c) => c + c).join("");
    return parseHex(full);
  }
  if (hex.length === 6) return (parseInt(hex, 16) * 256 + 0xff) >>> 0;
  if (hex.length === 8) return parseInt(hex, 16) >>> 0;
  return null;
}

/** One 0–255 channel: a number, or a percentage of 255; clamped and rounded. */
function channel(text: string): number | null {
  const pct = text.endsWith("%");
  const n = Number(pct ? text.slice(0, -1) : text);
  if (text === "" || !Number.isFinite(n)) return null;
  return Math.round(Math.min(255, Math.max(0, pct ? (n / 100) * 255 : n)));
}

/** The alpha channel: a 0–1 number or a percentage, as 0–255. */
function alpha(text: string | undefined): number | null {
  if (text === undefined) return 255;
  const pct = text.endsWith("%");
  const n = Number(pct ? text.slice(0, -1) : text);
  if (text === "" || !Number.isFinite(n)) return null;
  return Math.round(Math.min(1, Math.max(0, pct ? n / 100 : n)) * 255);
}

/** The arguments of `rgb(…)` / `rgba(…)`: comma-separated, or space-separated with `/ alpha`. */
function functionArgs(body: string): string[] | null {
  if (body.includes(",")) return body.split(",").map((s) => s.trim());
  const [rgb, a, ...rest] = body.split("/").map((s) => s.trim());
  if (rest.length > 0) return null;
  const parts = rgb.split(/\s+/).filter((s) => s !== "");
  return a === undefined ? parts : [...parts, a];
}

/** `rgb(…)` / `rgba(…)`, else null. */
function parseFunction(text: string): number | null {
  const m = /^rgba?\(\s*(.*?)\s*\)$/.exec(text);
  if (!m) return null;
  const args = functionArgs(m[1]);
  if (!args || args.length < 3 || args.length > 4) return null;
  const [r, g, b] = args.slice(0, 3).map(channel);
  const a = alpha(args[3]);
  if (r === null || g === null || b === null || a === null) return null;
  return rgba(r, g, b, a);
}

/**
 * A colour string as NTB1's `u32` RGBA (red in the high byte, straight alpha), or null when it is
 * not one this encoder understands.
 *
 * @param value A React Native colour (`"tomato"`, `"#0af"`, `"rgba(0, 0, 0, 0.5)"`, …).
 * @returns The packed colour, or null.
 *
 * @example
 * ```ts
 * import { parseColor } from "denext/gpui";
 *
 * parseColor("#ff000080"); // 0xff000080
 * parseColor("rgb(0 0 255 / 50%)"); // 0x0000ff80
 * ```
 */
export function parseColor(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text === "transparent") return 0;
  if (text.startsWith("#")) return parseHex(text.slice(1));
  if (text.startsWith("rgb")) return parseFunction(text);
  const named = NAMED[text];
  return named === undefined ? null : (named * 256 + 0xff) >>> 0;
}
