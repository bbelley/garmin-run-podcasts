using Toybox.Lang;
using Toybox.Test;
using Toybox.WatchUi;

// Exercise the real native Menu2 rows with isolated storage and cache boundaries.
class QueueTestMenu extends QueueMenu {
    var store; var refs; var refreshes = 0;
    function initialize(testStore) {
        QueueMenu.initialize(); store = testStore; refs = {"fixture-ref" => true};
        refresh();
    }
    function refresh() { refreshes += 1; rebuild(store.read(), refs, false); }
    function row(id) { return getItem(findItemById(id)); }
}

class QueueConfirmTestDelegate extends QueueConfirmDelegate {
    var store; var menu; var dismissedToQueue = null; var stopped = false;
    function initialize(testStore, action, testMenu) {
        QueueConfirmDelegate.initialize(queueTestId(1), action, testMenu);
        store = testStore; menu = testMenu;
    }
    function actionStore() { return store; }
    function cacheRefs() { return menu.refs; }
    function stopPlayback() { stopped = true; }
    function deleteCached(ref) { menu.refs.remove("fixture-ref"); }
    function dismiss(confirmed) {
        dismissedToQueue = confirmed;
    }
}

function queueTestConfirmItem(id) { return new WatchUi.MenuItem("Fixture", null, id, null); }

(:test)
function queueMenuFinishImmediatelyRemovesRowAndUpdatesCounts(logger as Test.Logger) as Lang.Boolean {
    var store = queueTestStore();
    store.addFile(queueTestItem(2), "second-ref", 100);
    store.bookmark(queueTestId(1), 300);
    var menu = new QueueTestMenu(store);
    menu.refs["second-ref"] = true; menu.refresh();
    Test.assert(menu.findItemById(queueTestId(1)) >= 0);
    var confirm = new QueueConfirmTestDelegate(store, :finish, menu);
    confirm.onSelect(queueTestConfirmItem(:confirm));
    Test.assert(confirm.dismissedToQueue && confirm.stopped);
    Test.assertEqual(menu.findItemById(queueTestId(1)), -1);
    Test.assert(menu.findItemById(queueTestId(2)) >= 0);
    Test.assertEqual(menu.row(:ready).getLabel(), "Ready: 60 min");
    Test.assertEqual(menu.row(:ready).getSubLabel(), "1 episodes");
    Test.assertEqual(menu.row(:finishes).getLabel(), "Pending finishes: 1");
    Test.assertEqual(menu.row(:finishes).getSubLabel(), "Finished: 1");
    Test.assertEqual(store.read()["events"][0]["reason"], "mark_finished");
    Test.assert(menu.refs.hasKey("fixture-ref")); // Keep audio until completion acknowledgement.
    return true;
}

(:test)
function queueMenuDeleteImmediatelyShowsEmptyQueueAndRestore(logger as Test.Logger) as Lang.Boolean {
    var store = queueTestStore();
    var menu = new QueueTestMenu(store);
    var confirm = new QueueConfirmTestDelegate(store, :delete, menu);
    confirm.onSelect(queueTestConfirmItem(:confirm));
    Test.assert(confirm.dismissedToQueue);
    Test.assertEqual(menu.findItemById(queueTestId(1)), -1);
    Test.assertEqual(menu.row(:ready).getLabel(), "Ready: 0 min");
    Test.assertEqual(menu.row(:ready).getSubLabel(), "0 episodes");
    Test.assert(menu.findItemById(:restore) >= 0);
    Test.assertEqual(menu.row(:finishes).getLabel(), "Pending finishes: 0");
    Test.assertEqual(store.read()["finished"], 0);
    Test.assert(queueContains(store.read()["holds"], queueTestId(1)));
    Test.assert(!menu.refs.hasKey("fixture-ref"));
    return true;
}

(:test)
function queueMenuCancelKeepsEpisodeAndActionMenu(logger as Test.Logger) as Lang.Boolean {
    var actions = [:finish, :delete];
    for (var i = 0; i < actions.size(); i += 1) {
        var store = queueTestStore();
        var menu = new QueueTestMenu(store);
        var confirm = new QueueConfirmTestDelegate(store, actions[i], menu);
        confirm.onSelect(queueTestConfirmItem(:cancel));
        Test.assertEqual(confirm.dismissedToQueue, false);
        Test.assertEqual(menu.refreshes, 1);
        Test.assert(menu.findItemById(queueTestId(1)) >= 0);
        Test.assertEqual(store.read()["events"].size(), 0);
        Test.assertEqual(store.read()["holds"].size(), 0);
        Test.assert(menu.refs.hasKey("fixture-ref"));
    }
    return true;
}

(:test)
function queueMenuSaveFailureDoesNotHideUnfinishedEpisode(logger as Test.Logger) as Lang.Boolean {
    queueTestStore();
    var store = new FailingQueueTestStore();
    var menu = new QueueTestMenu(store);
    store.failWrite = true;
    var confirm = new QueueConfirmTestDelegate(store, :finish, menu);
    confirm.onSelect(queueTestConfirmItem(:confirm));
    Test.assert(confirm.dismissedToQueue);
    Test.assert(menu.findItemById(queueTestId(1)) >= 0);
    Test.assertEqual(menu.row(:finishes).getLabel(), "Pending finishes: 0");
    Test.assert(menu.refs.hasKey("fixture-ref"));
    return true;
}
