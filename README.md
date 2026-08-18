# loupe-iiif

https://github.com/user-attachments/assets/df72093b-f562-4871-bf8e-01d3c14e209f

loupe-iiif is a browser extension that checks and validates **[IIIF](https://iiif.io)** manifests ([2.1](https://iiif.io/api/presentation/2.1/), [3.0](https://iiif.io/api/presentation/3.0/), [4.0](https://iiif.io/api/presentation/4.0/)): the JSON files that tell viewers how to present digital objects (A/V, books, artworks, maps, scores) and where to find their media.

IIIF manifests can break in ways that are hard to spot: a missing comma, a misspelled field, an image URL that quietly 404s. loupe-iiif identifies and flags these issues - all in your browser.

**How it works:** paste a manifest, load it from a URL, or open a file. It appears in a code editor, and loupe-iiif checks it as you type. Issues are underlined where they occur and listed in a report; click any finding to jump to the exact spot in the JSON.

**What it checks**, in order: is it valid JSON → does it match the [IIIF Presentation API](https://iiif.io/api/presentation/) structure for the version it declares → do the URLs it references actually resolve → does it follow best practices (rights, labels, thumbnails).

loupe-iiif auto-detects the Presentation API version from a manifest's `@context` and validates against that version's rules.

## The layers

The extension has four layers of checks.

| Tag    | Layer              | Question                                                         |
| ------ | ------------------ | ---------------------------------------------------------------- |
| `[L1]` | Well-formedness    | Is it parseable JSON?                                            |
| `[L2]` | Spec conformance   | Does it match the Presentation API structure (2.1, 3.0, or 4.0)? |
| `[L3]` | Linking            | Do referenced URLs resolve?                                      |
| `[L4]` | Best-practice lint | Valid but ill-advised?                                           |

## Install

- **Chrome:** [Chrome Web Store](https://chromewebstore.google.com/detail/loupe-iiif/bnnoohiohbljoianldgbnepljodndmdo) - also works in Chromium browsers (Brave, Edge, Vivaldi)
- **Firefox:** [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/loupe-iiif/)

## Install (from source)

Requires [Node.js](https://nodejs.org) 22 or later (any OS) with npm, bundled with Node. To build:

```sh
npm install
npm run build            # Chrome build → dist-chrome/
npm run build:firefox    # Firefox build → dist-firefox/
```

Each target builds to its own directory - Chrome and Firefox need different `background`
keys (`service_worker` vs `scripts`), so the two builds are never allowed to overwrite
each other on disk.

Then load the matching directory as an unpacked extension:

- **Chrome:** `chrome://extensions` → enable Developer mode → _Load unpacked_ → select `dist-chrome/`.
- **Firefox:** `about:debugging` → This Firefox → _Load Temporary Add-on_ → select `dist-firefox/manifest.json`, then grant host permissions in `about:addons` → loupe-iiif → Permissions (needed for URL loading and link checking).

Click the toolbar icon to open the workbench in a full tab.

## Develop

```sh
npm run dev        # watch + auto-reload in a dev browser
```

Built with **Manifest V3**, **TypeScript**, **Svelte 5**, **CodeMirror 6**, **Vite** (`vite-plugin-web-extension`), and **Ajv** for JSON Schema validation. Because MV3's content security policy forbids `eval`, the IIIF schema is **precompiled to a standalone, eval-free validator at build time** (`scripts/build-validator.js`) rather than compiled in the browser. The Presentation 3.0 and 4.0 schemas are sourced from the [IIIF `presentation-validator` project](https://github.com/IIIF/presentation-validator) (the same schemas behind [presentation-validator.iiif.io](https://presentation-validator.iiif.io/)); the Presentation 2.1 schema is a minimal, hand-maintained schema in this repo instead, checking Manifest → Sequence → Canvas but not descending into annotations or checking metadata/thumbnail/attribution. v4's files use JSON Schema draft 2020-12, unlike v2/v3's draft-07, so they're compiled with a separate Ajv instance into a separate generated file.

```sh
npm test           # Vitest suite for the validation logic
npm run typecheck  # svelte-check
```

## License

ISC. See [LICENSE](./LICENSE).
