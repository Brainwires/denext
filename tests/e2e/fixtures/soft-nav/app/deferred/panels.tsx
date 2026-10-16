"use client";
import { Suspense } from "denext";
import { Await } from "denext/remix";

export function Panels({ fast, slow }: { fast: Promise<string>; slow: Promise<string> }) {
  return (
    <div>
      <Suspense fallback={<i data-testid="fast-wait">loading fast</i>}>
        <Await resolve={fast}>{(v: string) => <b data-testid="fast">{v}</b>}</Await>
      </Suspense>
      <Suspense fallback={<i data-testid="slow-wait">loading slow</i>}>
        <Await resolve={slow}>{(v: string) => <b data-testid="slow">{v}</b>}</Await>
      </Suspense>
    </div>
  );
}
