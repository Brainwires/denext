// The row CSS, generated from shared/theme.ts (the numbers the React Native rows use too), so
// every web impl and the native app draw the same rows. Injected once by main.tsx.

import {
  CHAT,
  COLORS,
  ESTIMATED_SIZE,
  FIXED,
  HEADER,
  IMAGE,
  MONO_FONT,
} from "../../shared/theme.ts";

const px = (n: number) => `${n}px`;

export const BENCH_CSS = `
html, body, #root { height: 100%; margin: 0; }
/* the SPA root is a flex row: the list root fills it */
#root > :not(.sb-overlay) { flex: 1 1 auto; min-width: 0; width: 100%; height: 100%; }
body {
  background: ${COLORS.bg};
  color: ${COLORS.text};
  font-family: Roboto, system-ui, sans-serif;
  -webkit-text-size-adjust: 100%;
}
* { box-sizing: border-box; }

.sb-scroller {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* fixed rows (and the rows of sections) */
.sb-fixed {
  height: ${px(FIXED.height)};
  display: flex;
  align-items: center;
  gap: ${px(FIXED.gap)};
  padding: 0 ${px(FIXED.padH)};
  border-bottom: 1px solid ${COLORS.border};
  background: ${COLORS.bg};
}
.sb-avatar {
  width: ${px(FIXED.avatar)};
  height: ${px(FIXED.avatar)};
  border-radius: 50%;
  flex: none;
  color: #fff;
  font-size: ${px(FIXED.avatarFont)};
  font-weight: 600;
  line-height: ${px(FIXED.avatar)};
  text-align: center;
}
.sb-fixed-body { flex: 1; min-width: 0; }
.sb-title, .sb-sub {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sb-title { font-size: ${px(FIXED.titleSize)}; line-height: ${
  px(FIXED.titleLine)
}; font-weight: 600; }
.sb-sub { font-size: ${px(FIXED.subSize)}; line-height: ${
  px(FIXED.subLine)
}; color: ${COLORS.muted}; }
.sb-time {
  flex: none;
  font-size: ${px(FIXED.timeSize)};
  line-height: ${px(FIXED.timeLine)};
  color: ${COLORS.muted};
}

/* sections headers */
.sb-header {
  height: ${px(HEADER.height)};
  line-height: ${px(HEADER.height)};
  padding: 0 ${px(HEADER.padH)};
  background: ${COLORS.headerBg};
  color: ${COLORS.headerText};
  font-size: ${px(HEADER.size)};
  font-weight: ${HEADER.weight};
}
.sb-sticky { position: sticky; top: 0; z-index: 1; }

/* chat messages */
.sb-chat { padding: ${px(CHAT.padV)} ${px(CHAT.padH)}; }
.sb-chat-body { display: flex; flex-direction: column; gap: ${px(CHAT.paraGap)}; }
.sb-chat.user .sb-chat-body {
  margin-left: ${px(CHAT.bubbleIndent)};
  background: ${COLORS.userBubble};
  border-radius: ${px(CHAT.bubbleRadius)};
  padding: ${px(CHAT.bubblePad)};
}
.sb-role {
  font-size: ${px(CHAT.roleSize)};
  line-height: ${px(CHAT.roleLine)};
  font-weight: 600;
  color: ${COLORS.muted};
}
.sb-p {
  margin: 0;
  font-size: ${px(CHAT.size)};
  line-height: ${px(CHAT.line)};
  overflow-wrap: anywhere;
}
.sb-b { font-weight: 700; }
.sb-a { color: ${COLORS.link}; text-decoration: underline; }
.sb-ic {
  font-family: ${MONO_FONT};
  background: ${COLORS.inlineCodeBg};
  font-size: ${px(CHAT.codeSize + 1)};
}
.sb-code {
  margin: 0;
  background: ${COLORS.codeBg};
  color: ${COLORS.codeText};
  font-family: ${MONO_FONT};
  font-size: ${px(CHAT.codeSize)};
  line-height: ${px(CHAT.codeLine)};
  padding: ${px(CHAT.codePad)};
  border-radius: ${px(CHAT.codeRadius)};
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* image rows */
.sb-image { padding: ${px(IMAGE.padV)} ${px(IMAGE.padH)}; }
.sb-img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: ${px(IMAGE.radius)};
}
.sb-caption {
  margin: ${px(IMAGE.captionGap)} 0 0;
  font-size: ${px(IMAGE.captionSize)};
  line-height: ${px(IMAGE.captionLine)};
}

/* the cv impl: skip layout/paint of off-screen rows, reserving an estimate */
.sb-cv > .sb-item { content-visibility: auto; }
.sb-cv.k-fixed > .sb-item, .sb-cv.k-sections > .sb-item {
  contain-intrinsic-size: auto ${px(ESTIMATED_SIZE.fixed)};
}
.sb-cv.k-chat > .sb-item { contain-intrinsic-size: auto ${px(ESTIMATED_SIZE.chat)}; }
.sb-cv.k-images > .sb-item { contain-intrinsic-size: auto ${px(ESTIMATED_SIZE.images)}; }
/* a sticky header must lay out to stick */
.sb-cv > .sb-item.sb-sticky { content-visibility: visible; }

/* the overlay: one small fixed box, static text unless the FPS meter is on */
.sb-overlay {
  position: fixed;
  top: 4px;
  right: 4px;
  z-index: 10;
  background: ${COLORS.overlayBg};
  color: ${COLORS.overlayText};
  font: 11px/14px ${MONO_FONT};
  padding: 3px 6px;
  border-radius: 6px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.sb-overlay button {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 0 4px;
}

.sb-message { padding: 24px 16px; font-size: 15px; line-height: 21px; }
.sb-menu { padding: 12px 16px 48px; font-size: 14px; line-height: 20px; }
.sb-menu h1 { font-size: 18px; margin: 8px 0; }
.sb-menu h2 { font-size: 15px; margin: 16px 0 4px; }
.sb-menu a { color: ${COLORS.link}; margin-right: 10px; }
`;
