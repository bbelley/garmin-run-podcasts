using Toybox.Application;
using Toybox.Lang;
using Toybox.Media;
using Toybox.WatchUi;

class OutBacklogApp extends Application.AudioContentProviderApp {
    function initialize() {
        AudioContentProviderApp.initialize();
    }

    function getSyncDelegate() {
        return new ClipSyncDelegate();
    }

    function getContentDelegate(args) {
        return new ClipContentDelegate(args == true);
    }

    function getSyncConfigurationView() {
        return configurationView();
    }

    function getPlaybackConfigurationView() {
        return configurationView();
    }

    function configurationView() {
        var menu = new WatchUi.Menu2({:title => "Out & Backlog"});
        var clip = cachedClip();
        menu.addItem(new WatchUi.MenuItem("Sync Now", "Wi-Fi", :sync, null));
        if (clip != null) {
            var seconds = savedClipPosition(clip);
            var bookmark = seconds > 0 ? "Saved at " + seconds + " s" : null;
            menu.addItem(new WatchUi.MenuItem("Play Test Clip", bookmark, :play, null));
            menu.addItem(new WatchUi.MenuItem("Test Next Track", "Two copies of the clip", :testNext, null));
        }
        menu.addItem(new WatchUi.MenuItem("Completions: " + completionCount(), null, :status, null));
        return [menu, new SpikeMenuDelegate()];
    }
}

function cachedClip() {
    var refs = Media.getContentRefIter({:contentType => Media.CONTENT_TYPE_AUDIO});
    var ref = refs == null ? null : refs.next();
    return ref == null ? null : Media.getCachedContentObj(ref);
}

function completionCount() {
    var count = Application.Storage.getValue("completions");
    return count == null ? 0 : count;
}

function savedClipPosition(clip) {
    var bookmark = Application.Storage.getValue("clipBookmark");
    if (!(bookmark instanceof Lang.Dictionary)) {
        return 0;
    }
    var refId = clip.getContentRef().getId().toString();
    var seconds = bookmark["seconds"];
    return refId.equals(bookmark["ref"]) && seconds instanceof Lang.Number ? seconds : 0;
}
