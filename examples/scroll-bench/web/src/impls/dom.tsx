import { AllRows } from "./all-rows.tsx";
import type { ImplProps } from "./types.ts";

/** `dom`: every row as plain DOM (n ≤ 10k). */
export default function DomList(props: ImplProps) {
  return <AllRows {...props} cv={false} />;
}
