/**
 * React Native's `StyleSheet.setStyleAttributePreprocessor` for React Native mode, which
 * react-native-web lacks. React Native mode's build adds it to react-native-web's `StyleSheet`
 * ({@linkcode withStyleSheetStatics}) and runs {@linkcode processStyleAttributes} at the top of
 * react-native-web's style `preprocess` step, which every style goes through on its way to CSS:
 * the ones `StyleSheet.create` compiles and the inline ones a component is given. So a
 * registered processor sees each value of its property, as React Native's does when the style
 * reaches the native view, and its result is what the page draws.
 *
 * As in React Native, register processors at startup: `StyleSheet.create` compiles its styles
 * when it is called, so a processor registered after that does not reach them.
 *
 * @module
 */

/** The registered processors, by style property. */
const processors = new Map<string, (value: unknown) => unknown>();

/**
 * React Native's `StyleSheet.setStyleAttributePreprocessor`: run `process` over every value of
 * the style property `property` before it is drawn. A second registration for the same
 * property replaces the first (with a warning, as React Native's development build gives).
 *
 * @param property A style property (`"fontFamily"`, `"color"`, …).
 * @param process The processor: takes the value the app gave, returns the one to draw.
 */
function setStyleAttributePreprocessor(
  property: string,
  process: (nextProp: unknown) => unknown,
): void {
  if (typeof property !== "string" || typeof process !== "function") return;
  const before = processors.get(property);
  if (before && before !== process) {
    console.warn(`Overwriting ${property} style attribute preprocessor`);
  }
  processors.set(property, process);
}

/**
 * `style` with the registered processors applied: a copy when one of its own properties has a
 * processor, else `style` itself (frozen `StyleSheet.create` objects are never written to).
 *
 * @param style One style object (react-native-web's `preprocess` input).
 * @returns The style to preprocess.
 */
export function processStyleAttributes<T>(style: T): T {
  if (processors.size === 0 || style == null || typeof style !== "object") return style;
  let out: Record<string, unknown> | null = null;
  for (const [property, process] of processors) {
    if (!Object.hasOwn(style, property)) continue;
    out ??= { ...(style as Record<string, unknown>) };
    out[property] = process(out[property]);
  }
  return (out ?? style) as T;
}

/**
 * react-native-web's `StyleSheet` with `setStyleAttributePreprocessor` added.
 *
 * @param StyleSheet react-native-web's `StyleSheet`.
 * @returns The same `StyleSheet`.
 */
export function withStyleSheetStatics<T>(StyleSheet: T): T {
  const sheet = StyleSheet as unknown as Record<string, unknown>;
  if ((typeof sheet !== "function" && typeof sheet !== "object") || sheet === null) {
    return StyleSheet;
  }
  sheet.setStyleAttributePreprocessor ??= setStyleAttributePreprocessor;
  return StyleSheet;
}

/** Forget every processor (tests). */
export function resetStyleAttributePreprocessorsForTesting(): void {
  processors.clear();
}
