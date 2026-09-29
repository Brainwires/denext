/**
 * `react-native-share` for denext's React Native mode: `Share.open` over `denext/mobile`'s
 * {@linkcode share} (the system share sheet through `@capacitor/share` in the shell,
 * `navigator.share` on the web, the clipboard as the last resort).
 *
 * `Share.shareSingle` cannot target one app (there is no per-app share intent in a web view):
 * it opens the same system sheet, so the user picks the app. Files (`url` / `urls` that are
 * `file:` or `data:` URIs, `filename`) are passed as the shared URL, not as attachments.
 * `isPackageInstalled` always reports `false`. `Overlay`, `Sheet`, `Button` and `ShareSheet`
 * are simple web versions of the package's custom-sheet building blocks.
 *
 * @example
 * ```ts
 * import Share from "react-native-share";
 *
 * const result = await Share.open({ title: "Invite", message: "Join me", url: "https://x.dev" });
 * if (result.success) track("shared");
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { share } from "../mobile/share.ts";
import { hostView, viewStyle } from "../expo/internal/common.ts";
import * as RN from "./internal/react-native.ts";

/** The social targets {@linkcode shareSingle} names. */
export enum Social {
  /** Facebook. */
  Facebook = "facebook",
  /** Facebook Stories. */
  FacebookStories = "facebookstories",
  /** Facebook Pages Manager. */
  Pagesmanager = "pagesmanager",
  /** Twitter / X. */
  Twitter = "twitter",
  /** WhatsApp. */
  Whatsapp = "whatsapp",
  /** WhatsApp Business. */
  Whatsappbusiness = "whatsappbusiness",
  /** Instagram. */
  Instagram = "instagram",
  /** Instagram Stories. */
  InstagramStories = "instagramstories",
  /** Google+. */
  Googleplus = "googleplus",
  /** Email. */
  Email = "email",
  /** Pinterest. */
  Pinterest = "pinterest",
  /** LinkedIn. */
  Linkedin = "linkedin",
  /** SMS. */
  Sms = "sms",
  /** Telegram. */
  Telegram = "telegram",
  /** Snapchat. */
  Snapchat = "snapchat",
  /** Messenger. */
  Messenger = "messenger",
  /** Viber. */
  Viber = "viber",
  /** Discord. */
  Discord = "discord",
}

/** The Instagram / Facebook Stories asset kinds. */
export enum ShareAsset {
  /** A background image. */
  BackgroundImage = "shareBackgroundImage",
  /** A background video. */
  BackgroundVideo = "shareBackgroundVideo",
  /** A sticker image. */
  StickerImage = "shareStickerImage",
  /** A background and a sticker image. */
  BackgroundAndStickerImage = "shareBackgroundAndStickerImage",
}

/** Options for {@linkcode open}. */
export interface ShareOptions {
  /** The text. */
  message?: string;
  /** The title (the email subject, say). */
  title?: string;
  /** The URL. */
  url?: string;
  /** Several URLs (only the first is shared). */
  urls?: string[];
  /** The MIME type (ignored). */
  type?: string;
  /** The email subject (used as the title when there is none). */
  subject?: string;
  /** The recipient's email (ignored). */
  email?: string;
  /** The SMS recipient (ignored). */
  recipient?: string;
  /** iOS activity types to hide (ignored). */
  excludedActivityTypes?: string[];
  /** Reject instead of resolving `{ dismissedAction: true }` when the user dismisses the sheet. */
  failOnCancel?: boolean;
  /** Any other option the package takes (ignored). */
  [option: string]: unknown;
}

/** Options for {@linkcode shareSingle}. */
export interface ShareSingleOptions extends ShareOptions {
  /** The target app (the system sheet opens instead; the user picks it). */
  social: Social | string;
  /** The Facebook / Instagram app id (ignored). */
  appId?: string;
}

/** What {@linkcode shareSingle} resolves to. */
export interface ShareSingleResult {
  /** A description of the outcome. */
  message: string;
  /** Whether it was shared (or copied to the clipboard). */
  success: boolean;
}

/** What {@linkcode open} resolves to. */
export interface ShareOpenResult extends ShareSingleResult {
  /** The user dismissed the sheet. */
  dismissedAction?: boolean;
}

/** What {@linkcode isPackageInstalled} resolves to. */
export interface IsPackageInstalledResult {
  /** A description. */
  message: string;
  /** Always `false` here. */
  isInstalled: boolean;
}

/** Share through the system sheet. */
async function openSheet(options: ShareOptions): Promise<ShareOpenResult> {
  const url = options.url ?? options.urls?.[0];
  const title = options.title ?? options.subject;
  const outcome = await share({
    ...(title ? { title } : {}),
    ...(options.message ? { text: options.message } : {}),
    ...(url ? { url } : {}),
  });
  if (outcome === "cancelled") {
    if (options.failOnCancel !== false) throw new Error("User did not share");
    return { success: false, message: "dismissed", dismissedAction: true };
  }
  return { success: true, message: outcome };
}

/**
 * Open the system share sheet. As in the package, a dismissal rejects with "User did not
 * share" unless `failOnCancel` is `false`, which resolves `{ dismissedAction: true }`.
 *
 * @param options What to share.
 * @returns The outcome.
 */
export function open(options: ShareOptions): Promise<ShareOpenResult> {
  return openSheet(options);
}

/**
 * Share to one app: the system sheet opens instead (a web view cannot target an app), so the
 * user picks it.
 *
 * @param options What to share, and the target.
 * @returns The outcome.
 */
export async function shareSingle(options: ShareSingleOptions): Promise<ShareSingleResult> {
  const result = await openSheet({ ...options, failOnCancel: false });
  return { success: result.success, message: result.message };
}

/**
 * Whether an Android package is installed. A web view cannot tell: always `false`.
 *
 * @param _packageName The package id.
 * @returns `{ isInstalled: false }`.
 */
export function isPackageInstalled(_packageName: string): Promise<IsPackageInstalledResult> {
  return Promise.resolve({ isInstalled: false, message: "Package is not installed" });
}

/** `Overlay` props. */
export interface OverlayProps {
  /** Whether the overlay covers the screen. */
  visible: boolean;
  /** The content. */
  children?: VNodeChildren;
}

/**
 * A full-screen layer while `visible`; nothing otherwise.
 *
 * @param props The visibility and content.
 * @returns The layer, or null.
 */
export function Overlay(props: OverlayProps): VNode | null {
  if (!props.visible) return null;
  return h(hostView(), {
    style: viewStyle(null, { position: "fixed", top: 0, right: 0, bottom: 0, left: 0 }),
  }, props.children as never);
}

/** `Sheet` props. */
export interface SheetProps {
  /** Whether the sheet shows. */
  visible: boolean;
  /** The content. */
  children?: VNodeChildren;
}

/**
 * A panel at the bottom of the screen while `visible`.
 *
 * @param props The visibility and content.
 * @returns The panel, or null.
 */
export function Sheet(props: SheetProps): VNode | null {
  if (!props.visible) return null;
  return h(hostView(), {
    style: viewStyle(null, {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "white",
    }),
  }, props.children as never);
}

/** `Button` props. */
export interface ButtonProps {
  /** Called on press. */
  onPress: () => void;
  /** The icon (a `{ uri }` source or a URL string). */
  iconSrc?: unknown;
  /** The button's style. */
  buttonStyle?: unknown;
  /** The label's style. */
  textStyle?: unknown;
  /** The label. */
  children?: VNodeChildren;
}

/** An image source's URL. */
function sourceUrl(source: unknown): string | undefined {
  if (typeof source === "string") return source;
  const uri = (source as { uri?: unknown } | null)?.uri;
  return typeof uri === "string" ? uri : undefined;
}

/**
 * A row with an icon and a label that calls `onPress`.
 *
 * @param props The handler, icon, styles and label.
 * @returns The button.
 */
export function Button(props: ButtonProps): VNode {
  const icon = sourceUrl(props.iconSrc);
  const base = { flexDirection: "row", alignItems: "center", height: 50, padding: 10 };
  const text = { color: "#2c2c2c", fontSize: 16, fontWeight: "bold" };
  const label = RN.Text
    ? h(RN.Text, { style: [text, props.textStyle] }, props.children as never)
    : h("span", { style: text }, props.children as never);
  return h(
    RN.Pressable ?? "button",
    RN.Pressable
      ? { onPress: props.onPress, style: [base, props.buttonStyle] }
      : { type: "button", onClick: props.onPress, style: viewStyle(props.buttonStyle, base) },
    icon
      ? h("img", { src: icon, alt: "", style: { width: 28, height: 28, margin: "0 30px 0 10px" } })
      : null,
    label,
  );
}

/** `ShareSheet` props. */
export interface ShareSheetProps {
  /** Whether the sheet shows. */
  visible: boolean;
  /** Called when the backdrop is pressed. */
  onCancel: () => void;
  /** The sheet's style. */
  style?: unknown;
  /** The backdrop's style. */
  overlayStyle?: unknown;
  /** The buttons. */
  children?: VNodeChildren;
}

/**
 * A custom share sheet: a dimmed backdrop (pressing it calls `onCancel`) and a bottom panel.
 *
 * @param props The visibility, cancel handler, styles and buttons.
 * @returns The sheet, or null.
 */
export function ShareSheet(props: ShareSheetProps): VNode | null {
  if (!props.visible) return null;
  const backdrop = h(hostView(), {
    onClick: props.onCancel,
    style: viewStyle(props.overlayStyle, {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: "rgba(0,0,0,0.4)",
    }),
  });
  const panel = Sheet({
    visible: true,
    children: h(hostView(), { style: viewStyle(props.style) }, props.children as never),
  });
  return Overlay({ visible: true, children: [backdrop, panel] });
}

/** The package's default export. */
const RNShare: {
  /** {@linkcode Button}. */
  readonly Button: typeof Button;
  /** {@linkcode ShareSheet}. */
  readonly ShareSheet: typeof ShareSheet;
  /** {@linkcode Overlay}. */
  readonly Overlay: typeof Overlay;
  /** {@linkcode Sheet}. */
  readonly Sheet: typeof Sheet;
  /** The social targets (`Share.Social.WHATSAPP`, …). */
  readonly Social: Readonly<Record<string, Social>>;
  /** {@linkcode open}. */
  readonly open: typeof open;
  /** {@linkcode shareSingle}. */
  readonly shareSingle: typeof shareSingle;
  /** {@linkcode isPackageInstalled}. */
  readonly isPackageInstalled: typeof isPackageInstalled;
} = {
  Button,
  ShareSheet,
  Overlay,
  Sheet,
  Social: {
    FACEBOOK: Social.Facebook,
    FACEBOOK_STORIES: Social.FacebookStories,
    PAGESMANAGER: Social.Pagesmanager,
    TWITTER: Social.Twitter,
    WHATSAPP: Social.Whatsapp,
    WHATSAPPBUSINESS: Social.Whatsappbusiness,
    INSTAGRAM: Social.Instagram,
    INSTAGRAM_STORIES: Social.InstagramStories,
    GOOGLEPLUS: Social.Googleplus,
    EMAIL: Social.Email,
    PINTEREST: Social.Pinterest,
    LINKEDIN: Social.Linkedin,
    SMS: Social.Sms,
    TELEGRAM: Social.Telegram,
    MESSENGER: Social.Messenger,
    SNAPCHAT: Social.Snapchat,
    VIBER: Social.Viber,
    DISCORD: Social.Discord,
  },
  open,
  shareSingle,
  isPackageInstalled,
};

export default RNShare;
