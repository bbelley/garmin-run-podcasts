using Toybox.Application;
using Toybox.Lang;
using Toybox.Media;
using Toybox.System;
using Toybox.Time;

class ClipContentDelegate extends Media.ContentDelegate {
    private var _iterator;
    private var _testNext;

    function initialize(testNext) {
        ContentDelegate.initialize();
        _testNext = testNext;
        resetContentIterator();
    }

    function getContentIterator() {
        return _iterator;
    }

    function resetContentIterator() {
        _iterator = new ClipIterator(_testNext);
        return _iterator;
    }

    function onSong(contentRefId, event, position) {
        if (event == Media.SONG_EVENT_COMPLETE) {
            Application.Storage.setValue("completions", completionCount() + 1);
            if (!_testNext) {
                Application.Storage.deleteValue("clipBookmark");
            }
        } else if (!_testNext && (event == Media.SONG_EVENT_PAUSE || event == Media.SONG_EVENT_STOP)
            && position instanceof Lang.Number && position > 0) {
            Application.Storage.setValue("clipBookmark", {
                "ref" => contentRefId.toString(),
                "seconds" => position
            });
        }
        System.println("OBL song t=" + Time.now().value() + " event=" + event
            + " position=" + position + " completions=" + completionCount());
    }
}
