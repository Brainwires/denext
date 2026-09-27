import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";

export default function Home() {
  const router = useRouter();
  return (
    <View testID="home">
      <Text>home</Text>
      <Pressable testID="push" onPress={() => router.push("/details")}>
        <Text>push details</Text>
      </Pressable>
      <Pressable testID="to-tabs" onPress={() => router.push("/tabs/one")}>
        <Text>tabs</Text>
      </Pressable>
    </View>
  );
}
