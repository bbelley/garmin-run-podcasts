using Toybox.Media;
using Toybox.System;

class ClipIterator extends Media.ContentIterator {
    private var _content;
    private var _testNext;
    private var _slot = 0;

    function initialize(testNext) {
        ContentIterator.initialize();
        _testNext = testNext;
        _content = cachedClip();
        if (!_testNext && _content != null) {
            var seconds = savedClipPosition(_content);
            if (seconds > 0) {
                _content = new Media.ActiveContent(_content.getContentRef(), _content.getMetadata(), seconds);
                System.println("PaceJams resume requested=" + seconds);
            }
        }
    }

    function getPlaybackProfile() {
        var profile = new Media.PlaybackProfile();
        profile.playbackControls = [Media.PLAYBACK_CONTROL_PLAYBACK];
        if (_testNext) {
            profile.playbackControls.add(Media.PLAYBACK_CONTROL_NEXT);
            profile.playbackControls.add(Media.PLAYBACK_CONTROL_PREVIOUS);
        } else {
            profile.playbackControls.add(Media.PLAYBACK_CONTROL_SKIP_BACKWARD);
            profile.playbackControls.add(Media.PLAYBACK_CONTROL_SKIP_FORWARD);
        }
        return profile;
    }

    function get() {
        return _content;
    }

    function peekNext() {
        return _testNext && _slot == 0 ? get() : null;
    }

    function peekPrevious() {
        return _slot == 1 ? get() : null;
    }

    function next() {
        var content = peekNext();
        if (content != null) {
            _slot = 1;
        }
        return content;
    }

    function previous() {
        var content = peekPrevious();
        if (content != null) {
            _slot = 0;
        }
        return content;
    }

    function canSkip() {
        return _testNext;
    }

    function repeatMode() {
        return Media.REPEAT_MODE_OFF;
    }
}
