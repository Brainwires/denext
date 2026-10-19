// The fragment inside the Canvas is the point: Skia's renderer must take denext's `<>`.
// deno-lint-ignore-file jsx-no-useless-fragment
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Canvas, Circle, Group, Rect, useCanvasRef } from "@shopify/react-native-skia";

const g = globalThis as Record<string, unknown>;

/** A component Skia's own reconciler renders, with state and an effect of its own. */
function Dot({ x }: { x: number }) {
  const [shown, setShown] = useState(false);
  useEffect(() => setShown(true), []);
  return shown ? <Circle cx={x} cy={20} r={10} color="#0000ff" /> : null;
}

export function App() {
  const [radius, setRadius] = useState(40);
  const ref = useCanvasRef();
  useEffect(() => {
    // Read the drawn pixels back through Skia (a WebGL canvas can't be read from the page).
    g.__skiaPixels = () => {
      const image = ref.current?.makeImageSnapshot();
      const px = image?.readPixels(0, 0, {
        width: 200,
        height: 200,
        alphaType: 2, // Unpremul
        colorType: 4, // RGBA_8888
      }) as Uint8Array | null | undefined;
      if (!px) return null;
      const at = (x: number, y: number) => [...px.slice((y * 200 + x) * 4, (y * 200 + x) * 4 + 4)];
      return { center: at(100, 100), corner: at(5, 5), dot: at(180, 20), ring: at(100, 45) };
    };
  });
  return (
    <View testID="screen">
      <Canvas ref={ref} style={{ width: 200, height: 200 }}>
        <Group>
          <>
            <Rect x={0} y={0} width={10} height={10} color="#00ff00" />
            <Circle cx={100} cy={100} r={radius} color="#ff0000" />
          </>
          <Dot x={180} />
        </Group>
      </Canvas>
      <Pressable testID="grow" onPress={() => setRadius(radius + 20)}>
        <Text>radius {radius}</Text>
      </Pressable>
    </View>
  );
}
