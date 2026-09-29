/**
 * The date / time input the date-picker stand-ins share (`datetimepicker.ts`,
 * `date-picker.ts`): a `Date` as the value of an `<input type="date" | "time" |
 * "datetime-local">` and back, and a modal dialog around such an input for the pickers that
 * open as a dialog (Android's `DateTimePickerAndroid`, `react-native-date-picker`'s `modal`).
 * Internal: not an entrypoint. Nothing here runs at import time.
 *
 * @module
 */

/** Which parts of a date a picker edits. */
export type DateInputMode = "date" | "time" | "datetime";

/** The `<input type>` for a mode. */
export function inputType(mode: DateInputMode): "date" | "time" | "datetime-local" {
  return mode === "datetime" ? "datetime-local" : mode;
}

/** `n` as two digits. */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * `date`'s wall-clock fields: local time, or UTC shifted by `offsetMinutes` when it is given
 * (a picker's `timeZoneOffsetInMinutes`).
 */
function fields(date: Date, offsetMinutes?: number) {
  if (offsetMinutes === undefined) {
    return {
      y: date.getFullYear(),
      mo: date.getMonth() + 1,
      d: date.getDate(),
      h: date.getHours(),
      mi: date.getMinutes(),
    };
  }
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  return {
    y: shifted.getUTCFullYear(),
    mo: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
    mi: shifted.getUTCMinutes(),
  };
}

/**
 * `date` as the value of an input of `mode` (`2026-09-27`, `14:05`, `2026-09-27T14:05`), or
 * `""` for an invalid or absent date.
 *
 * @param date The date.
 * @param mode The picker mode.
 * @param offsetMinutes A fixed UTC offset to show the date in (default: local time).
 */
export function toInputValue(
  date: Date | undefined | null,
  mode: DateInputMode,
  offsetMinutes?: number,
): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const f = fields(date, offsetMinutes);
  const day = `${String(f.y).padStart(4, "0")}-${pad(f.mo)}-${pad(f.d)}`;
  const time = `${pad(f.h)}:${pad(f.mi)}`;
  return mode === "date" ? day : mode === "time" ? time : `${day}T${time}`;
}

/**
 * The date an input of `mode` holds, keeping the parts it does not edit from `base` (a time
 * input keeps `base`'s day; a date input keeps its time of day), or null when the input is
 * empty or malformed.
 *
 * @param value The input's value.
 * @param mode The picker mode.
 * @param base The picker's current date.
 * @param offsetMinutes A fixed UTC offset the value is in (default: local time).
 */
export function fromInputValue(
  value: string,
  mode: DateInputMode,
  base: Date,
  offsetMinutes?: number,
): Date | null {
  const b = fields(Number.isNaN(base.getTime()) ? new Date(0) : base, offsetMinutes);
  let y = b.y, mo = b.mo, d = b.d, h = b.h, mi = b.mi;
  const day = /^(\d{4,})-(\d{2})-(\d{2})/.exec(value);
  const time = /(?:^|T)(\d{2}):(\d{2})/.exec(value);
  if (mode !== "time") {
    if (!day) return null;
    [y, mo, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
  }
  if (mode !== "date") {
    if (!time) return null;
    [h, mi] = [Number(time[1]), Number(time[2])];
  }
  const seconds = Number.isNaN(base.getTime()) ? 0 : base.getSeconds();
  if (offsetMinutes === undefined) return new Date(y, mo - 1, d, h, mi, seconds);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, seconds) - offsetMinutes * 60_000);
}

/** The input attributes for a picker's limits. */
export function inputLimits(
  mode: DateInputMode,
  minimumDate: Date | undefined,
  maximumDate: Date | undefined,
  minuteInterval: number | undefined,
  offsetMinutes?: number,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const min = toInputValue(minimumDate, mode, offsetMinutes);
  const max = toInputValue(maximumDate, mode, offsetMinutes);
  if (min) out.min = min;
  if (max) out.max = max;
  if (mode !== "date" && minuteInterval && minuteInterval > 1) out.step = minuteInterval * 60;
  return out;
}

/** Clamp `date` into `[min, max]`. */
export function clampDate(date: Date, min?: Date, max?: Date): Date {
  if (min && date.getTime() < min.getTime()) return new Date(min.getTime());
  if (max && date.getTime() > max.getTime()) return new Date(max.getTime());
  return date;
}

/** What {@linkcode openDateDialog} shows and reports. */
export interface DateDialogOptions {
  /** The picker mode. */
  mode: DateInputMode;
  /** The starting date. */
  value: Date;
  /** The earliest date. */
  minimumDate?: Date;
  /** The latest date. */
  maximumDate?: Date;
  /** The minute step. */
  minuteInterval?: number;
  /** A fixed UTC offset to edit in. */
  offsetMinutes?: number;
  /** The dialog's title. */
  title?: string | null;
  /** The confirm button's label (default `OK`). */
  confirmText?: string;
  /** The cancel button's label (default `Cancel`). */
  cancelText?: string;
  /** A third button's label (Android's neutral button), when wanted. */
  neutralText?: string;
  /** `dark` draws the dialog dark. */
  theme?: "light" | "dark";
  /** The confirmed date. */
  onConfirm(date: Date): void;
  /** Cancelled (the cancel button, Escape, or a tap on the backdrop). */
  onCancel(): void;
  /** The neutral button. */
  onNeutral?(): void;
}

/** The slice of a DOM element the dialog builds with. */
interface El {
  style: { cssText: string };
  value?: string;
  type?: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  appendChild(child: unknown): unknown;
  addEventListener(type: string, fn: (event: { key?: string; target?: unknown }) => void): void;
  remove(): void;
  focus?(): void;
}

/**
 * Show a modal dialog with a date / time input and confirm / cancel buttons, appended to
 * `document.body`; exactly one of the callbacks runs, then the dialog is removed. Does
 * nothing (and returns a no-op) without a document.
 *
 * @param options What to show and whom to tell.
 * @returns A function that closes the dialog (idempotent): as cancelled, or with no callback
 * at all when `silent` (the picker unmounted).
 */
export function openDateDialog(options: DateDialogOptions): (silent?: boolean) => void {
  const doc = (globalThis as { document?: { body?: El; createElement(tag: string): El } })
    .document;
  if (!doc?.body) return () => {};
  const dark = options.theme === "dark";
  const make = (tag: string, css: string, text?: string): El => {
    const el = doc.createElement(tag);
    el.style.cssText = css;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const backdrop = make(
    "div",
    "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;" +
      "justify-content:center;background:rgba(0,0,0,0.4)",
  );
  backdrop.setAttribute("data-denext-date-dialog", "");
  const panel = make(
    "div",
    "min-width:260px;max-width:90vw;padding:20px;border-radius:14px;display:flex;" +
      "flex-direction:column;gap:14px;font:16px system-ui,sans-serif;" +
      (dark ? "background:#2c2c2e;color:#fff" : "background:#fff;color:#111"),
  );
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  if (options.title) panel.appendChild(make("div", "font-weight:600", options.title));
  const input = make("input", "font:inherit;padding:8px;color-scheme:" + (dark ? "dark" : "light"));
  input.type = inputType(options.mode);
  input.setAttribute("type", inputType(options.mode));
  const limits = inputLimits(
    options.mode,
    options.minimumDate,
    options.maximumDate,
    options.minuteInterval,
    options.offsetMinutes,
  );
  for (const [k, v] of Object.entries(limits)) input.setAttribute(k, String(v));
  input.value = toInputValue(options.value, options.mode, options.offsetMinutes);
  panel.appendChild(input);
  const row = make("div", "display:flex;justify-content:flex-end;gap:8px");
  panel.appendChild(row);
  backdrop.appendChild(panel);
  let open = true;
  const close = (run: () => void) => {
    if (!open) return;
    open = false;
    backdrop.remove();
    run();
  };
  const button = (label: string, run: () => void, name: string) => {
    const b = make(
      "button",
      "font:inherit;padding:6px 12px;border:0;background:none;" +
        "color:" + (dark ? "#0a84ff" : "#007aff"),
      label,
    );
    b.setAttribute("type", "button");
    b.setAttribute("data-action", name);
    b.addEventListener("click", () => close(run));
    row.appendChild(b);
  };
  if (options.neutralText !== undefined && options.onNeutral) {
    button(options.neutralText, options.onNeutral, "neutral");
  }
  button(options.cancelText ?? "Cancel", options.onCancel, "cancel");
  button(options.confirmText ?? "OK", () => {
    const next = fromInputValue(
      input.value ?? "",
      options.mode,
      options.value,
      options.offsetMinutes,
    );
    options.onConfirm(clampDate(next ?? options.value, options.minimumDate, options.maximumDate));
  }, "confirm");
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close(options.onCancel);
  });
  backdrop.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close(options.onCancel);
  });
  doc.body.appendChild(backdrop);
  input.focus?.();
  return (silent) => close(silent ? () => {} : options.onCancel);
}
