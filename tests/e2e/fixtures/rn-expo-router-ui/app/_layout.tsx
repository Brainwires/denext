import { TabList, Tabs, TabSlot, TabTrigger, type TabTriggerSlotProps } from "expo-router/ui";
import { Pressable, Text } from "react-native";

function TabButton({ children, isFocused, ...props }: TabTriggerSlotProps) {
  return (
    <Pressable {...props} testID={`tab-${String(children).toLowerCase()}`}>
      <Text style={{ fontWeight: isFocused ? "700" : "400", padding: 12 }}>{children}</Text>
    </Pressable>
  );
}

export default function Layout() {
  return (
    <Tabs>
      <TabSlot />
      <TabList>
        <TabTrigger name="index" href="/" asChild>
          <TabButton>First</TabButton>
        </TabTrigger>
        <TabTrigger name="second" href="/second" asChild>
          <TabButton>Second</TabButton>
        </TabTrigger>
      </TabList>
    </Tabs>
  );
}
