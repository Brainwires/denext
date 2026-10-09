/**
 * `react-native-gesture-handler/Swipeable` for denext: the classic swipeable row, drawn by
 * denext's `SwipeableRow` (a DOM row whose drag writes only transforms, with the axis lock of
 * `denext/navigation`'s back swipe). `renderLeftActions` / `renderRightActions` receive
 * React Native `Animated.Value`s for the progress and the drag in React Native mode (they
 * follow the finger), and the ref has `close`, `openLeft`, `openRight` and `reset`.
 *
 * Only this subpath is aliased: the rest of `react-native-gesture-handler` resolves normally.
 *
 * @module
 */

import { createSwipeable, type SwipeableProps } from "./internal/swipeable.ts";
import type { VNode } from "../jsx/types.ts";

export type { SwipeableMethods, SwipeableProps } from "./internal/swipeable.ts";

/** RNGH's `Swipeable`, drawn by `SwipeableRow`. */
const Swipeable: (props: SwipeableProps) => VNode = createSwipeable("animated");
export default Swipeable;
export { Swipeable };
