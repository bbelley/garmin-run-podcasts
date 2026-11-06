using Toybox.Communications;
using Toybox.Lang;
using Toybox.Media;
using Toybox.PersistedContent;
using Toybox.System;

class ClipSyncDelegate extends Communications.SyncDelegate {
    function initialize() {
        SyncDelegate.initialize();
    }

    function isSyncNeeded() {
        return true;
    }

    function onStartSync() {
        System.println("OBL sync completions=" + completionCount());
        if (cachedClip() != null) {
            System.println("OBL sync cache hit");
            Communications.notifySyncComplete(null);
            return;
        }

        Communications.makeWebRequest(LocalConfig.MP3_URL, null, {
            :method => Communications.HTTP_REQUEST_METHOD_GET,
            :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_AUDIO,
            :mediaEncoding => Media.ENCODING_MP3
        }, method(:onDownload));
    }

    function onStopSync() {
        Communications.cancelAllRequests();
        System.println("OBL sync canceled");
        Communications.notifySyncComplete(null);
    }

    // The SDK's static callback signature omits the audio ref. Check the native cache instead.
    function onDownload(code as Lang.Number,
        data as Lang.ByteArray or Lang.Dictionary or Lang.String or PersistedContent.Iterator or Null) as Void {
        System.println("OBL download response=" + code);
        if (code != 200 || cachedClip() == null) {
            Communications.notifySyncComplete("MP3 download failed (" + code + ")");
            return;
        }
        Communications.notifySyncProgress(100);
        Communications.notifySyncComplete(null);
    }
}
