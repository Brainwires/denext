// next-intl memoizes `useTranslations` / `useFormatter` and the provider's context value, so
// `useCallback(fn, [t])` + `useEffect(…, [fn])` runs once. A translator rebuilt on every
// render turned that pattern into a render/fetch loop.

import { assert, assertEquals, assertNotStrictEquals, assertStrictEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { render } from "../src/testing/mod.ts";
import { useEffect, useState } from "../mod.ts";
import {
  type Formatter,
  NextIntlClientProvider,
  type Translator,
  useFormatter,
  useMessages,
  useTranslations,
} from "../src/compat/next-intl/index.ts";
import type { NestedMessages } from "../src/compat/next-intl/context.ts";

const messages: NestedMessages = { home: { title: "Hello" } };

Deno.test("next-intl: useTranslations / useFormatter / the provider value survive a re-render", async () => {
  const seen: { t: Translator; root: Translator; f: Formatter; m: NestedMessages }[] = [];
  let effects = 0;
  function Consumer() {
    const t = useTranslations("home");
    const root = useTranslations();
    const f = useFormatter();
    const m = useMessages();
    seen.push({ t, root, f, m });
    // The pattern from the report: an effect keyed on the translator.
    useEffect(() => {
      effects++;
    }, [t]);
    return h("p", null, t("title"));
  }
  function Parent() {
    const [n, setN] = useState(0);
    return h(
      "div",
      null,
      h("button", { type: "button", onClick: () => setN(n + 1) }, `rerender ${n}`),
      h(NextIntlClientProvider, { locale: "en", messages }, h(Consumer, null)),
    );
  }
  const screen = await render(h(Parent, null));
  assertEquals(screen.getByText("Hello").textContent, "Hello");
  await screen.fireEvent.click(screen.getByRole("button"));
  await screen.fireEvent.click(screen.getByRole("button"));
  assert(seen.length >= 1);
  const first = seen[0];
  for (const s of seen) {
    assertStrictEquals(s.t, first.t);
    assertStrictEquals(s.root, first.root);
    assertStrictEquals(s.f, first.f);
    assertStrictEquals(s.m, first.m);
  }
  assertEquals(effects, 1);
  assertNotStrictEquals(first.t, first.root); // a namespace is its own translator
});

Deno.test("next-intl: a new locale or catalog rebuilds the translator", async () => {
  const seen: Translator[] = [];
  function Consumer() {
    const t = useTranslations("home");
    seen.push(t);
    return h("p", null, t("title"));
  }
  const other: NestedMessages = { home: { title: "Bonjour" } };
  function Parent() {
    const [fr, setFr] = useState(false);
    return h(
      "div",
      null,
      h("button", { type: "button", onClick: () => setFr(true) }, "fr"),
      h(
        NextIntlClientProvider,
        { locale: fr ? "fr" : "en", messages: fr ? other : messages },
        h(Consumer, null),
      ),
    );
  }
  const screen = await render(h(Parent, null));
  await screen.fireEvent.click(screen.getByRole("button"));
  assertEquals(screen.getByText("Bonjour").textContent, "Bonjour");
  assertNotStrictEquals(seen[0], seen[seen.length - 1]);
});
