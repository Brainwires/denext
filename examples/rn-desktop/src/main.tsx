// The web entry: react-native-web's AppRegistry mounts the root component on the SPA's #root,
// as Expo's / Metro's web build does.
import { AppRegistry } from "react-native";
import { App } from "./App.tsx";

AppRegistry.registerComponent("main", () => App);
AppRegistry.runApplication("main", {
  rootTag: document.getElementById("root"),
});
