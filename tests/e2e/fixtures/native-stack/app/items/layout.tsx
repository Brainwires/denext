import { ItemsStack } from "./stack.tsx";

export default function Layout({ children }: { children: unknown }) {
  return <ItemsStack>{children}</ItemsStack>;
}
