/**
 * The row designs, as numbers. The web app turns these into CSS (web/src/styles.ts) and the
 * React Native app into StyleSheets (native/src/rows.tsx), so both draw the same rows: one
 * CSS px = one dp. Change a design here, never in only one app.
 *
 * Plain data: no React, no platform imports.
 */

export const COLORS = {
  bg: "#ffffff",
  text: "#111827",
  muted: "#6b7280",
  border: "#e5e7eb",
  link: "#2563eb",
  userBubble: "#eef2ff",
  codeBg: "#0f172a",
  codeText: "#e2e8f0",
  inlineCodeBg: "#f3f4f6",
  headerBg: "#f3f4f6",
  headerText: "#374151",
  overlayBg: "rgba(17,24,39,0.78)",
  overlayText: "#f9fafb",
} as const;

/** Avatar / image-placeholder palette (index = item.color). */
export const PALETTE = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#a855f7",
  "#ec4899",
] as const;

/** `fixed` rows (and the rows of `sections`): exactly this tall. */
export const FIXED = {
  height: 56,
  padH: 12,
  gap: 12,
  avatar: 36,
  avatarFont: 14,
  titleSize: 15,
  titleLine: 20,
  subSize: 13,
  subLine: 18,
  timeSize: 12,
  timeLine: 16,
} as const;

/** `sections` headers. */
export const HEADER = {
  height: 32,
  padH: 12,
  size: 13,
  weight: "700",
} as const;

/** `chat` messages. */
export const CHAT = {
  padV: 8,
  padH: 12,
  size: 15,
  line: 21,
  paraGap: 8,
  /** User messages sit in a bubble, indented from the left. */
  bubblePad: 10,
  bubbleRadius: 12,
  bubbleIndent: 48,
  roleSize: 12,
  roleLine: 16,
  codeSize: 12,
  codeLine: 17,
  codePad: 10,
  codeRadius: 8,
  codeGap: 8,
} as const;

/** `images` rows. */
export const IMAGE = {
  padH: 12,
  padV: 8,
  radius: 8,
  captionSize: 14,
  captionLine: 20,
  captionGap: 6,
} as const;

/** The estimate each list is given for a kind (px / dp). */
export const ESTIMATED_SIZE = {
  fixed: FIXED.height,
  sections: FIXED.height,
  chat: 180,
  images: 260,
} as const;

export const MONO_FONT = "monospace";
