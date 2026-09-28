import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";

export default function Home() {
  const router = useRouter();
  return (
    <View testID="home">
      <Text>home</Text>
      <Ionicons testID="icon" name="home" size={24} color="rgb(1, 2, 3)" />
      <Pressable testID="push" onPress={() => router.push("/details")}>
        <Text>push details</Text>
      </Pressable>
      <Pressable testID="to-tabs" onPress={() => router.push("/tabs/one")}>
        <Text>tabs</Text>
      </Pressable>
    </View>
  );
}
