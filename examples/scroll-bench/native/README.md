# RN scroll bench

The React Native twin of the denext scroll benchmark (see `../README.md`). A bare React Native
0.87 CLI app (New Architecture, Hermes), package `com.brainwires.rnscrollbench`, drawing the
same `../shared` data with the same row designs as `../web`.

- `src/lists.tsx`: the list impls (`flatlist`, `flash`, `legend`, `sectionlist`)
- `src/rows.tsx`: the rows, from `../shared/theme.ts`
- `src/app.tsx`: deep links (`rnscrollbench://run?…`, `rnscrollbench://action?…`), the runner,
  the logcat markers
- `metro.config.js`: watches `../shared`

```sh
npm ci
npm run bundle:android          # release JS bundle (checks the ../shared imports resolve)
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=x86_64 \
  -Pandroid.injected.signing.store.file=<throwaway.jks> …   # see ../build-apks.sh
```

No keystore is committed; `../build-apks.sh` makes a throwaway one on the build host. A debug
build needs `android/app/debug.keystore` (`keytool -genkeypair -keystore android/app/debug.keystore
-storepass android -keypass android -alias androiddebugkey -dname "CN=Android Debug"`).
The iOS project is the template's; no Pods are installed.
