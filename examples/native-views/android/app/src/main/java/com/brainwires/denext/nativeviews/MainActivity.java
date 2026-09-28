// denext-main-activity-template: 2 sha256=46fd450e2455ddc2e6c2663f59aadbc3979e0beb1c81d2ef7623134bfea97bc0
package com.brainwires.denext.nativeviews;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import dev.denext.contextmenu.DenextContextMenuPlugin;
import dev.denext.storage.DenextStoragePlugin;
import dev.denext.nativemodules.DenextNativeModules;
import dev.denext.nativeviews.DenextNativeViewsPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // denext native views: registers the DenextNativeViews plugin (NativeViewSlot in
        // denext/mobile). It must run before super.onCreate, which builds the bridge.
        registerPlugin(DenextNativeViewsPlugin.class);
        // The app's own native modules (denext mobile add native-module). It must run
        // before super.onCreate, which builds the bridge.
        DenextNativeModules.register(this);
        // denext durable storage: registers the DenextStorage plugin (openKeyValueStore in
        // denext/mobile). It must run before super.onCreate, which builds the bridge.
        registerPlugin(DenextStoragePlugin.class);
        // denext native menus: registers the DenextContextMenu plugin (showContextMenu in
        // denext/mobile). It must run before super.onCreate, which builds the bridge.
        registerPlugin(DenextContextMenuPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
