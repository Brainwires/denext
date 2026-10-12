// Option validation shared by the plugin's services.

/**
 * `value` as a positive integer, or `fallback` when it is not set.
 *
 * @param value The configured value.
 * @param fallback The default.
 * @param name The option, as an error names it (`realtime(): maxSubscribers`).
 * @returns The value.
 * @throws {TypeError} For anything but a positive safe integer.
 */
export function positiveOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}
