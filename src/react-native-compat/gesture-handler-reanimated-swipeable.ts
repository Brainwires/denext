/**
 * `react-native-gesture-handler/ReanimatedSwipeable` for denext: the Reanimated swipeable row,
 * drawn by denext's `SwipeableRow` (a DOM row whose drag writes only transforms, with the axis
 * lock of `denext/navigation`'s back swipe). `renderLeftActions` / `renderRightActions`
 * receive `{ value }` holders for the progress and the drag, updated as the row moves (an
 * animated style computed from them is not re-run per frame), and the ref has `close`,
 * `openLeft`, `openRight` and `reset`.
 *
 * Only this subpath is aliased: the rest of `react-native-gesture-handler` resolves normally.
 *
 * @module
 */

import { createSwipeable, type SwipeableProps } from "./internal/swipeable.ts";
import type { VNode } from "../jsx/types.ts";

export type { SwipeableMethods, SwipeableProps } from "./internal/swipeable.ts";

/** RNGH's `ReanimatedSwipeable`, drawn by `SwipeableRow`. */
const ReanimatedSwipeable: (props: SwipeableProps) => VNode = createSwipeable("shared");
export default ReanimatedSwipeable;
export { ReanimatedSwipeable };
