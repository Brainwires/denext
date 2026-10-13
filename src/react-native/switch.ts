/**
 * React Native's `Switch` props for React Native mode that react-native-web drops:
 *
 * - `ios_backgroundColor`: the track's colour while off, on iOS (and in a browser, where the
 *   switch is drawn as on iOS); an explicit `trackColor.false` wins, and the Android shell
 *   ignores it, as React Native's Android does.
 * - `onChange`: called with `{ nativeEvent: { value } }` before `onValueChange`.
 *
 * React Native mode's build wraps react-native-web's `Switch` with
 * {@linkcode withSwitchProps}.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeType, VProps } from "../jsx/types.ts";
import { nativePlatform } from "../mobile/bridge.ts";

/** The props the wrapper reads (the rest go on). */
interface SwitchProps {
  readonly ios_backgroundColor?: string | null;
  readonly trackColor?: { readonly false?: unknown; readonly true?: unknown } | null;
  readonly onChange?: (event: { nativeEvent: { value: boolean } }) => void;
  readonly onValueChange?: (value: boolean) => void;
  readonly [prop: string]: unknown;
}

/**
 * The props react-native-web's `Switch` gets for a React Native `Switch`'s.
 *
 * @param props The app's props.
 * @param platform The shell's platform (`nativePlatform()`).
 * @returns The props to pass on.
 */
export function switchProps(props: SwitchProps, platform: string): Record<string, unknown> {
  const { ios_backgroundColor: off, onChange, ...rest } = props;
  const out: Record<string, unknown> = rest;
  if (off && platform !== "android" && props.trackColor?.false == null) {
    out.trackColor = { ...props.trackColor, false: off };
  }
  if (onChange) {
    const { onValueChange } = props;
    out.onValueChange = (value: boolean) => {
      onChange({ nativeEvent: { value } });
      onValueChange?.(value);
    };
  }
  return out;
}

/**
 * react-native-web's `Switch` with `ios_backgroundColor` and `onChange` (see the module docs).
 *
 * @param Switch react-native-web's `Switch`.
 * @returns The wrapped `Switch`.
 */
export function withSwitchProps(Switch: VNodeType): VNodeType {
  function RNSwitch(props: SwitchProps): VNode {
    return h(Switch, switchProps(props, nativePlatform()) as VProps);
  }
  return Object.assign(RNSwitch, { displayName: "Switch" }) as unknown as VNodeType;
}
