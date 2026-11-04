// Every hook whose client implementation is its own module (src/client/fiber/hooks/) or rides the
// transition engine (src/runtime/hooks/transition.ts), called once: the positive half of their
// FEATURE_MARKERS. A plain module the isomorphic page imports, so the hooks run on the client.

import {
  startTransition,
  useActionState,
  useDeferredValue,
  useEffectEvent,
  useId,
  useInsertionEffect,
  useOptimistic,
  useReducer,
  useSyncExternalStore,
  useTransition,
} from "denext";
import { useMemoCache } from "denext/compiler-runtime";

const subscribe = (onChange: () => void) => {
  addEventListener("resize", onChange);
  return () => removeEventListener("resize", onChange);
};

export function Hooks() {
  const id = useId();
  const [n, add] = useReducer((s: number, by: number) => s + by, 0);
  const width = useSyncExternalStore(subscribe, () => innerWidth, () => 0);
  const deferred = useDeferredValue(n);
  const slots = useMemoCache(1);
  useInsertionEffect(() => {
    document.documentElement.dataset.hooks = "1";
  }, []);
  const onTick = useEffectEvent(() => add(1));
  const [pending, start] = useTransition();
  const [optimistic, addOptimistic] = useOptimistic(n, (s: number, by: number) => s + by);
  const [state, act] = useActionState((prev: number) => prev + 1, 0);
  return (
    <div id={id} data-slots={slots.length}>
      <button type="button" onClick={() => start(() => add(1))}>
        {deferred} {optimistic} {width} {pending ? "…" : ""}
      </button>
      <button type="button" onClick={() => startTransition(() => addOptimistic(1))}>opt</button>
      <button type="button" onClick={onTick}>tick</button>
      <form action={act}>
        <button type="submit">{state}</button>
      </form>
    </div>
  );
}
