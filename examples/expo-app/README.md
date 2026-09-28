# Expo app in React Native mode (Capacitor)

Expo's own starter, `expo-template-default@57.0.27` (Expo SDK 57, the npm
tarball
`sha512-E8P3+6k/6QNGKBZGw02/DachMMRUIT8MG0rXq8+N/J7EYZLO+rNH/0DZmDirU/Qwnj1zz6H40ySyS0AJmtZVBw==`,
0BSD, see `LICENSE`), migrated with `denext migrate --from expo` and run by
denext's [React Native mode](https://denext.dev/docs/react-native) inside a
Capacitor 8 shell. The template is unchanged apart from `deno fmt`, a safe-area
top padding on the web tab bar (`src/components/app-tabs.web.tsx`: in the shell
the page runs under the status bar) and a third tab, **Lab**:

- `src/app/lab.tsx`: the React Native APIs to try by hand (haptics, `Alert`,
  `Share`, `Linking.openURL`, a `TextInput` whose value `AsyncStorage` keeps
  across launches, inside a `KeyboardAvoidingView`, and a 200-row `FlatList` of
  images).
- `src/components/self-test.tsx`: the automatic self-test at the top of the tab.
  Each check shows PASS / FAIL / SKIP on screen and logs
  `SELFTEST|<name>|<verdict>|<detail>`, then `SELFTEST|DONE|<passed>/<run>`, for
  Safari's Web Inspector. None shows a system prompt.

It exercises Expo Router (`src/app/`, the headless `expo-router/ui` tabs on the
web), Reanimated 4.5 (the splash overlay, the icon, the self-test),
`expo-image`, `expo-haptics`, `expo-constants`, `expo-device`, `expo-linking`,
`expo-status-bar`, `expo-symbols`, `react-native-safe-area-context`,
AsyncStorage, CSS (`src/global.css`, a CSS module) and `@2x` / `@3x` image
variants.

## Run it

```sh
npm install --legacy-peer-deps   # the app's packages and the Capacitor shell's
deno task dev                    # the app in a browser: http://localhost:3000
deno task export                 # static export → out/ (Capacitor's webDir)
deno task cap:sync               # export + `cap sync ios`
DENEXT_IOS_TEAM=ABCDE12345 deno task ios   # a signed Debug build (xcodebuild)
deno task ios:check              # an unsigned compile check
deno task mobile:dev             # live reload on a phone: the shell loads `denext dev`
```

`mobile:dev` binds `172.20.10.2` (the Mac's address on an iPhone's Personal
Hotspot); pass another with
`deno run -A --node-modules-dir=none ../../cli.ts mobile dev . --host <ip>` or
`--lan`. It points the app's `server.url` at the dev server for the session and
restores `capacitor.config.ts` on exit.

`deno.json` sets `"workspace": []` only because the example sits inside the
denext repository without being a member of its workspace (the esbuild
deno-loader refuses a nested non-member config). An app in its own repository
does not need it.

## How it was made

```sh
npm pack expo-template-default@57.0.27 && tar xzf expo-template-default-57.0.27.tgz
# package/ → examples/expo-app (gitignore → .gitignore, _vscode dropped)
npm install --save expo-haptics@~57.0.3 @react-native-async-storage/async-storage@2.2.0
npm install --legacy-peer-deps
deno run -A --node-modules-dir=none ../../cli.ts migrate --from expo .
# deno.json: the jsr: denext imports pointed at this checkout (../../…)

npm install --save-exact @capacitor/core@8.5.2 @capacitor/ios@8.5.2
npm install --save-exact -D @capacitor/cli@8.5.2
deno task export && npx cap add ios
deno run -A --node-modules-dir=none ../../cli.ts mobile add haptics device splash browser \
  deep-links system-bars storage keyboard dialog share --scheme helloworld
```

The `mobile add` line is the one `migrate` printed (from the app's `expo-*`
packages, its `scheme` and AsyncStorage), plus `keyboard`, `dialog` and `share`
for the Lab tab.

## Device checklist (iPhone)

After `deno task cap:sync` and `deno task ios`:

1. **Launch.** The splash hides and Home shows "Welcome to Expo" with the
   animated Expo icon. The floating tab bar (Expo Starter · Home · Explore · Lab
   · Docs) sits below the status bar.
2. **Lab → self-test.** The card at the top reads `ALL PASS: n/n passed` in a
   few seconds. On the phone nothing is SKIPped (the safe-area check runs only
   in the iOS shell).
3. **Relaunch.** Kill and reopen the app, go to Lab: "AsyncStorage across
   launches" shows a higher run number, and the note typed before is still in
   the text field.
4. **Keyboard.** Tap the note field: the keyboard opens and the field stays
   visible above it.
5. **Try it.** Haptic buzzes; Alert shows a system dialog and the chosen button
   is logged; Share opens the share sheet; "Open expo.dev" opens the in-app
   browser.
6. **FlatList.** Fling the 200-row list: rows with rotated React logos, no blank
   gaps; a tap gives a selection haptic.
7. **Explore.** The collapsible sections open and close; the images are sharp
   (`@3x`).
8. **Deep link.** From Safari, open `helloworld://lab`: the app comes forward on
   the Lab tab.
