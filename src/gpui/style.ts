/**
 * React Native styles to NTB1 style props: {@linkcode flattenStyle} merges a style array (nested,
 * with falsy entries and registered numeric ids) the way React Native's `flattenStyle` does,
 * {@linkcode resolveStyle} expands the shorthands the id table has no slot for (`margin`,
 * `marginHorizontal` / `Vertical`, `marginStart` / `End`, the same for `padding`, `borderWidth`,
 * `borderColor`, `borderRadius`) into per-side and per-corner props with React Native's
 * precedence (a side beats an axis, an axis beats the whole), and encodes each value with its
 * tag. {@linkcode diffStyle} gives the SET_STYLE entries between two resolved styles, with
 * `unset` for a prop that went away.
 *
 * Props outside the v1 table (`transform`, the shadows, …) are dropped.
 *
 * @module
 */

import { ENUM, STYLE_PROP } from "./props.generated.ts";
import { type NtValue, sameValue, UNSET } from "./encoder.ts";
import { parseColor } from "./color.ts";

/** A React Native style: an object, a registered id, an array of styles, or a falsy value. */
export type StyleProp<T = Record<string, unknown>> =
  | T
  | number
  | false
  | null
  | undefined
  | ReadonlyArray<StyleProp<T>>;

/** A style prop's name in the v1 table. */
type StylePropName = keyof typeof STYLE_PROP;

/** Styles registered under a numeric id (React Native's pre-0.66 `StyleSheet` ids). */
const registry = new Map<number, Readonly<Record<string, unknown>>>();
let lastStyleId = 0;

/**
 * Register `style` under a new numeric id, which {@linkcode flattenStyle} resolves (React
 * Native's `ReactNativePropRegistry`, which older `StyleSheet.create` builds returned ids from).
 *
 * @param style The style object.
 * @returns Its id.
 */
export function registerStyle(style: Readonly<Record<string, unknown>>): number {
  registry.set(++lastStyleId, style);
  return lastStyleId;
}

/**
 * Merge a style into one object, as React Native's `StyleSheet.flatten`: later entries win
 * (an explicit `undefined` too), falsy entries are skipped, nested arrays are walked and a
 * number is looked up among the registered styles.
 *
 * @param style The style.
 * @returns The merged style, or `undefined` for none.
 */
export function flattenStyle(style: unknown): Record<string, unknown> | undefined {
  if (style === null || style === undefined || style === false) return undefined;
  if (typeof style === "number") return registry.get(style) as Record<string, unknown>;
  if (Array.isArray(style)) {
    const out: Record<string, unknown> = {};
    let any = false;
    for (const item of style) {
      const flat = flattenStyle(item);
      if (!flat) continue;
      any = true;
      for (const key in flat) out[key] = flat[key];
    }
    return any ? out : undefined;
  }
  return typeof style === "object" ? style as Record<string, unknown> : undefined;
}

/** A shorthand's longhands and its precedence (higher wins; a longhand itself is 3). */
type Shorthand = readonly [readonly StylePropName[], number];

const SIDES = ["Top", "Right", "Bottom", "Left"] as const;

/** `margin` / `padding` and their axis and logical forms. */
function boxShorthands(base: "margin" | "padding"): Record<string, Shorthand> {
  const side = (s: string) => `${base}${s}` as StylePropName;
  return {
    [base]: [SIDES.map(side), 0],
    [`${base}Horizontal`]: [[side("Left"), side("Right")], 1],
    [`${base}Vertical`]: [[side("Top"), side("Bottom")], 1],
    // Yoga: a start / end edge wins over left / right (left-to-right layout).
    [`${base}Start`]: [[side("Left")], 4],
    [`${base}End`]: [[side("Right")], 4],
  };
}

/** Every shorthand the encoder expands. */
const SHORTHANDS: Readonly<Record<string, Shorthand>> = {
  ...boxShorthands("margin"),
  ...boxShorthands("padding"),
  borderWidth: [SIDES.map((s) => `border${s}Width` as StylePropName), 0],
  borderColor: [SIDES.map((s) => `border${s}Color` as StylePropName), 0],
  borderRadius: [
    [
      "borderTopLeftRadius",
      "borderTopRightRadius",
      "borderBottomRightRadius",
      "borderBottomLeftRadius",
    ],
    0,
  ],
};

/** The precedence of a longhand written directly. */
const LONGHAND = 3;

/**
 * A flattened style with its shorthands expanded: each v1 prop and the raw value that wins it.
 * Unknown keys and `undefined` / `null` values are left out.
 *
 * @param flat A flattened style.
 * @returns The longhands, in table order.
 */
export function expandShorthands(
  flat: Readonly<Record<string, unknown>> | undefined,
): Map<StylePropName, unknown> {
  const won = new Map<StylePropName, { value: unknown; rank: number }>();
  const offer = (name: StylePropName, value: unknown, rank: number) => {
    const held = won.get(name);
    if (!held || rank >= held.rank) won.set(name, { value, rank });
  };
  for (const key in flat) {
    const value = flat[key];
    if (value === undefined || value === null) continue;
    const shorthand = SHORTHANDS[key];
    if (shorthand) { for (const name of shorthand[0]) offer(name, value, shorthand[1]); }
    else if (key in STYLE_PROP) offer(key as StylePropName, value, LONGHAND);
  }
  const out = new Map<StylePropName, unknown>();
  for (const name of Object.keys(STYLE_PROP) as StylePropName[]) {
    const held = won.get(name);
    if (held) out.set(name, held.value);
  }
  return out;
}

/** The colour props. */
const COLOR_PROPS: ReadonlySet<string> = new Set([
  "backgroundColor",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "color",
]);

/** React Native's named font weights. */
const FONT_WEIGHTS: Readonly<Record<string, number>> = {
  normal: 400,
  bold: 700,
  ultralight: 100,
  thin: 100,
  light: 300,
  regular: 400,
  medium: 500,
  semibold: 600,
  condensedbold: 700,
  condensed: 400,
  heavy: 800,
  black: 900,
};

/** `fontWeight`: a number, `"100"`…`"900"` or a named weight, as an `f32`. */
function fontWeight(raw: unknown): NtValue | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(n)) return { tag: "f32", value: n };
  const named = typeof raw === "string" ? FONT_WEIGHTS[raw.toLowerCase()] : undefined;
  return named === undefined ? null : { tag: "f32", value: named };
}

/** `aspectRatio`: a number or a `"w / h"` string, as an `f32`. */
function aspectRatio(raw: unknown): NtValue | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? { tag: "f32", value: raw } : null;
  if (typeof raw !== "string") return null;
  const [w, h] = raw.split("/").map((s) => Number(s.trim()));
  const value = h === undefined ? w : w / h;
  return Number.isFinite(value) ? { tag: "f32", value } : null;
}

/** A length: a number (`f32`), `"auto"`, or `"N%"` (`percent`, N as written). */
function length(raw: unknown): NtValue | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? { tag: "f32", value: raw } : null;
  if (raw === "auto") return { tag: "auto" };
  if (typeof raw === "string" && raw.endsWith("%")) {
    const n = Number(raw.slice(0, -1));
    return raw.length > 1 && Number.isFinite(n) ? { tag: "percent", value: n } : null;
  }
  return null;
}

/**
 * One style prop's value with its tag, or null when the value is not one the prop takes (the
 * prop is then left out).
 *
 * @param name The v1 style prop.
 * @param raw Its React Native value.
 * @returns The encoded value, or null.
 */
export function encodeStyleValue(name: StylePropName, raw: unknown): NtValue | null {
  const enumTable = (ENUM as Record<string, Record<string, number> | undefined>)[name];
  if (enumTable) {
    const value = typeof raw === "string" ? enumTable[raw] : undefined;
    return value === undefined ? null : { tag: "enum", value };
  }
  if (COLOR_PROPS.has(name)) {
    const value = parseColor(raw);
    return value === null ? null : { tag: "color", value };
  }
  if (name === "fontFamily") return typeof raw === "string" ? { tag: "string", value: raw } : null;
  if (name === "fontWeight") return fontWeight(raw);
  if (name === "aspectRatio") return aspectRatio(raw);
  return length(raw);
}

/** A resolved style: each v1 style prop id and its encoded value. */
export type ResolvedStyle = Map<number, NtValue>;

/**
 * A React Native style as the SET_STYLE props it sets: flattened, shorthands expanded, each value
 * encoded (values a prop does not take are left out).
 *
 * @param style The style prop.
 * @returns The props by id.
 */
export function resolveStyle(style: unknown): ResolvedStyle {
  const out: ResolvedStyle = new Map();
  for (const [name, raw] of expandShorthands(flattenStyle(style))) {
    const value = encodeStyleValue(name, raw);
    if (value) out.set(STYLE_PROP[name], value);
  }
  return out;
}

/**
 * The SET_STYLE entries that turn `prev` into `next`: each prop whose value changed, and `unset`
 * for each prop `next` no longer sets.
 *
 * @param prev The style the host has.
 * @param next The style wanted.
 * @returns The entries, by prop id.
 */
export function diffStyle(
  prev: ResolvedStyle,
  next: ResolvedStyle,
): Array<readonly [number, NtValue]> {
  const out: Array<readonly [number, NtValue]> = [];
  for (const [id, value] of next) if (!sameValue(prev.get(id), value)) out.push([id, value]);
  for (const id of prev.keys()) if (!next.has(id)) out.push([id, UNSET]);
  return out.sort((a, b) => a[0] - b[0]);
}
