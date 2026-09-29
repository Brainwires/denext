/**
 * React Native's `BackHandler` for React Native mode, over `denext/mobile`'s back stack
 * (`onBack`): Android's back button and back gesture inside the Capacitor shell.
 * react-native-web ships it as a mock that logs an error.
 *
 * @module
 */

import { isNativeShell, nativePlatform } from "../mobile/bridge.ts";
import { onBack } from "../mobile/back-handler.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import {
  type EmitterSubscription,
  type HandlerSubscriptions,
  handlerSubscriptions,
  subscription,
} from "./internal.ts";

/** A `hardwareBackPress` handler: return `true` to consume the back action. */
export type BackPressHandler = () => boolean | null | undefined;

/** React Native's `BackHandler` module. */
export interface BackHandlerStatic {
  /** Leave the app (Android shell only; elsewhere it does nothing). */
  exitApp(): void;
  /** Register `handler` on top of the handlers already registered (a LIFO stack). */
  addEventListener(eventName: "hardwareBackPress", handler: BackPressHandler): EmitterSubscription;
  /** Unregister `handler` (removed in React Native 0.77; kept for older libraries). */
  removeEventListener(eventName: "hardwareBackPress", handler: BackPressHandler): void;
}

/** The registrations by handler, for the deprecated `removeEventListener`. */
let registered: HandlerSubscriptions | undefined;

/** The slice of `@capacitor/app` `exitApp` uses. */
interface AppExit {
  exitApp(): Promise<void>;
}

/**
 * React Native's `BackHandler`, backed by `denext/mobile`'s `onBack`: inside the Android shell
 * a `hardwareBackPress` handler runs on the back button and the back gesture (newest first;
 * `true` consumes it, as in React Native; unconsumed, the app goes back in history or leaves).
 * With `denext mobile add back` the native callback is enabled only while a handler is
 * registered, so Android's predictive back-to-home animation plays otherwise.
 *
 * Elsewhere (the iOS shell, which has no back button, and a browser, whose back button is the
 * router's) a handler is accepted and never called, as React Native's iOS does.
 *
 * @example
 * ```ts
 * import { BackHandler } from "react-native";
 *
 * const sub = BackHandler.addEventListener("hardwareBackPress", () => {
 *   if (!modalOpen) return false;
 *   closeModal();
 *   return true;
 * });
 * sub.remove();
 * ```
 */
export const BackHandler: BackHandlerStatic = {
  exitApp() {
    if (nativePlatform() !== "android") return;
    nativePlugin<AppExit>("App", ["exitApp"])?.exitApp().catch(() => {});
  },
  addEventListener(eventName, handler) {
    if (eventName !== "hardwareBackPress" || !isNativeShell()) return subscription(() => {});
    const off = onBack(() => handler() === true);
    return (registered ??= handlerSubscriptions()).track(handler, off);
  },
  removeEventListener(eventName, handler) {
    if (eventName !== "hardwareBackPress") return;
    registered?.removeAll(handler);
  },
};
