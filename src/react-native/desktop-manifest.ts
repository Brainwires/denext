/**
 * The React Native desktop packages React Native mode aliases (`react-native-windows`,
 * `react-native-macos`): the version each was matched against, what React Native mode builds
 * for the names the package adds to React Native, and what it leaves out. Every other name
 * each package exports is React Native's, served as `react-native` is (react-native-web plus
 * the shell overlay). `scripts/parity/native` checks the aliases against the pinned packages'
 * types. Pure data: no imports, nothing runs.
 *
 * @module
 */

/** One aliased desktop package. */
export interface DesktopAlias {
  /** The package version its API was matched against. */
  readonly pinned: string;
  /** `partial`: the package's own additions are provided, with `omitted` ones and documented differences. */
  readonly status: "full" | "partial";
  /** The package's own additions to React Native that React Native mode provides. */
  readonly provided: readonly string[];
  /** Exports (or `Name.member`s) deliberately not provided. */
  readonly omitted?: readonly string[];
  /** How the additions behave on the web. */
  readonly notes: string;
}

/** Every React Native desktop package React Native mode aliases, by package name. */
export const DESKTOP_ALIASES: Readonly<Record<string, DesktopAlias>> = {
  "react-native-windows": {
    pinned: "0.84.0",
    status: "partial",
    provided: [
      "AppTheme",
      "EventPhase",
      "Flyout",
      "Glyph",
      "HandledEventPhase",
      "Popup",
      "supportKeyboard",
      "unstable_batchedUpdates",
      "View",
      "ViewWindows",
    ],
    notes: "Flyout / Popup open over react-native-web's Modal against their target (an element " +
      "or a ref; centred without one), light dismiss and Escape call onDismiss. Glyph is a " +
      "Text in the fontUri's #family. AppTheme reports forced-colors (high contrast) as CSS " +
      "system colors. supportKeyboard returns the component. View maps tooltip, keyDownEvents " +
      "/ keyUpEvents (every key reaches onKeyDown; listed ones are handled) and " +
      'enableFocusRing; the XAML-only props do nothing. Platform.OS stays "web"; ' +
      "Platform.select picks `windows` in Deno Desktop on Windows.",
  },
  "react-native-macos": {
    pinned: "0.81.9",
    status: "partial",
    provided: [
      "ColorWithSystemEffectMacOS",
      "DynamicColorMacOS",
      "unstable_batchedUpdates",
      "View",
    ],
    omitted: ["View.acceptsFirstMouse"],
    notes: "DynamicColorMacOS is a light-dark() color (as DynamicColorIOS); " +
      "ColorWithSystemEffectMacOS a CSS color-mix(). PlatformColor knows the NSColor names. " +
      "View maps tooltip, onDoubleClick, keyDownEvents / validKeysDown (only listed keys reach " +
      "onKeyDown) and enableFocusRing; in a Deno Desktop window mouseDownCanMoveWindow is a " +
      "window drag region, allowsVibrancy the window's vibrancy and draggedTypes (fileUrl) " +
      "onDragEnter / onDragLeave / onDrop with read-only handles; acceptsFirstMouse is accepted " +
      'with a dev warning. Platform.OS stays "web"; Platform.select picks `macos` in Deno ' +
      "Desktop on macOS.",
  },
};
