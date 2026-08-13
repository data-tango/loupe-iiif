// the sliver of the extension API the workbench itself touches. the full @types/chrome
// package is ~20k lines to describe three calls, so these are hand-written instead.
// every level is optional: Chrome defines a bare `window.chrome` on ordinary pages too,
// so under `npm run dev` the object exists but `runtime` does not. reaching straight
// through it there is a TypeError, which took the whole app down with it once.
declare const chrome:
  | {
      runtime?: {
        getManifest(): { version: string };
        sendMessage(message: unknown): Promise<unknown>;
        onMessage: {
          addListener(callback: (message: unknown) => void): void;
        };
      };
    }
  | undefined;
