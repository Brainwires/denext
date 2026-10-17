// A Server Component rendering react-native-web components: their markup and atomic CSS come
// from the server render.
import { StyleSheet, Text, View } from "react-native";
import { Counter } from "../components/counter.tsx";
import { label } from "../components/label";

const styles = StyleSheet.create({
  box: { padding: 8 },
  text: { color: "red" },
});

export default function Page() {
  return (
    <View style={styles.box}>
      <Text testID="server-text" style={styles.text}>RN_SERVER_TEXT {label}</Text>
      <Counter />
    </View>
  );
}
