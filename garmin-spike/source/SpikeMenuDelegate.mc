using Toybox.Communications;
using Toybox.Media;
using Toybox.System;
using Toybox.WatchUi;

class SpikeMenuDelegate extends WatchUi.Menu2InputDelegate {
    function initialize() {
        Menu2InputDelegate.initialize();
    }

    function onSelect(item) {
        switch (item.getId()) {
            case :sync:
                Communications.startSync();
                break;
            case :play:
                Media.startPlayback(null);
                break;
            case :testNext:
                Media.startPlayback(true);
                break;
            case :status:
                System.println("PaceJams status completions=" + completionCount());
                break;
        }
    }
}
