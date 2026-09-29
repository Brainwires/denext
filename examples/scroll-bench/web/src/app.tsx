// The bench shell: `?list=<impl>&kind=<kind>&n=<size>` (or the deep link
// `denextscrollbench://run?…`, see main.tsx) picks one cell; without one, a menu of links.

import { ErrorBoundary, Suspense, useEffect, useLayoutEffect, useRef, useState } from "denext";
import { type BenchList, makeItems } from "../../shared/data.ts";
import {
  cellPlan,
  IMPLS,
  KINDS,
  MAX_N,
  type RunParams,
  runQuery,
  SIZES,
} from "../../shared/scenarios.ts";
import { bench, type ListHandle, log, setController, setFps, setFpsListener } from "./bench.ts";
import { implComponent } from "./impls/index.ts";
import { createController, startCell } from "./runner.ts";

/**
 * `n` with comma thousands separators ("100,000"). Not `toLocaleString`: its first call
 * initializes Intl (ICU data), which cost 40–57 ms (6x CPU throttle) inside every cell's
 * measured time-to-ready — the overlay renders with the list.
 */
function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function App({ initial, subscribe }: {
  initial: RunParams | null;
  /** Deep-link run requests (main.tsx). */
  subscribe: (fn: (p: RunParams) => void) => () => void;
}) {
  const [params, setParams] = useState(initial);
  useEffect(() => subscribe(setParams), []);
  useEffect(() => {
    if (params) history.replaceState(null, "", `/?${runQuery(params)}`);
  }, [params]);
  if (!params) return <Menu />;
  return <Cell key={runQuery(params)} params={params} />;
}

function Menu() {
  return (
    <div className="sb-scroller sb-menu">
      <h1>denext scroll bench</h1>
      {IMPLS.filter((d) => d.app === "denext").map((d) => (
        <div key={d.id}>
          <h2>{d.label} ({d.id})</h2>
          {KINDS.map((kind) => (
            <div key={kind}>
              {kind}: {SIZES.filter((n) => n <= MAX_N[kind]).map((n) => (
                <a
                  key={n}
                  href={`/?${runQuery({ list: d.id, kind, n, seed: 1 })}`}
                >
                  {groupDigits(n)}
                </a>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Overlay({ params }: { params: RunParams }) {
  const [fps, setFpsText] = useState("");
  const [on, setOn] = useState(false);
  useEffect(() => {
    setFpsListener(setFpsText);
    return () => setFpsListener(null);
  }, []);
  return (
    <div className="sb-overlay">
      <span>
        {params.list} · {params.kind} · {groupDigits(params.n)}
      </span>
      {fps && <span>{fps}</span>}
      <button
        type="button"
        onClick={() => {
          setOn(!on);
          setFps(!on);
        }}
      >
        fps
      </button>
    </div>
  );
}

function Cell({ params }: { params: RunParams }) {
  const plan = cellPlan("denext", params.list, params.kind, params.n);
  return (
    <>
      {plan.run ? <Runner params={params} /> : <Skipped params={params} reason={plan.reason} />}
      <Overlay params={params} />
    </>
  );
}

function Skipped({ params, reason }: { params: RunParams; reason: string }) {
  useEffect(() => {
    log("skipped", { app: "denext", ...params, reason });
  }, []);
  return <div className="sb-message">Skipped: {reason}</div>;
}

function Crashed({ error }: { error: unknown }) {
  useEffect(() => {
    log("error", { message: String((error as Error)?.message ?? error) });
  }, []);
  return (
    <div className="sb-message">
      Crashed: {String((error as Error)?.message ?? error)}
    </div>
  );
}

function Runner({ params }: { params: RunParams }) {
  const Impl = implComponent(params.list)!;
  const [list, setList] = useState<BenchList>(() => makeItems(params.kind, params.n, params.seed));
  const listRef = useRef(list);
  listRef.current = list;
  const handleRef = useRef<ListHandle | null>(null);
  const afterCommit = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const done = afterCommit.current;
    afterCommit.current = null;
    done?.();
  }, [list]);

  // Ready: the first frame with rows painted (and, for chat, positioned at the newest one).
  useEffect(() => {
    let cancelled = false;
    const handle = () => handleRef.current;
    const controller = createController({
      handle,
      list: () => listRef.current,
      commit: (next) =>
        new Promise<void>((resolve) => {
          afterCommit.current = resolve;
          setList(next);
        }),
    });
    void startCell(params, handle, () => cancelled, controller);
    return () => {
      cancelled = true;
      bench.ready = false;
      setController(null);
    };
  }, []);

  return (
    <ErrorBoundary fallback={Crashed}>
      <Suspense
        fallback={<div className="sb-message">Loading {params.list}…</div>}
      >
        <Impl list={list} handleRef={handleRef} />
      </Suspense>
    </ErrorBoundary>
  );
}
