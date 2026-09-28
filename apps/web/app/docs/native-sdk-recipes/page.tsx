// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Native SDK recipes",
  description:
    "Replacements for the native-only SDKs React Native apps use most: Firebase (push through sendPush, auth and Firestore on the JS SDK, analytics and crash reporting), in-app purchases (RevenueCat or a StoreKit plugin) and Stripe (Stripe.js or a Capacitor plugin).",
};

export default async function NativeSdkRecipes() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
