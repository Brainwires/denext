"use client";
import { RAW } from "../raw.ts";

export function Inner({ n }: { n: number }) {
  return <div id="raw" data-n={String(n)} dangerouslySetInnerHTML={{ __html: RAW }} />;
}
