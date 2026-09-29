// The React Native bench shell: `rnscrollbench://run?list=…&kind=…&n=…` picks a cell (cold
// start: Linking.getInitialURL; warm: the `url` event), `rnscrollbench://action?op=…` drives
// it. Without a link, a menu of cells.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { type BenchList, makeItems } from "../../shared/data.ts";
import {
  type ActionInfo,
  type ActionParams,
  ANCHOR,
  cellPlan,
  findImpl,
  IMPLS,
  KINDS,
  MAX_N,
  parseLink,
  type ReadyInfo,
  type RunParams,
  runQuery,
  SIZES,
} from "../../shared/scenarios.ts";
import { COLORS, MONO_FONT } from "../../shared/theme.ts";
import {
  type BenchController,
  frames,
  installErrorReporting,
  type ListHandle,
  log,
  runAction,
  setController,
  setFps,
  setFpsListener,
} from "./bench";
import { NATIVE_IMPLS } from "./lists";

/** JS start, the base of the ready marker's `ms` (the harness times launch → ready itself). */
const JS_START = Date.now();

export function BenchApp() {
  const [params, setParams] = useState<RunParams | null>(null);
  useEffect(() => {
    installErrorReporting();
    const handle = (url: string | null | undefined) => {
      const link = url ? parseLink(url) : null;
      if (link?.type === "run") setParams(link.params);
      else if (link?.type === "action") void runAction(link.params);
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", ({ url }) => handle(url));
    return () => sub.remove();
  }, []);
  return (
    <View style={st.root}>
      <StatusBar barStyle="dark-content" />
      {params ? <Cell key={runQuery(params)} params={params} /> : <Menu onPick={setParams} />}
    </View>
  );
}

function Menu({ onPick }: { onPick: (p: RunParams) => void }) {
  return (
    <ScrollView contentContainerStyle={st.menu}>
      <Text style={st.h1}>RN scroll bench</Text>
      {IMPLS.filter((d) => d.app === "rn").map((d) => (
        <View key={d.id}>
          <Text style={st.h2}>{d.label} ({d.id})</Text>
          {KINDS.filter((k) => !d.kinds || d.kinds.includes(k)).map((kind) => (
            <View key={kind} style={st.menuRow}>
              <Text style={st.menuText}>{kind}:</Text>
              {SIZES.filter((n) =>
                n <= MAX_N[kind]
              ).map((n) => (
                <Pressable
                  key={n}
                  onPress={() => onPick({ list: d.id, kind, n, seed: 1 })}
                >
                  <Text style={st.link}>{n.toLocaleString("en-US")}</Text>
                </Pressable>
              ))}
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
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
    <View style={st.overlay} pointerEvents="box-none">
      <Text style={st.overlayText}>
        {params.list} · {params.kind} · {params.n.toLocaleString("en-US")}
        {fps ? `  ${fps}` : ""}
      </Text>
      <Pressable
        style={st.overlayButton}
        onPress={() => {
          setOn(!on);
          setFps(!on);
        }}
      >
        <Text style={st.overlayText}>fps</Text>
      </Pressable>
    </View>
  );
}

function Cell({ params }: { params: RunParams }) {
  const plan = cellPlan("rn", params.list, params.kind, params.n);
  return (
    <View style={st.root}>
      {plan.run ? <Runner params={params} /> : <Skipped params={params} reason={plan.reason} />}
      <Overlay params={params} />
    </View>
  );
}

function Skipped({ params, reason }: { params: RunParams; reason: string }) {
  useEffect(() => {
    log("skipped", { app: "rn", ...params, reason });
  }, []);
  return <Text style={st.message}>Skipped: {reason}</Text>;
}

function Runner({ params }: { params: RunParams }) {
  const Impl = NATIVE_IMPLS[params.list];
  const [list, setList] = useState<BenchList>(() => makeItems(params.kind, params.n, params.seed));
  const listRef = useRef(list);
  listRef.current = list;
  const handleRef = useRef<ListHandle | null>(null);
  const rowSeen = useRef(false);
  const afterCommit = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const done = afterCommit.current;
    afterCommit.current = null;
    done?.();
  }, [list]);

  useEffect(() => {
    let cancelled = false;
    const t0 = Date.now();
    const commit = (next: (l: BenchList) => BenchList) =>
      new Promise<void>((resolve) => {
        afterCommit.current = resolve;
        setList(next);
      });
    const controller: BenchController = {
      async run(a: ActionParams): Promise<ActionInfo> {
        const start = Date.now();
        const h = handleRef.current;
        const l = listRef.current;
        if (!h) return { op: a.op, ok: false, ms: 0, reason: "no list mounted" };
        const clamp = (i: number) => Math.max(0, Math.min(l.count - 1, i));
        switch (a.op) {
          case "append":
          case "prepend": {
            if (!l.canGrow) return { op: a.op, ok: false, ms: 0, reason: `${l.kind} cannot grow` };
            const k = a.k ?? 50;
            if (a.op === "append") {
              const atEnd = h.isAtEnd();
              await commit((x) => x.withAppended(k));
              if (atEnd && !h.sticksToEnd) h.scrollToEnd();
            } else {
              await commit((x) => x.withPrepended(k));
            }
            break;
          }
          case "scrollToIndex":
            h.scrollToIndex(clamp(a.i ?? 0));
            break;
          case "scrollToEnd":
            h.scrollToEnd();
            break;
          case "scrollToStart":
            h.scrollToStart();
            break;
          default:
            return { op: a.op, ok: false, ms: 0, reason: "unsupported" };
        }
        await frames(2);
        return { op: a.op, ok: true, ms: Date.now() - start, count: listRef.current.count };
      },
    };
    (async () => {
      while (!cancelled && !(handleRef.current && rowSeen.current)) {
        if (Date.now() - t0 > 60_000) {
          log("error", { app: "rn", ...params, message: "no rows rendered within 60 s" });
          return;
        }
        await frames(1);
      }
      if (cancelled) return;
      if (ANCHOR[params.kind] === "end") {
        handleRef.current!.scrollToEnd();
        await frames(2);
        handleRef.current!.scrollToEnd();
      }
      await frames(2);
      if (cancelled) return;
      const info: ReadyInfo = {
        app: "rn",
        list: params.list,
        kind: params.kind,
        n: params.n,
        ms: Date.now() - JS_START,
        data: findImpl("rn", params.list)?.data,
        notes: [],
      };
      log("ready", info);
      setController(controller);
    })();
    return () => {
      cancelled = true;
      setController(null);
    };
  }, []);

  return (
    <Impl
      list={list}
      handleRef={handleRef}
      onRow={() => {
        rowSeen.current = true;
      }}
    />
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  menu: { padding: 16, paddingBottom: 48 },
  h1: { fontSize: 18, fontWeight: "700", marginVertical: 8, color: COLORS.text },
  h2: { fontSize: 15, fontWeight: "700", marginTop: 16, marginBottom: 4, color: COLORS.text },
  menuRow: { flexDirection: "row", gap: 10, flexWrap: "wrap", marginVertical: 2 },
  menuText: { fontSize: 14, lineHeight: 20, color: COLORS.text },
  link: { fontSize: 14, lineHeight: 20, color: COLORS.link },
  message: { padding: 16, fontSize: 15, lineHeight: 21, color: COLORS.text },
  overlay: {
    position: "absolute",
    top: 4,
    right: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: COLORS.overlayBg,
    borderRadius: 6,
    paddingVertical: 3,
    paddingHorizontal: 6,
  },
  overlayText: { color: COLORS.overlayText, fontSize: 11, lineHeight: 14, fontFamily: MONO_FONT },
  overlayButton: {
    borderWidth: 1,
    borderColor: COLORS.overlayText,
    borderRadius: 4,
    paddingHorizontal: 4,
  },
});
