// background service worker
// sleep - event - wakes - runs handler - idle

// fires when toolbar icon is clicked
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("workbench.html"),
  });
});

// registering this listener is itself what defers the update: with no listener the
// browser applies an update the moment it arrives, taking any open workbench tab — and
// whatever is in its editor — down with it. with one, the update waits for a
// runtime.reload(), a browser restart, or a disable/enable, so we can hand the choice of
// moment to whoever is using the tab. Chrome 25+ and Firefox 51+ both fire it; Safari
// has no such event at all, which is what the ?. is for.
chrome.runtime.onUpdateAvailable?.addListener((details) => {
  // rejects when no workbench tab is listening — in that case the browser is free to
  // apply the update itself, so there is nothing to report.
  chrome.runtime.sendMessage({ type: "update-available", version: details.version }).catch(() => {});
});

// how long a reopen note stays good for. the update normally lands seconds after the
// click, so this is only here to expire a note whose reload never completed — generous,
// because a note that expires too eagerly breaks the feature while one that lingers a
// little too long costs at most one unexpected tab.
const REOPEN_NOTE_MAX_AGE_MS = 5 * 60 * 1000;

// the workbench asks us to reload rather than calling runtime.reload() itself, so a note
// to reopen it can be left first: the reload closes every extension page and takes all
// in-memory state with it. it has to be storage.local — measured in Chrome, a reload
// wipes storage.session too, which is what made an earlier version of this silently do
// nothing. local outlives the browser, hence the timestamp and the age check below.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "reload-for-update") {
    chrome.storage.local.set({ reopenWorkbenchAt: Date.now() }).then(() => chrome.runtime.reload());
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "update") {
    return;
  }
  const { reopenWorkbenchAt } = await chrome.storage.local.get("reopenWorkbenchAt");
  // consumed whether or not it is still fresh, so a stale note can't fire later.
  await chrome.storage.local.remove("reopenWorkbenchAt");
  if (reopenWorkbenchAt !== undefined && Date.now() - reopenWorkbenchAt < REOPEN_NOTE_MAX_AGE_MS) {
    chrome.tabs.create({ url: chrome.runtime.getURL("workbench.html") });
  }
});
