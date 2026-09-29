import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";

export default function Details() {
  const router = useRouter();
  return (
    <View testID="details">
      <Text>details</Text>
      <Pressable testID="back" onPress={() => router.back()}>
        <Text>back</Text>
      </Pressable>
    </View>
  );
}
