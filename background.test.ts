// locks down the update flow in background.js: the workbench's reload request has to
// leave a note behind, and only a note-plus-update reopens the tab. everything here runs
// against a stubbed extension API, since the real one only exists inside a browser.
//
// vitest runs this, but `npm run typecheck` does not: background.js is plain JS with no
// declarations, so tsconfig leaves this file out rather than turn on allowJs for it.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

type Listener = (...args: any[]) => unknown;

// the slice of the extension API background.js touches, recording what it was asked to do.
function stubChrome() {
  const listeners: Record<string, Listener> = {};
  const capture = (name: string) => ({
    addListener: (listener: Listener) => {
      listeners[name] = listener;
    },
  });
  const localStore = new Map<string, unknown>();
  const sessionStore = new Map<string, unknown>();
  const createdTabs: string[] = [];
  // what the note looked like at the moment of the reload — the ordering is the whole
  // point, so record it then rather than reading the store afterwards.
  const reloadState: { noteAtReload?: unknown } = {};

  // a reload wipes storage.session but not storage.local (measured in Chrome). modelling
  // that here is the point of this stub: the note has to live somewhere that survives.
  function area(store: Map<string, unknown>) {
    return {
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) {
          store.set(key, value);
        }
      },
      get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
      remove: async (key: string) => {
        store.delete(key);
      },
    };
  }

  const chrome = {
    action: { onClicked: capture("action") },
    tabs: {
      create: ({ url }: { url: string }) => {
        createdTabs.push(url);
      },
    },
    storage: {
      local: area(localStore),
      session: area(sessionStore),
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://loupe/${path}`,
      // the restart itself: session storage does not survive it, so anything the reopen
      // depends on has to still be readable afterwards.
      reload: vi.fn(() => {
        reloadState.noteAtReload = localStore.get("reopenWorkbenchAt");
        sessionStore.clear();
      }),
      sendMessage: async () => undefined,
      onUpdateAvailable: capture("updateAvailable"),
      onMessage: capture("message"),
      onInstalled: capture("installed"),
    },
  };
  return { chrome, listeners, localStore, sessionStore, createdTabs, reloadState };
}

let context: ReturnType<typeof stubChrome>;

beforeEach(async () => {
  // fake timers so the staleness test can jump forward without waiting
  vi.useFakeTimers();
  context = stubChrome();
  vi.stubGlobal("chrome", context.chrome);
  // background.js registers its listeners at import time, so re-import it per test to
  // bind them to the fresh stub.
  vi.resetModules();
  await import("./background.js");
});

afterEach(() => {
  vi.useRealTimers();
});

// the listener kicks off a promise chain it doesn't return, so wait for the reload rather
// than assuming a fixed number of microtasks.
async function requestReloadForUpdate() {
  context.listeners.message({ type: "reload-for-update" });
  await vi.waitFor(() => expect(context.chrome.runtime.reload).toHaveBeenCalled());
}

test("a reload request notes the reopen where the restart can't wipe it", async () => {
  await requestReloadForUpdate();
  // written before the reload fires, and in an area that outlives it.
  expect(context.reloadState.noteAtReload).toBeTypeOf("number");
});

test("an update reopens the workbench when the reload was requested here", async () => {
  await requestReloadForUpdate();
  await context.listeners.installed({ reason: "update" });
  expect(context.createdTabs).toEqual(["chrome-extension://loupe/workbench.html"]);
  // the note is consumed, so a later background update doesn't open a second tab.
  expect(context.localStore.has("reopenWorkbenchAt")).toBe(false);
});

test("a note left by a reload that never landed goes stale instead of firing later", async () => {
  await requestReloadForUpdate();
  vi.setSystemTime(Date.now() + 6 * 60 * 1000);
  await context.listeners.installed({ reason: "update" });
  expect(context.createdTabs).toEqual([]);
  expect(context.localStore.has("reopenWorkbenchAt")).toBe(false);
});

test("an update nobody asked for leaves the browser alone", async () => {
  await context.listeners.installed({ reason: "update" });
  expect(context.createdTabs).toEqual([]);
});

test("a fresh install never opens the workbench", async () => {
  await requestReloadForUpdate();
  await context.listeners.installed({ reason: "install" });
  expect(context.createdTabs).toEqual([]);
});
