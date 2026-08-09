# denext native example — desktop + mobile

One [denext](../../) app packaged three ways: the **web**, a **native desktop
app** via [`deno desktop`](https://docs.deno.com/runtime/desktop/), and **iOS /
Android** via [Capacitor](https://capacitorjs.com). All three serve the same
static export (`deno task export` → `out/`).

## Web

```sh
deno task dev      # → http://localhost:3000
deno task start    # serve the production build
```

## Desktop (`deno desktop`, Deno 2.9+)

`desktop.ts` is a `Deno.serve()` handler over the static export; `deno desktop`
wraps it in a native window (native WebView, single binary).

```sh
deno task desktop           # export + open the app in a native window
deno task desktop:package   # export + build a distributable (./dist/)
```

The app name / bundle id live in the `desktop` block of `deno.json`.
Cross-compile with `deno desktop --all-targets desktop.ts`. (Experimental in
Deno 2.9.)

## Mobile (Capacitor)

Capacitor bundles the static export (`webDir: "out"`) into native iOS/Android
shells. Its CLI and platforms are Node packages, so install them once:

```sh
deno install                       # installs the @capacitor/* devDependencies
deno task mobile:sync              # export + copy web assets into the native projects
deno run -A --node-modules-dir npm:@capacitor/cli add ios        # first time only
deno task mobile:ios               # open in Xcode   (needs Xcode)
deno task mobile:android           # open in Android Studio (needs Android Studio)
```

## Files

```
deno.json            tasks + the `desktop` app block
desktop.ts           Deno.serve() over out/  (deno desktop entry)
capacitor.config.ts  appId / appName / webDir: "out"
package.json         Capacitor CLI + platform devDependencies
app/                 the shared denext app
```

`out/`, `dist/`, `node_modules/`, `ios/`, `android/` are all generated and
git-ignored.
