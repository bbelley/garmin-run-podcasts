using Toybox.Application;
using Toybox.Communications;
using Toybox.Lang;
using Toybox.Media;
using Toybox.PersistedContent;
using Toybox.System;

class ClipSyncDelegate extends Communications.SyncDelegate {
    private var _previousRefs as Lang.Dictionary<Lang.String, Media.ContentRef> or Null = null;

    function initialize() {
        SyncDelegate.initialize();
    }

    function isSyncNeeded() {
        return true;
    }

    function onStartSync() {
        System.println("PaceJams sync completions=" + completionCount());
        if (cachedClip() != null) {
            System.println("PaceJams sync cache hit");
            Communications.notifySyncComplete(null);
            return;
        }

        _previousRefs = cachedClipRefs();
        Communications.makeWebRequest(LocalConfig.MP3_URL, null, {
            :method => Communications.HTTP_REQUEST_METHOD_GET,
            :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_AUDIO,
            :mediaEncoding => Media.ENCODING_MP3
        }, method(:onDownload));
    }

    function onStopSync() {
        if (_previousRefs == null) {
            return;
        }
        _previousRefs = null;
        Communications.cancelAllRequests();
        System.println("PaceJams sync canceled");
        Communications.notifySyncComplete(null);
    }

    // The SDK's static callback signature omits the audio ref. Check the native cache instead.
    function onDownload(code as Lang.Number,
        data as Lang.ByteArray or Lang.Dictionary or Lang.String or PersistedContent.Iterator or Null) as Void {
        var previous = _previousRefs;
        if (previous == null) {
            return;
        }
        _previousRefs = null;
        System.println("PaceJams download response=" + code);
        if (code != 200) {
            Communications.notifySyncComplete("MP3 download failed (" + code + ")");
            return;
        }

        var refs = cachedClipRefs();
        var ids = refs.keys();
        var added = [] as Lang.Array<Lang.String>;
        for (var index = 0; index < ids.size(); index += 1) {
            var id = ids[index];
            if (!previous.hasKey(id)) {
                added.add(id);
            }
        }
        if (added.size() != 1) {
            Communications.notifySyncComplete("Expected one new MP3 cache entry");
            return;
        }

        Application.Storage.setValue("clipDownload", {"source" => LocalConfig.MP3_SOURCE, "ref" => added[0]});
        // Retain the old cache until the new file is available and associated with this source.
        var staleRefs = previous.values();
        for (var index = 0; index < staleRefs.size(); index += 1) {
            try {
                Media.deleteCachedItem(staleRefs[index]);
            } catch (exception) {
                System.println("PaceJams old cache removal failed");
            }
        }
        Communications.notifySyncProgress(100);
        Communications.notifySyncComplete(null);
    }
}
