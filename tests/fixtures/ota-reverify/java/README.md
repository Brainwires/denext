The slice of the Android SDK, AndroidX, Capacitor 8 and org.json that the `denext mobile add-ota`
Java templates use, as plain-JDK stand-ins. `tests/ota-reverify.test.ts` compiles the templates
against them with `javac` and runs `OtaReverifyHarness.java` (where `javac` and `java` exist).
They model behaviour only as far as the harness needs it: `SharedPreferences` is an in-memory map,
`AssetManager` reads a directory, `Bridge` reports the directory it serves.
