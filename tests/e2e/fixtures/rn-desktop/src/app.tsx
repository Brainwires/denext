import { useRef, useState } from "react";
import { AppTheme, Flyout, Glyph, Pressable, Text, View } from "react-native-windows";
import { ColorWithSystemEffectMacOS, DynamicColorMacOS, View as MacView } from "react-native-macos";

export function App() {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState("");
  const [doubles, setDoubles] = useState(0);
  const anchor = useRef(null);
  return (
    <View testID="root" tooltip="Windows tooltip">
      <Glyph
        testID="glyph"
        glyph="*"
        emSize={18}
        fontUri="ms-appx:///Fonts/x.ttf#Arial"
      />
      <Text testID="hc">{String(AppTheme.isHighContrast)}</Text>
      <Text
        testID="mac-color"
        style={{
          color: DynamicColorMacOS({
            light: "rgb(10, 20, 30)",
            dark: "rgb(1, 1, 1)",
          }),
        }}
      >
        mac
      </Text>
      <Text
        testID="effect"
        style={{ color: ColorWithSystemEffectMacOS("rgb(0, 0, 255)", "none") }}
      >
        effect
      </Text>
      <MacView
        testID="mac-view"
        focusable
        onDoubleClick={() => setDoubles((n) => n + 1)}
        validKeysDown={["Enter"]}
        onKeyDown={(e: { nativeEvent: { key: string } }) => setKeys((k) => k + e.nativeEvent.key)}
        acceptsFirstMouse
      >
        <Text>mac view</Text>
      </MacView>
      <Text testID="keys">{keys}</Text>
      <Text testID="doubles">{String(doubles)}</Text>
      <Pressable ref={anchor} testID="open" onPress={() => setOpen(true)}>
        <Text>open</Text>
      </Pressable>
      <Flyout
        isOpen={open}
        target={anchor}
        placement="bottom"
        onDismiss={() => setOpen(false)}
      >
        <Text testID="flyout">flyout content</Text>
      </Flyout>
    </View>
  );
}
