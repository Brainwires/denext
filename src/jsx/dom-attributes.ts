// React DOM's prop → attribute table and inline-style serialization, shared by the SSR
// serializer (`render-to-string.ts`) and the client reconciler (`client/dom-props.ts`).
//
// The reference is React 19's server config (`ReactFizzConfigDOM` `pushAttribute` /
// `pushStyleAttribute`) plus `shared/getAttributeAlias` and `shared/isUnitlessNumber`.
// This module is a leaf: tables and pure string functions, no imports.

/**
 * Props React emits as a present-or-absent boolean attribute (`disabled=""`), mapped to the
 * attribute name. React keeps the prop's own spelling (`readOnly=""`, `noValidate=""`) —
 * HTML attribute names are case-insensitive — and lowercases only `autoFocus`, `multiple`
 * and `muted`. `checked`/`selected` come from React's `<input>`/`<option>` handling.
 */
const BOOLEAN_PROPS: ReadonlyMap<string, string> = new Map([
  ...[
    "allowFullScreen",
    "async",
    "autoPlay",
    "checked",
    "controls",
    "default",
    "defer",
    "disabled",
    "disablePictureInPicture",
    "disableRemotePlayback",
    "formNoValidate",
    "hidden",
    "inert",
    "itemScope",
    "loop",
    "noModule",
    "noValidate",
    "open",
    "playsInline",
    "readOnly",
    "required",
    "reversed",
    "scoped",
    "seamless",
    "selected",
  ].map((p) => [p, p] as const),
  ["autoFocus", "autofocus"],
  ["multiple", "multiple"],
  ["muted", "muted"],
]);

/** The attribute a React boolean prop renders as, or undefined when `prop` is not one. */
export function booleanAttrName(prop: string): string | undefined {
  return BOOLEAN_PROPS.get(prop);
}

/**
 * Props React renames (`getAttributeAlias` plus the `pushAttribute` special cases): the HTML
 * renames, the `xlink:`/`xml:`/`xmlns:` namespaced SVG attributes, and the hyphenated SVG
 * presentation attributes. Everything else is emitted as written (`maxLength`,
 * `contentEditable` and `autoComplete` stay camelCased, as React leaves them).
 */
const ATTR_ALIASES: Readonly<Record<string, string>> = {
  className: "class",
  htmlFor: "for",
  httpEquiv: "http-equiv",
  acceptCharset: "accept-charset",
  tabIndex: "tabindex",
  crossOrigin: "crossorigin",
  xlinkActuate: "xlink:actuate",
  xlinkArcrole: "xlink:arcrole",
  xlinkHref: "xlink:href",
  xlinkRole: "xlink:role",
  xlinkShow: "xlink:show",
  xlinkTitle: "xlink:title",
  xlinkType: "xlink:type",
  xmlBase: "xml:base",
  xmlLang: "xml:lang",
  xmlSpace: "xml:space",
  xmlnsXlink: "xmlns:xlink",
};

/** SVG presentation attributes React hyphenates (`strokeWidth` → `stroke-width`). */
const HYPHENATED_SVG = new Set([
  "accentHeight",
  "alignmentBaseline",
  "arabicForm",
  "baselineShift",
  "capHeight",
  "clipPath",
  "clipRule",
  "colorInterpolation",
  "colorInterpolationFilters",
  "colorProfile",
  "colorRendering",
  "dominantBaseline",
  "enableBackground",
  "fillOpacity",
  "fillRule",
  "floodColor",
  "floodOpacity",
  "fontFamily",
  "fontSize",
  "fontSizeAdjust",
  "fontStretch",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "glyphName",
  "glyphOrientationHorizontal",
  "glyphOrientationVertical",
  "horizAdvX",
  "horizOriginX",
  "imageRendering",
  "letterSpacing",
  "lightingColor",
  "markerEnd",
  "markerMid",
  "markerStart",
  "overlinePosition",
  "overlineThickness",
  "paintOrder",
  "pointerEvents",
  "renderingIntent",
  "shapeRendering",
  "stopColor",
  "stopOpacity",
  "strikethroughPosition",
  "strikethroughThickness",
  "strokeDasharray",
  "strokeDashoffset",
  "strokeLinecap",
  "strokeLinejoin",
  "strokeMiterlimit",
  "strokeOpacity",
  "strokeWidth",
  "textAnchor",
  "textDecoration",
  "textRendering",
  "transformOrigin",
  "underlinePosition",
  "underlineThickness",
  "unicodeBidi",
  "unicodeRange",
  "unitsPerEm",
  "vAlphabetic",
  "vHanging",
  "vIdeographic",
  "vMathematical",
  "vectorEffect",
  "vertAdvY",
  "vertOriginX",
  "vertOriginY",
  "wordSpacing",
  "writingMode",
  "xHeight",
]);

/**
 * The attribute name React renders `prop` as, or undefined when React emits the prop as
 * written. A renamed prop is a string attribute: React drops a boolean value for it.
 */
export function aliasedAttrName(prop: string): string | undefined {
  const alias = ATTR_ALIASES[prop];
  if (alias !== undefined) return alias;
  return HYPHENATED_SVG.has(prop)
    ? prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
    : undefined;
}

/** Props React writes as plain strings or URLs, never by presence: a boolean value is dropped. */
const STRING_ONLY_PROPS = new Set([
  "dir",
  "role",
  "viewBox",
  "width",
  "height",
  "src",
  "href",
  "action",
  "formAction",
]);

/** Whether React omits `prop` when its value is a boolean (a renamed or string-only prop). */
export function dropsBooleanValue(prop: string): boolean {
  return STRING_ONLY_PROPS.has(prop) || aliasedAttrName(prop) !== undefined;
}

/**
 * Enumerated attributes React serializes as the strings `"true"`/`"false"` rather than by
 * presence (lowercased names), plus every `aria-*`/`data-*`. `autocapitalize` is a denext
 * addition kept from earlier releases.
 */
const BOOLEANISH_ATTRS = new Set([
  "contenteditable",
  "draggable",
  "spellcheck",
  "value",
  "autoreverse",
  "externalresourcesrequired",
  "focusable",
  "preservealpha",
  "autocapitalize",
]);

/** Whether a boolean value for attribute `name` renders as `"true"`/`"false"`. */
export function isBooleanishAttr(name: string): boolean {
  const lower = name.toLowerCase();
  return BOOLEANISH_ATTRS.has(lower) || lower.startsWith("aria-") || lower.startsWith("data-");
}

/**
 * Whether React omits a non-boolean `value` for `prop`: `cols`/`rows`/`size`/`span` must be
 * a number ≥ 1 and `rowSpan`/`start` a number, and an empty `src`/`href` is dropped (it
 * would re-request the page).
 */
export function omitsAttrValue(prop: string, value: unknown): boolean {
  if (prop === "cols" || prop === "rows" || prop === "size" || prop === "span") {
    return isNaN(value as number) || !((value as number) >= 1);
  }
  if (prop === "rowSpan" || prop === "start") return isNaN(value as number);
  return value === "" && (prop === "src" || prop === "href");
}

/**
 * Style properties that take a unitless number (React's `isUnitlessNumber`, keyed by the
 * style-object key): a raw number is NOT given a `px` suffix.
 */
const UNITLESS_STYLE = new Set([
  "animationIterationCount",
  "aspectRatio",
  "borderImageOutset",
  "borderImageSlice",
  "borderImageWidth",
  "boxFlex",
  "boxFlexGroup",
  "boxOrdinalGroup",
  "columnCount",
  "columns",
  "flex",
  "flexGrow",
  "flexPositive",
  "flexShrink",
  "flexNegative",
  "flexOrder",
  "gridArea",
  "gridRow",
  "gridRowEnd",
  "gridRowSpan",
  "gridRowStart",
  "gridColumn",
  "gridColumnEnd",
  "gridColumnSpan",
  "gridColumnStart",
  "fontWeight",
  "lineClamp",
  "lineHeight",
  "opacity",
  "order",
  "orphans",
  "scale",
  "tabSize",
  "widows",
  "zIndex",
  "zoom",
  "fillOpacity",
  "floodOpacity",
  "stopOpacity",
  "strokeDasharray",
  "strokeDashoffset",
  "strokeMiterlimit",
  "strokeOpacity",
  "strokeWidth",
  "MozAnimationIterationCount",
  "MozBoxFlex",
  "MozBoxFlexGroup",
  "MozLineClamp",
  "msAnimationIterationCount",
  "msFlex",
  "msZoom",
  "msFlexGrow",
  "msFlexNegative",
  "msFlexOrder",
  "msFlexPositive",
  "msFlexShrink",
  "msGridColumn",
  "msGridColumnSpan",
  "msGridRow",
  "msGridRowSpan",
  "WebkitAnimationIterationCount",
  "WebkitBoxFlex",
  "WebKitBoxFlexGroup",
  "WebkitBoxOrdinalGroup",
  "WebkitColumnCount",
  "WebkitColumns",
  "WebkitFlex",
  "WebkitFlexGrow",
  "WebkitFlexPositive",
  "WebkitFlexShrink",
  "WebkitLineClamp",
]);

/**
 * A style-object key as its CSS property name (React's `hyphenateStyleName`): custom
 * properties (`--x`) as written; otherwise `marginTop` → `margin-top`, `WebkitTransform` →
 * `-webkit-transform`, `msTransition` → `-ms-transition`.
 */
export function cssPropertyName(prop: string): string {
  if (prop.startsWith("--")) return prop;
  return prop.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^ms-/, "-ms-");
}

/**
 * A style value as CSS text, or null when React skips the property (`null`/`undefined`,
 * a boolean, or `""`). A non-zero number gets `px` unless the property is unitless or
 * custom; strings are trimmed.
 */
export function cssPropertyValue(prop: string, value: unknown): string | null {
  if (value == null || typeof value === "boolean" || value === "") return null;
  if (typeof value === "number" && value !== 0 && !prop.startsWith("--")) {
    return UNITLESS_STYLE.has(prop) ? String(value) : `${value}px`;
  }
  return String(value).trim();
}

/**
 * Serialize a style object (`{ marginTop: 4 }`) to CSS text as React's server does:
 * `name:value` pairs joined by `;` with no trailing separator, skipped values omitted.
 */
export function serializeStyle(style: Record<string, unknown>): string {
  let css = "";
  const keys = Object.keys(style);
  for (let i = 0; i < keys.length; i++) {
    const prop = keys[i];
    const value = cssPropertyValue(prop, style[prop]);
    if (value === null) continue;
    css += `${css === "" ? "" : ";"}${cssPropertyName(prop)}:${value}`;
  }
  return css;
}
