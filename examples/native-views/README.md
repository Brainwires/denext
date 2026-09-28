# Native views in the layout (Capacitor)

A denext SPA in a Capacitor 8 shell that puts native views inside a scrolling
`VirtualList`: a map of London (row 3, `placement="auto"`: embedded on iOS,
drawn over the WebView on Android), a video player (row 12) and a map of Lisbon
drawn under the WebView (row 40, `placement="under"`). Each is a
`NativeViewSlot` from `denext/mobile`; the rest of every row is DOM. Each map
has a DOM "Recenter" button drawn over it (the slot's `overlay`), and the
header's "Open sheet" covers the page with a sheet, to show how a covered view
behaves.

In a desktop browser (`deno task dev`) the slots render their children, the web
fallback: a placeholder for the maps and a `<video>` element.

## Run it

```sh
npm install            # the Capacitor packages (package.json)
deno task dev          # the UI in a browser: http://localhost:3000
deno task cap:sync     # export + `cap sync` into ios/ and android/
DENEXT_IOS_TEAM=ABCDE12345 deno task ios   # a signed Debug build (xcodebuild)
deno task ios:check    # an unsigned compile check
deno task android      # android/app/build/outputs/apk/debug/app-debug.apk
```

## How it was made

```sh
npm install --save-exact @capacitor/core@8.5.2 @capacitor/ios@8.5.2 @capacitor/android@8.5.2
npm install --save-exact -D @capacitor/cli@8.5.2
deno task export && npx cap add ios && npx cap add android
deno run -A --node-modules-dir=none ../../cli.ts mobile add native-map
```

`mobile add native-map` installs `native-views` first: the `DenextNativeViews`
plugin (`ios/App/App/DenextNativeViewsPlugin.swift`,
`android/app/src/main/java/dev/denext/nativeviews/`), registered from
`DenextBridgeViewController` / `MainActivity`, with the built-in `video` view;
then the `map` view (`DenextMapViewFactory.swift` on MapKit,
`DenextOsmMapFactory.java` on osmdroid, whose dependency it adds to
`android/app/build.gradle`). Neither map needs an API key. OpenStreetMap's tile
servers are for light use; point a production app at its own tile source.

## Device checklist (iPhone)

Build with `deno task cap:sync` then `deno task ios`, and on the phone:

1. **Embed.** London's map shows inside its card with rounded corners. Scroll
   the list slowly and in a fast fling: the map stays glued to the card with no
   lag or tearing, and is clipped at the top edge of the list as it scrolls out.
2. **Touch.** Pan and pinch the map: the map moves, the list does not. Drag the
   list starting on a text row: the list scrolls. Tap "Recenter": the map
   animates back (the button gets the tap, not the map). Tap the marker: nothing
   crashes (the `markerPress` event).
3. **Region events.** After a pan, the line under the map shows the new
   latitude, longitude and zoom. The −/+ buttons change the zoom.
4. **Video.** Row 12 plays the flower clip with the system controls (muted,
   looping); the status line shows `ready` then `play`. Full screen from the
   controls and back works. Scroll it off and back: it is made again (restarts).
5. **Under.** Scroll to row 40 (Lisbon): the map shows through the transparent
   page with the "Recenter" button above it; pan works, the button works, and
   the text rows above and below cover it cleanly as it scrolls out (no map
   drawn over the header or rows). Check the console for no "paints a
   background" warning.
6. **Sheet.** Open the sheet over a visible map: the embedded map is covered by
   the sheet (drawn below it) and does not take touches through it; close it and
   the map takes touches again.
7. **Keyboard / rotation.** Rotate the phone: the maps and video resize with
   their cards. (No text field on this page; the keyboard path is the same
   visual viewport tracking as a resize.)
8. **Fallback check.** If a map ever appears detached from its card (floating
   above the page), note it: that is the `"over"` fallback, meaning the slot's
   scroll view was not found. Report the iOS version.

Android (emulator or device): the same list; row 3 is `"over"` there (it hides
while the sheet covers it), row 40 is `"under"`. Expect the view to trail its
card by a frame or two during a fast fling.
