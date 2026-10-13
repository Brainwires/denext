/**
 * React Native's `TextInput` for React Native mode: react-native-web's `<input>` /
 * `<textarea>` keep two browser defaults a React Native text input does not have, and drop
 * several React Native props.
 *
 * - The focus ring: React Native draws no outline (`outlineWidth` 0, `outlineStyle` solid), so
 *   the input gets those as its base style; an app's own `outline*` style or Tailwind class
 *   still applies on top.
 * - A wrapping placeholder: React Native lays the placeholder out on one line, so a long one in
 *   a `multiline` input that is a line tall (a text field docked above the keyboard) does not wrap onto a clipped second
 *   line; it is cut with an ellipsis (`white-space: nowrap; text-overflow: ellipsis`).
 * - Autofill: React Native's `autoComplete` values that differ from the HTML tokens
 *   (`"password-new"`, `"sms-otp"`, `"name-given"`, `"postal-address-region"`, …) and iOS's
 *   `textContentType` (`"oneTimeCode"`, `"emailAddress"`, `"newPassword"`, …) become the HTML
 *   `autocomplete` token the WebView's password manager and one-time-code autofill read
 *   ({@linkcode htmlAutoComplete}).
 * - `submitBehavior` (`"submit"`, `"blurAndSubmit"`, `"newline"`), which replaced
 *   `blurOnSubmit` in React Native 0.73, including a `multiline` input that submits on Enter
 *   without losing focus.
 * - `onEndEditing`, called with the text when the input loses focus (before `onBlur`).
 * - `cursorColor` / `selectionColor`: the caret colour (`cursorColor`, else `selectionColor`)
 *   and the selection highlight (`selectionColor`, drawn translucent like the platform's).
 *
 * React Native mode's build wraps react-native-web's `TextInput` with
 * {@linkcode withTextInputDefaults}.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeType } from "../jsx/types.ts";

/** The class the placeholder rule targets. */
export const TEXT_INPUT_CLASS = "denext-rn-textinput";

/** React Native's outline: none drawn, but an app's `outlineWidth` alone shows a solid one. */
const BASE_STYLE = { outlineWidth: 0, outlineStyle: "solid" };

/** The class as react-native-web's compiled-style object (`$$css`), merged into `className`. */
const CLASS_STYLE = { $$css: true, denextTextInput: TEXT_INPUT_CLASS };

/** The class an input with a `selectionColor` also gets. */
export const SELECTION_CLASS = "denext-rn-selection";

/** The custom property carrying `selectionColor` to the `::selection` rule. */
const SELECTION_VAR = "--denext-rn-selection";

/** The selection class as a compiled-style object. */
const SELECTION_CLASS_STYLE = { $$css: true, denextSelection: SELECTION_CLASS };

/**
 * The stylesheet the classes need (the placeholder and the selection are pseudo-elements: no
 * inline style). The highlight is the colour at 40%, as the platforms tint theirs.
 */
const RULE = `.${TEXT_INPUT_CLASS}::placeholder{white-space:nowrap;overflow:hidden;` +
  `text-overflow:ellipsis}` +
  `.${SELECTION_CLASS}::selection{background-color:` +
  `color-mix(in srgb,var(${SELECTION_VAR}) 40%,transparent)}`;

/** The documents that have the rule. */
const styled = new WeakSet<object>();

/** Add the placeholder rule to the document once. */
function ensureRule(): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.head || typeof doc.createElement !== "function" || styled.has(doc)) return;
  styled.add(doc);
  const id = "denext-rn-textinput-style";
  if (doc.getElementById?.(id)) return;
  const el = doc.createElement("style");
  el.id = id;
  el.textContent = RULE;
  doc.head.appendChild(el);
}

/**
 * React Native's `autoComplete` values whose HTML `autocomplete` token is spelled differently
 * (the rest, `"email"`, `"username"`, `"cc-number"`, …, are the same in both).
 */
const AUTOCOMPLETE_TOKENS: Readonly<Record<string, string>> = {
  "birthdate-day": "bday-day",
  "birthdate-full": "bday",
  "birthdate-month": "bday-month",
  "birthdate-year": "bday-year",
  "cc-middle-name": "cc-additional-name",
  gender: "sex",
  "name-family": "family-name",
  "name-given": "given-name",
  "name-middle": "additional-name",
  "name-middle-initial": "additional-name",
  "name-prefix": "honorific-prefix",
  "name-suffix": "honorific-suffix",
  password: "current-password",
  "password-new": "new-password",
  "postal-address": "street-address",
  "postal-address-country": "country",
  "postal-address-extended": "address-line2",
  "postal-address-extended-postal-code": "postal-code",
  "postal-address-locality": "address-level2",
  "postal-address-region": "address-level1",
  "sms-otp": "one-time-code",
  "tel-device": "tel",
  "username-new": "username",
};

/** iOS's `textContentType` values and the HTML `autocomplete` token each one means. */
const CONTENT_TYPE_TOKENS: Readonly<Record<string, string>> = {
  none: "off",
  URL: "url",
  addressCity: "address-level2",
  addressState: "address-level1",
  birthdate: "bday",
  birthdateDay: "bday-day",
  birthdateMonth: "bday-month",
  birthdateYear: "bday-year",
  countryName: "country-name",
  creditCardExpiration: "cc-exp",
  creditCardExpirationMonth: "cc-exp-month",
  creditCardExpirationYear: "cc-exp-year",
  creditCardFamilyName: "cc-family-name",
  creditCardGivenName: "cc-given-name",
  creditCardMiddleName: "cc-additional-name",
  creditCardName: "cc-name",
  creditCardNumber: "cc-number",
  creditCardSecurityCode: "cc-csc",
  creditCardType: "cc-type",
  emailAddress: "email",
  familyName: "family-name",
  fullStreetAddress: "street-address",
  givenName: "given-name",
  jobTitle: "organization-title",
  middleName: "additional-name",
  name: "name",
  namePrefix: "honorific-prefix",
  nameSuffix: "honorific-suffix",
  newPassword: "new-password",
  nickname: "nickname",
  oneTimeCode: "one-time-code",
  organizationName: "organization",
  password: "current-password",
  postalCode: "postal-code",
  streetAddressLine1: "address-line1",
  streetAddressLine2: "address-line2",
  sublocality: "address-level3",
  telephoneNumber: "tel",
  username: "username",
};

/**
 * The HTML `autocomplete` token for a React Native text input: its `autoComplete` (React
 * Native's spelling translated), else what its iOS `textContentType` means, else `undefined`
 * (react-native-web's default). A value neither table knows passes through unchanged.
 *
 * @param autoComplete The `autoComplete` prop.
 * @param textContentType The `textContentType` prop.
 * @returns The token, or `undefined`.
 */
export function htmlAutoComplete(
  autoComplete: unknown,
  textContentType: unknown,
): string | undefined {
  if (typeof autoComplete === "string" && autoComplete !== "") {
    return AUTOCOMPLETE_TOKENS[autoComplete] ?? autoComplete;
  }
  if (typeof textContentType === "string" && Object.hasOwn(CONTENT_TYPE_TOKENS, textContentType)) {
    return CONTENT_TYPE_TOKENS[textContentType];
  }
  return undefined;
}

/** The props the wrapper reads (the rest go to react-native-web's `TextInput`). */
interface TextInputProps {
  readonly style?: unknown;
  readonly multiline?: boolean;
  readonly autoComplete?: unknown;
  readonly textContentType?: unknown;
  readonly submitBehavior?: "submit" | "blurAndSubmit" | "newline";
  readonly blurOnSubmit?: boolean;
  readonly onSubmitEditing?: (e: TextInputKeyEvent) => void;
  readonly onKeyPress?: (e: TextInputKeyEvent) => void;
  readonly onEndEditing?: (e: TextInputFocusEvent) => void;
  readonly onBlur?: (e: TextInputFocusEvent) => void;
  readonly cursorColor?: string | null;
  readonly selectionColor?: string | null;
  readonly [prop: string]: unknown;
}

/** react-native-web's key event (a DOM `keydown`). */
interface TextInputKeyEvent {
  readonly key?: string;
  readonly shiftKey?: boolean;
  readonly target?: { value?: string };
  readonly nativeEvent?: { isComposing?: boolean; keyCode?: number; text?: string };
  preventDefault?(): void;
  isDefaultPrevented?(): boolean;
}

/** react-native-web's blur event. */
interface TextInputFocusEvent {
  readonly target?: { value?: string };
  readonly nativeEvent?: { text?: string };
}

/**
 * The `blurOnSubmit` react-native-web understands for a `submitBehavior` (React Native 0.73+):
 * `"blurAndSubmit"` blurs, `"submit"` keeps focus, and `"newline"` blurs a single-line input
 * (React Native treats it as `"blurAndSubmit"` there) and lets a multiline one take the newline.
 *
 * @param submitBehavior The prop.
 * @param multiline Whether the input is multiline.
 * @returns The `blurOnSubmit` value, or `undefined` for none.
 */
export function blurOnSubmitFor(
  submitBehavior: TextInputProps["submitBehavior"],
  multiline: boolean,
): boolean | undefined {
  if (submitBehavior === "blurAndSubmit") return true;
  if (submitBehavior === "submit") return false;
  if (submitBehavior === "newline") return !multiline;
  return undefined;
}

/** Whether a key event is a plain Enter that react-native-web would treat as a submit. */
function isSubmitKey(e: TextInputKeyEvent): boolean {
  const native = e.nativeEvent ?? {};
  return e.key === "Enter" && !e.shiftKey && !native.isComposing && native.keyCode !== 229 &&
    !e.isDefaultPrevented?.();
}

/** The props React Native has and react-native-web does not take. */
const RN_ONLY_PROPS = [
  "textContentType",
  "submitBehavior",
  "onEndEditing",
  "cursorColor",
  "selectionColor",
] as const;

/**
 * The props react-native-web's `TextInput` gets for a React Native `TextInput`'s (see the
 * module docs). Exported for the tests.
 *
 * @param props The app's props.
 * @returns The props to pass on.
 */
export function textInputProps(props: TextInputProps): Record<string, unknown> {
  const out: Record<string, unknown> = { ...props };
  for (const key of RN_ONLY_PROPS) delete out[key];
  const multiline = props.multiline === true;
  const autoComplete = htmlAutoComplete(props.autoComplete, props.textContentType);
  if (autoComplete !== undefined) out.autoComplete = autoComplete;
  const blur = blurOnSubmitFor(props.submitBehavior, multiline);
  if (blur !== undefined) out.blurOnSubmit = blur;
  const { onKeyPress, onSubmitEditing } = props;
  if (props.submitBehavior === "submit" && multiline && onSubmitEditing) {
    // react-native-web submits a multiline input only when it also blurs: submit here and
    // mark the Enter handled, so it neither inserts a newline nor blurs.
    out.onKeyPress = (e: TextInputKeyEvent) => {
      onKeyPress?.(e);
      if (!isSubmitKey(e)) return;
      e.preventDefault?.();
      if (e.nativeEvent) e.nativeEvent.text = e.target?.value;
      onSubmitEditing(e);
    };
  }
  const { onEndEditing, onBlur } = props;
  if (onEndEditing) {
    out.onBlur = (e: TextInputFocusEvent) => {
      if (e.nativeEvent) e.nativeEvent.text = e.target?.value;
      onEndEditing(e);
      onBlur?.(e);
    };
  }
  const caret = props.cursorColor ?? props.selectionColor;
  const selection = props.selectionColor;
  const extra: Record<string, unknown> = {};
  if (caret) extra.caretColor = caret;
  if (selection) extra[SELECTION_VAR] = selection;
  out.style = [
    BASE_STYLE,
    CLASS_STYLE,
    selection ? SELECTION_CLASS_STYLE : null,
    props.style,
    Object.keys(extra).length > 0 ? extra : null,
  ].filter((s) => s !== null);
  return out;
}

/**
 * react-native-web's `TextInput` with React Native's look and props (see the module docs). Its
 * statics (`State`, …) are kept.
 *
 * @param TextInput react-native-web's `TextInput`.
 * @returns The wrapped component.
 */
export function withTextInputDefaults(TextInput: VNodeType): VNodeType {
  function RNTextInput(props: TextInputProps): VNode {
    ensureRule();
    return h(TextInput, textInputProps(props));
  }
  const statics = Object.fromEntries(
    Object.entries(TextInput as unknown as Record<string, unknown>)
      .filter(([k]) => k !== "$$typeof" && k !== "render"),
  );
  return Object.assign(RNTextInput, statics, { displayName: "TextInput" }) as unknown as VNodeType;
}
