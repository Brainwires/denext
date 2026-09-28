// fallow-ignore-file unused-file
// React Native mode picks this `.web.tsx` over platform.tsx for `./platform` (fallow cannot see
// the platform extensions).
import { Text } from "react-native";

export function Platform() {
  return <Text testID="platform">web</Text>;
}
