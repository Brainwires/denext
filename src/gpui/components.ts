/**
 * The React Native primitives `denext/gpui` renders as native tree nodes: `View`, `Text`,
 * `Image`, `ScrollView`, `TextInput` and `Pressable`. `View`, `Text`, `Image` and `TextInput` are
 * host components (each element is one node); `ScrollView` is a scroll node around a content
 * view (React Native's `contentContainerStyle`); `Pressable` adds React Native's `pressed` state
 * for a function `style` or `children`.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { useState } from "../runtime/hooks.ts";
import { dispatched } from "../compat/react-internals.ts";
import type { PressabilityConfig, PressEvent } from "../react-native/pressability.ts";
import type { StyleProp } from "./style.ts";

/** A style prop: an object, a registered id, an array of styles, or a falsy value. */
export type GpuiStyle = StyleProp<Record<string, unknown>>;

/** A primitive as TypeScript sees it (at run time the host ones are element type names). */
export type GpuiComponent<P> = (props: P) => VNode;

/** `onLayout`'s event: the node's frame after layout, when it changed. */
export interface LayoutEvent {
  /** The frame. */
  readonly nativeEvent: {
    /** Position in the parent and size, in logical pixels. */
    readonly layout: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    /** The node's id. */
    readonly target: number;
  };
}

/** `onFocus` / `onBlur`'s event. */
export interface FocusEvent {
  /** The node. */
  readonly nativeEvent: { readonly target: number };
}

/** `onKeyPress`'s event. */
export interface KeyPressEvent {
  /** The key and the modifiers held. */
  readonly nativeEvent: {
    readonly key: string;
    readonly modifiers: unknown;
    readonly target: number;
  };
}

/** The props every primitive takes. */
export interface GpuiViewProps {
  /** The style. */
  readonly style?: GpuiStyle;
  /** The children. */
  readonly children?: VNodeChildren;
  /** The accessibility label (`aria-label` is read too). */
  readonly accessibilityLabel?: string;
  /** React Native's `aria-label`. */
  readonly "aria-label"?: string;
  /** The accessibility role (`role` is read too). */
  readonly accessibilityRole?: string;
  /** React Native's `role`. */
  readonly role?: string;
  /** A test id. */
  readonly testID?: string;
  /** Called with the node's frame after layout, when it changed. */
  readonly onLayout?: (event: LayoutEvent) => void;
  /** The node gained focus. */
  readonly onFocus?: (event: FocusEvent) => void;
  /** The node lost focus. */
  readonly onBlur?: (event: FocusEvent) => void;
  /** A key was pressed while the node had focus. */
  readonly onKeyPress?: (event: KeyPressEvent) => void;
}

/** The press callbacks and timings `Text` and `Pressable` take (React Native's pressability). */
export type GpuiPressProps = Pick<
  PressabilityConfig,
  | "onPress"
  | "onPressIn"
  | "onPressOut"
  | "onLongPress"
  | "delayLongPress"
  | "delayPressIn"
  | "delayPressOut"
  | "minPressDuration"
  | "cancelable"
>;

/** `Text`'s props: a View's, plus presses (nested `Text` elements are spans). */
export interface GpuiTextProps extends GpuiViewProps, GpuiPressProps {}

/** `Image`'s props. */
export interface GpuiImageProps extends GpuiViewProps {
  /** A URL (an imported image is one) or `{ uri }`. */
  readonly source?: string | { readonly uri: string } | ReadonlyArray<{ readonly uri: string }>;
  /** How the image fits its frame. */
  readonly resizeMode?: "cover" | "contain" | "stretch" | "repeat" | "center";
  /** The host decoded the image. */
  readonly onLoad?: (
    event: { readonly nativeEvent: { readonly source: { readonly uri?: string } } },
  ) => void;
  /** The image could not be fetched or decoded. */
  readonly onError?: (event: { readonly nativeEvent: { readonly error: string } }) => void;
  /** After `onLoad` or `onError`. */
  readonly onLoadEnd?: () => void;
}

/** `onScroll`'s event. */
export interface ScrollEvent {
  /** The offset and the content's size. */
  readonly nativeEvent: {
    readonly contentOffset: { readonly x: number; readonly y: number };
    readonly contentSize: { readonly width: number; readonly height: number };
    readonly target: number;
  };
}

/** `ScrollView`'s props. */
export interface GpuiScrollViewProps extends GpuiViewProps {
  /** Scroll sideways (its content lays out in a row). */
  readonly horizontal?: boolean;
  /** Whether the user can scroll it (default true). */
  readonly scrollEnabled?: boolean;
  /** The content view's style. */
  readonly contentContainerStyle?: GpuiStyle;
  /** Called as it scrolls (at most once a frame). */
  readonly onScroll?: (event: ScrollEvent) => void;
}

/** `TextInput`'s props. */
export interface GpuiTextInputProps extends GpuiViewProps {
  /** The text (controlled). */
  readonly value?: string;
  /** The first text (uncontrolled). */
  readonly defaultValue?: string;
  /** Shown while empty. */
  readonly placeholder?: string;
  /** The placeholder's colour. */
  readonly placeholderTextColor?: string;
  /** Whether the user can edit it (default true). */
  readonly editable?: boolean;
  /** Mask the text (a password). */
  readonly secureTextEntry?: boolean;
  /** More than one line. */
  readonly multiline?: boolean;
  /** The text changed. */
  readonly onChangeText?: (text: string) => void;
  /** The text changed (React Native's event, with the native event count). */
  readonly onChange?: (event: {
    readonly nativeEvent: {
      readonly text: string;
      readonly eventCount: number;
      readonly target: number;
    };
  }) => void;
  /** The user submitted (Return in a single-line input). */
  readonly onSubmitEditing?: (event: { readonly nativeEvent: { readonly text: string } }) => void;
  /** The selection moved. */
  readonly onSelectionChange?: (event: {
    readonly nativeEvent: { readonly selection: { readonly start: number; readonly end: number } };
  }) => void;
}

/** A `Pressable`'s state, which a function `style` or `children` is called with. */
export interface PressableState {
  /** Whether it is pressed now. */
  readonly pressed: boolean;
}

/** `Pressable`'s props. */
export interface GpuiPressableProps
  extends Omit<GpuiViewProps, "style" | "children">, GpuiPressProps {
  /** The style, or a function of the pressed state. */
  readonly style?: GpuiStyle | ((state: PressableState) => GpuiStyle);
  /** The children, or a function of the pressed state. */
  readonly children?: VNodeChildren | ((state: PressableState) => VNodeChildren);
  /** Ignore presses. */
  readonly disabled?: boolean;
}

/** A host primitive: its element type is the node kind's name. */
function host<P>(name: string): GpuiComponent<P> {
  return name as unknown as GpuiComponent<P>;
}

/** React Native's `View`: a layout box. */
export const View: GpuiComponent<GpuiViewProps> = host("View");
/** React Native's `Text`: text, with nested `Text` elements as styled spans. */
export const Text: GpuiComponent<GpuiTextProps> = host("Text");
/** React Native's `Image`. */
export const Image: GpuiComponent<GpuiImageProps> = host("Image");
/** React Native's `TextInput`: controlled through `value`, with React Native's event count. */
export const TextInput: GpuiComponent<GpuiTextInputProps> = host("TextInput");

const HostScrollView = host<Record<string, unknown>>("ScrollView");
const HostPressable = host<Record<string, unknown>>("Pressable");

/** A row for a horizontal ScrollView's content. */
const ROW = { flexDirection: "row" };

/**
 * React Native's `ScrollView`: a scroll node whose content view takes `contentContainerStyle`.
 *
 * @param props The scroll view's props.
 * @returns The element.
 */
export function ScrollView(props: GpuiScrollViewProps): VNode {
  const { children, contentContainerStyle, ...rest } = props;
  const content = props.horizontal ? [ROW, contentContainerStyle] : contentContainerStyle;
  return h(HostScrollView, rest, h(View, { style: content }, children));
}

/** `useState` on whichever renderer is rendering (react-internals.ts). */
const useRendererState = dispatched("useState", useState);

/**
 * React Native's `Pressable`: press callbacks through denext's pressability, and a function
 * `style` or `children` called with `{ pressed }`.
 *
 * @param props The pressable's props.
 * @returns The element.
 */
export function Pressable(props: GpuiPressableProps): VNode {
  const [pressed, setPressed] = useRendererState(false);
  const { style, children, ...rest } = props;
  const state = { pressed };
  const tracked: Record<string, unknown> = { ...rest };
  if (typeof style === "function" || typeof children === "function") {
    // The pressed state is needed: follow the press in and out.
    tracked.onPressIn = (event: PressEvent) => {
      setPressed(true);
      rest.onPressIn?.(event);
    };
    tracked.onPressOut = (event: PressEvent) => {
      setPressed(false);
      rest.onPressOut?.(event);
    };
  }
  tracked.style = typeof style === "function" ? style(state) : style;
  return h(HostPressable, tracked, typeof children === "function" ? children(state) : children);
}
