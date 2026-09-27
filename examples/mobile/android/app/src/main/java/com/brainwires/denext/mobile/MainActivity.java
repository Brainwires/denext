// denext-main-activity-template: 2 sha256=62a68d062e8618f0bbe0b78609762c01a0fc8be924c48641773dffa92d90560b
package com.brainwires.denext.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import dev.denext.settings.DenextSettingsPlugin;
import androidx.activity.EdgeToEdge;
import dev.denext.sharereceive.DenextShareReceivePlugin;
import dev.denext.widgets.DenextWidgetsPlugin;
import dev.denext.authsession.DenextAuthSessionPlugin;
import dev.denext.ota.DenextOta;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // denext over-the-air UI: registers the DenextOta plugin and picks the UI to start
        // from. It must run before super.onCreate, which builds the bridge.
        DenextOta.prepare(this, bridgeBuilder);
        // denext auth sessions: registers the DenextAuthSession plugin (openAuthSession in
        // denext/mobile). It must run before super.onCreate, which builds the bridge.
        registerPlugin(DenextAuthSessionPlugin.class);
        // denext widgets: registers the DenextWidgets plugin (setWidgetData in denext/mobile). It must run before super.onCreate, which builds the bridge.
        registerPlugin(DenextWidgetsPlugin.class);
        // denext share target: registers the DenextShareReceive plugin (onShareReceived in
        // denext/mobile). It must run before super.onCreate, which builds the bridge.
        registerPlugin(DenextShareReceivePlugin.class);
        // denext system bars: draw edge to edge on every Android version (15+ enforce it),
        // with transparent bars. It must run before super.onCreate.
        EdgeToEdge.enable(this);
        // denext app settings: registers the DenextSettings plugin (openAppSettings in
        // denext/mobile). It must run before super.onCreate, which builds the bridge.
        registerPlugin(DenextSettingsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
