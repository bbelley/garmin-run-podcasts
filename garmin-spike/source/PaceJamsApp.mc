using Toybox.Application;
using Toybox.Lang;
using Toybox.Media;
using Toybox.WatchUi;

class PaceJamsApp extends Application.AudioContentProviderApp {
    function initialize() {
        AudioContentProviderApp.initialize();
    }

    function getSyncDelegate() {
        return LocalConfig.QUEUE_MODE ? new QueueSyncDelegate() : new ClipSyncDelegate();
    }

    function getContentDelegate(args) {
        if (LocalConfig.QUEUE_MODE && args != true &&
            (!(args instanceof Lang.Dictionary) || args["legacy"] != true)) {
            return new QueueContentDelegate(args instanceof Lang.Dictionary ? args["item_id"] : null);
        }
        return new ClipContentDelegate(args == true);
    }

    function getSyncConfigurationView() {
        return configurationView();
    }

    function getPlaybackConfigurationView() {
        return configurationView();
    }

    function configurationView() {
        if (LocalConfig.QUEUE_MODE) { return queueConfigurationView(); }
        var menu = new WatchUi.Menu2({:title => WatchUi.loadResource(Rez.Strings.AppName) as Lang.String});
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
    var download = Application.Storage.getValue("clipDownload");
    if (!(download instanceof Lang.Dictionary) || !LocalConfig.MP3_SOURCE.equals(download["source"])) {
        return null;
    }
    var id = download["ref"];
    if (!(id instanceof Lang.String)) {
        return null;
    }
    var ref = cachedClipRefs()[id];
    return ref == null ? null : Media.getCachedContentObj(ref);
}

function cachedClipRefs() as Lang.Dictionary<Lang.String, Media.ContentRef> {
    var refs = {} as Lang.Dictionary<Lang.String, Media.ContentRef>;
    var iterator = Media.getContentRefIter({:contentType => Media.CONTENT_TYPE_AUDIO});
    if (iterator != null) {
        for (var ref = iterator.next(); ref != null; ref = iterator.next()) {
            refs[ref.getId().toString()] = ref;
        }
    }
    return refs;
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
