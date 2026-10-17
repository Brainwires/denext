"use client";
// A client island on react-native-web: server-rendered, then hydrated.
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

const styles = StyleSheet.create({ button: { borderWidth: 1, padding: 4 } });

export function Counter() {
  const [n, setN] = useState(0);
  return (
    <View>
      <Text testID="island">{`RN_ISLAND:${n}`}</Text>
      <Pressable testID="press" style={styles.button} onPress={() => setN(n + 1)}>
        <Text>press</Text>
      </Pressable>
    </View>
  );
}
