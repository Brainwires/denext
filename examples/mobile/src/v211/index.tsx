// The denext 2.11 demo screens: one route each under /v211/, listed on the home screen.
import type { VNode } from "denext";
import type { Inbox } from "../app.tsx";
import { navigate } from "../ui.tsx";
import {
  BiometricsScreen,
  GeolocationScreen,
  NotificationsScreen,
  PermissionsScreen,
  StoreScreen,
} from "./device.tsx";
import { DialogsScreen } from "./dialogs.tsx";
import { KeyboardFormScreen, KeyboardScreen } from "./keyboard.tsx";
import { ListsScreen } from "./lists.tsx";
import { NavigationScreen } from "./navigation.tsx";
import { NativeUiScreen } from "./native-ui.tsx";
import { RefreshScreen } from "./refresh.tsx";
import { SelfTestScreen } from "./selftest.tsx";
import { OrientationScreen, PrivacyScreen, SafeAreaScreen } from "./system.tsx";

/** The home list, in the order a tester walks it. */
const LIST: [path: string, label: string][] = [
  ["/v211/keyboard", "1. Keyboard (chat + form)"],
  ["/v211/safe-area", "2. Safe area & system bars"],
  ["/v211/dialogs", "3. Dialogs"],
  ["/v211/refresh", "4. Pull-to-refresh"],
  ["/v211/permissions", "5. Permissions"],
  ["/v211/notifications", "6. Local notifications"],
  ["/v211/biometrics", "7. Biometrics"],
  ["/v211/geolocation", "8. Geolocation"],
  ["/v211/orientation", "9. Orientation"],
  ["/v211/privacy", "10. Privacy screen"],
  ["/v211/store", "11–13. Tracking · Review · Media library"],
  ["/v211/lists", "14. Lists (100k, chat 10k, sticky)"],
  ["/v211/navigation", "15. Navigation (stack, tabs, sheet)"],
  ["/v211/native-ui", "16. Native look (menus, SF Symbols, theme)"],
  ["/selftest", "Run the automatic self-test"],
];

export const V211_SCREENS: Record<string, (inbox: Inbox) => VNode> = {
  "/v211/keyboard": () => <KeyboardScreen />,
  "/v211/keyboard-form": () => <KeyboardFormScreen />,
  "/v211/safe-area": () => <SafeAreaScreen />,
  "/v211/dialogs": () => <DialogsScreen />,
  "/v211/refresh": () => <RefreshScreen />,
  "/v211/permissions": () => <PermissionsScreen />,
  "/v211/notifications": (inbox) => <NotificationsScreen inbox={inbox} />,
  "/v211/biometrics": () => <BiometricsScreen />,
  "/v211/geolocation": () => <GeolocationScreen />,
  "/v211/orientation": () => <OrientationScreen />,
  "/v211/privacy": () => <PrivacyScreen />,
  "/v211/store": () => <StoreScreen />,
  "/v211/lists": () => <ListsScreen />,
  "/v211/navigation": () => <NavigationScreen />,
  "/v211/native-ui": () => <NativeUiScreen />,
  "/selftest": () => <SelfTestScreen />,
};

export function V211List() {
  return (
    <section class="card">
      <h2>denext 2.11</h2>
      <p class="note">
        One screen per new mobile feature. Each says what to do and what to see.
      </p>
      <div class="v211-list">
        {LIST.map(([path, label]) => (
          <button
            key={path}
            type="button"
            onClick={() => navigate(path)}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
