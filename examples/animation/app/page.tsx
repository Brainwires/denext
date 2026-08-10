// TWO real npm animation libraries — `motion` (motion.dev) and `@react-spring/web`
// — co-existing in ONE denext page, both running on denext's single React. Each is
// SSR'd to its initial state and animates after hydration in the browser.
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

// react-spring: an entrance spring on mount.
function SpringCard() {
  const styles = useSpring({
    from: { opacity: 0, transform: "translateY(24px) scale(0.96)" },
    to: { opacity: 1, transform: "translateY(0px) scale(1)" },
    config: { tension: 210, friction: 20 },
  });
  return h(
    animated.div,
    { style: { ...styles, ...card, background: "#0ea5e9" } },
    "Animated by react-spring",
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
      " initial state, then animated on hydration.",
    ),
    h(MotionCard, null),
    h(SpringCard, null),
  );
}
