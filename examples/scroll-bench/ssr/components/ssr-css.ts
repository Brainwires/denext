// The SPA's row CSS (web/src/styles.ts, generated from shared/theme.ts) plus what the
// server-rendered pages add: a full-height list scroller, the per-row like button (absolutely
// placed, so it never changes a row's size) and the intro block of the below-the-fold page.

import { COLORS } from "../../shared/theme.ts";
import { BENCH_CSS } from "../../web/src/styles.ts";

export const SSR_CSS = `${BENCH_CSS}
.sb-page { height: 100vh; }
.sb-item { position: relative; }
.sb-like {
  position: absolute;
  top: 8px;
  right: 64px;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid ${COLORS.border};
  border-radius: 14px;
  background: ${COLORS.bg};
  color: ${COLORS.link};
  font-size: 14px;
  line-height: 26px;
}
.sb-like[aria-pressed="true"] { background: ${COLORS.userBubble}; }
.sb-intro { min-height: 150vh; padding: 16px; font-size: 15px; line-height: 21px; }
`;
