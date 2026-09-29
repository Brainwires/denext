import { Tabs } from "expo-router";

export default function TabsLayout() {
  return (
    <Tabs>
      <Tabs.Screen name="one" options={{ title: "One" }} />
      <Tabs.Screen name="two" options={{ title: "Two" }} />
    </Tabs>
  );
}
