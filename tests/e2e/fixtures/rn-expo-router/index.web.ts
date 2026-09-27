// expo-router's web entry without @expo/metro-runtime, as `denext migrate --from expo` writes it.
import { App } from "expo-router/build/qualified-entry";
import { renderRootComponent } from "expo-router/build/renderRootComponent";

renderRootComponent(App);
