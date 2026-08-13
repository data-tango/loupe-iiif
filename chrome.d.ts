// the sliver of the extension API the workbench itself touches. the full @types/chrome
// package is ~20k lines to describe one call, so this is hand-written instead.
//
// every level is optional: Chrome defines a bare `window.chrome` on ordinary pages too,
// so under `npm run dev` the object exists but `runtime` does not. reaching straight
// through it there is a TypeError, which would take the whole app down with it.
declare const chrome:
  | {
      runtime?: {
        getManifest(): { version: string };
      };
    }
  | undefined;
