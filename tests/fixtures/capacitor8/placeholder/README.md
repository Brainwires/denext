# Capacitor's placeholder icons

`AppIcon-512@2x.png` (iOS) and `ic_launcher-mdpi.png` (Android `mipmap-mdpi/ic_launcher.png`) are
the files `npx cap add` copies from `@capacitor/cli` 8.5.2's templates (the same bytes as 7.6.9):
the Capacitor logo. `denext mobile doctor --store` flags them and `denext mobile build` replaces
them; the tests check both against these real files. Capacitor is MIT-licensed
(https://github.com/ionic-team/capacitor).
