// React Native mode's round-4 compat (2.11): names that failed the build or rendered nothing
// before, and the community packages it now resolves to denext implementations. None of the
// three packages is installed: React Native mode resolves them without the real package.
import { useRef, useState } from "react";
import {
  DrawerLayoutAndroid,
  Image,
  ProgressBarAndroid,
  Settings,
  Text,
  TouchableNativeFeedback,
  View,
} from "react-native";
import FastImage from "react-native-fast-image";
import MapView, { Marker } from "react-native-maps";
import Video from "react-native-video";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function Round4() {
  const [taps, setTaps] = useState(0);
  const drawer = useRef<{ openDrawer(): void } | null>(null);
  Settings.set({ seen: 1 });
  const resolved = Image.resolveAssetSource(PIXEL);
  return (
    <View>
      <TouchableNativeFeedback
        onPress={() => setTaps((n) => n + 1)}
        background={TouchableNativeFeedback.Ripple("#f00", false)}
      >
        <View testID="tnf">
          <Text>tap</Text>
        </View>
      </TouchableNativeFeedback>
      <Text testID="taps">{String(taps)}</Text>
      <Text testID="settings">{String(Settings.get("seen"))}</Text>
      <Text testID="resolved">{String(resolved?.uri === PIXEL)}</Text>
      <ProgressBarAndroid
        testID="progress"
        indeterminate={false}
        progress={0.5}
      />
      <View style={{ height: 80 }}>
        <DrawerLayoutAndroid
          ref={drawer as never}
          drawerWidth={120}
          renderNavigationView={() => <Text testID="drawer-menu">menu</Text>}
        >
          <Text testID="drawer-screen">screen</Text>
        </DrawerLayoutAndroid>
      </View>
      <FastImage
        testID="fast-image"
        source={{ uri: PIXEL, priority: FastImage.priority.high }}
        resizeMode={FastImage.resizeMode.cover}
        style={{ width: 10, height: 10 }}
      />
      <View testID="map" style={{ height: 120 }}>
        <MapView
          style={{ flex: 1 }}
          initialRegion={{
            latitude: 51.5,
            longitude: -0.12,
            latitudeDelta: 0.05,
            longitudeDelta: 0.05,
          }}
        >
          <Marker
            coordinate={{ latitude: 51.5, longitude: -0.12 }}
            title="London"
          />
        </MapView>
      </View>
      <View testID="video" style={{ height: 90 }}>
        <Video source={{}} paused muted controls style={{ flex: 1 }} />
      </View>
    </View>
  );
}
