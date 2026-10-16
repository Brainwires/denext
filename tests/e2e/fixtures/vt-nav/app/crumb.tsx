"use client";
import { usePathname, ViewTransition, type ViewTransitionInstance } from "denext";

const w = globalThis as unknown as { __cb?: string[]; __ref?: ViewTransitionInstance | null };
const log = (s: string) => (w.__cb ??= []).push(s);
const ref = (inst: ViewTransitionInstance | null) => {
  w.__ref = inst;
  log(`ref:${inst?.name}`);
};

export function Crumb() {
  const path = usePathname();
  return (
    <>
      <ViewTransition name="crumb" ref={ref} onUpdate={(inst) => log(`update:${inst.name}`)}>
        <p data-testid="crumb">at {path}</p>
      </ViewTransition>
      <ViewTransition name="logo" onUpdate={() => log("update:logo")}>
        <p data-testid="logo">logo</p>
      </ViewTransition>
    </>
  );
}
