/**
 * `@expo/ui/community/masked-view` for denext: the same `MaskedView` React Native mode gives
 * `@react-native-masked-view/masked-view` (the two are API-compatible). A gradient mask becomes
 * a CSS `mask-image`, a `Text` mask over a gradient becomes gradient text, and any other mask
 * renders the children unmasked with a one-time warning. `@expo/ui`'s own web build draws no
 * mask at all.
 *
 * @example
 * ```ts
 * import MaskedView from "denext/expo/ui/community/masked-view";
 * import { h } from "denext/jsx-runtime";
 *
 * h(MaskedView, { maskElement: h("div", { colors: ["black", "transparent"] }) }, "Fades out");
 * ```
 *
 * @module
 */

export {
  MaskedView,
  MaskedView as default,
  type MaskedViewProps,
} from "../react-native-compat/masked-view.ts";
