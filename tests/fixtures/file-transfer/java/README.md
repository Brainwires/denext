The slice of the Android SDK, AndroidX (WorkManager), Capacitor 8 and org.json that the
`denext mobile add file-transfer` worker, store and plugin use, as plain-JDK stand-ins.
`tests/mobile-file-transfer-native.test.ts` compiles those templates against them with `javac` and
runs `../TransferWorkerHarness.java` (where `javac` and `java` exist). They model behaviour only as
far as the harness needs it: `SharedPreferences` is the harness's in-memory map, `Handler` runs
posted work at once, `WorkManager` records the unique work it is given (the harness runs each
worker itself and lands each cancel at a fixed point in it), and a cancel stops the worker.
The org.json, `JSObject`, `Handler` and annotation files start from `../../ota-reverify/java/`.
