"use client";
import { StackLayout } from "../../../../../../src/navigation/mod.ts"; // relative: the test process uses the root import map

// The stack: every route under /items is a screen.
export function ItemsStack({ children }: { children: unknown }) {
  return (
    <StackLayout
      base="/items"
      platform="ios"
      screenOptions={{ headerShown: true }}
    >
      {children as never}
    </StackLayout>
  );
}
