// TWO real npm animation libraries — `motion` (motion.dev) and `@react-spring/web`
// — co-existing in ONE denext page, both running on denext's single React. Both
// are SSR'd to their initial state, then driven in the browser after hydration:
// the motion card animates in on load (and scales on hover); the react-spring
// card is a squishy pressable (scale down on press, spring back on release).
import { createElement as h } from "react";
import { motion } from "motion/react";
import { animated, useSpring } from "@react-spring/web";

const card = {
  padding: "1.25rem 1.5rem",
  borderRadius: "12px",
  color: "#fff",
  fontWeight: 600,
  fontFamily: "system-ui, sans-serif",
};

// react-spring: a "squishy pressable" — scale down on press, bounce back on
// release. The low-friction config gives the springy overshoot; the imperative
// `api.start` is driven by pointer events (not an on-mount `to`).
function SpringCard() {
  const [styles, api] = useSpring(() => ({
    scale: 1,
    config: { tension: 320, friction: 9 }, // squishy: bouncy, low damping
  }));
  const squish = () => api.start({ scale: 0.9 });
  const release = () => api.start({ scale: 1 });
  return h(
    animated.div,
    {
      style: {
        ...styles,
        ...card,
        background: "#0ea5e9",
        cursor: "pointer",
        userSelect: "none",
        touchAction: "none",
      },
      onPointerDown: squish,
      onPointerUp: release,
      onPointerLeave: release,
    },
    "Press me — react-spring",
  );
}

// motion (motion.dev): an entrance + hover animation.
function MotionCard() {
  return h(
    motion.div,
    {
      initial: { opacity: 0, y: 24 },
      animate: { opacity: 1, y: 0 },
      whileHover: { scale: 1.05 },
      transition: { duration: 0.6, ease: "easeOut" },
      style: { ...card, background: "#8b5cf6", cursor: "pointer" },
    },
    "Animated by motion — hover me",
  );
}

export default function Page() {
  return h(
    "main",
    {
      style:
        "font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;display:flex;flex-direction:column;gap:1rem",
    },
    h("h1", null, "denext × motion + react-spring"),
    h(
      "p",
      null,
      "Two different animation libraries — ",
      h("code", null, "motion"),
      " and ",
      h("code", null, "@react-spring/web"),
      " — in the same project, both on denext's single React. Server-rendered to their",
      " initial state, then brought to life on hydration: the motion card animates in and",
      " scales on hover; the react-spring card is a squishy pressable — press it.",
    ),
    h(MotionCard, null),
    h(SpringCard, null),
  );
}
