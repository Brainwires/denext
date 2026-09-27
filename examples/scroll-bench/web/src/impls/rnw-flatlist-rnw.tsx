// `rnw-flatlist-rnw`: react-native-web's OWN FlatList engine (its VirtualizedList), in the same
// app as `rnw-flatlist-denext`. React Native mode replaces the `react-native` FlatList with
// denext's adapter; the per-list escape hatch is importing react-native-web's vendored original
// directly (an app-wide switch is `reactNative: { lists: "library" }` in denext.config.ts).

// @ts-ignore: react-native-web ships no types.
import RnwFlatList from "react-native-web/dist/vendor/react-native/FlatList";
import { FlatListImpl } from "./rnw-flatlist.tsx";
import type { ImplProps } from "./types.ts";

export default function RnwFlatListRnw(props: ImplProps) {
  return <FlatListImpl {...props} FlatList={RnwFlatList} />;
}
