import { AllRows } from "./all-rows.tsx";
import type { ImplProps } from "./types.ts";

/** `cv`: every row as plain DOM + `content-visibility: auto` (n ≤ 100k). */
export default function ContentVisibilityList(props: ImplProps) {
  return <AllRows {...props} cv />;
}
