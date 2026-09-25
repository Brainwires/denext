package com.brainwires.denext.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
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
        super.onCreate(savedInstanceState);
    }
}
