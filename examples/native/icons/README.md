# App icons

This example ships a full icon set — `app.icns` (macOS), `app.ico` (Windows), and
`app.png` (Linux) — already wired into the `desktop` block of `deno.json`, so
`deno task desktop:package` picks them up. Replace them with your own artwork to
rebrand.

`deno desktop` uses a default icon unless you provide your own. The wiring in
`deno.json` looks like:

```jsonc
"desktop": {
  "app": {
    "name": "denext native",
    "identifier": "com.example.denext-native",
    "icons": {
      "macos": "./icons/app.icns",
      "windows": "./icons/app.ico",
      "linux": "./icons/app.png"
    }
  }
}
```

- **macOS** `app.icns` · **Windows** `app.ico` · **Linux** `app.png` (512×512+)
