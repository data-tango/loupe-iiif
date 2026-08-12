<script lang="ts">
  // the UI is a function of state: hold the manifest text and the findings, and the
  // markup below re-renders itself whenever they change. no getElementById, no
  // appendChild — Svelte owns the DOM. all validation lives in validate.ts.
  import { EditorView, basicSetup } from "codemirror";
  import { EditorState } from "@codemirror/state";
  import { json } from "@codemirror/lang-json";
  import { parseTree, findNodeAtLocation, type Node, type ParseError } from "jsonc-parser";
  import { validate, validateLinks, type Finding, type Severity } from "./validate";
  import { findingMarkers, setMarkers, type MarkerRange } from "./findingMarkers";

  let manifestText = $state("");
  let urlText = $state("");
  let findings = $state<Finding[]>([]);
  // true while a fetch is in flight (Load / Check Links). guards against overlapping
  // runs racing to overwrite findings, and disables the action buttons meanwhile.
  let busy = $state(false);
  // set while Layer 3 fetches are running, so the report can show a progress bar;
  // undefined the rest of the time.
  let linkProgress = $state<{ completed: number; total: number } | undefined>(undefined);

  const countBySeverity = (severity: Severity) =>
    findings.filter((finding) => finding.severity === severity).length;
  let errorCount = $derived(countBySeverity("error"));
  let warningCount = $derived(countBySeverity("warning"));
  let okCount = $derived(countBySeverity("ok"));

  // CodeMirror manages its own DOM imperatively, so we hold a reference to the live
  // editor and bridge it to Svelte state by hand (unlike a textarea's bind:value).
  let editorView: EditorView | undefined;

  // Svelte action: create the editor on the target <div> and tear it down on unmount.
  function mountEditor(parent: HTMLElement) {
    editorView = new EditorView({
      parent,
      state: EditorState.create({
        doc: manifestText,
        extensions: [
          basicSetup,
          json(),
          findingMarkers(),
          // editor → state: mirror every document edit back into manifestText.
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              manifestText = update.state.doc.toString();
              // reformat a paste to match the slider, but only once this update settles
              // (can't dispatch mid-update). formatToCurrent no-ops unless it's valid JSON,
              // so pasting a snippet that breaks the JSON won't reflow the document.
              if (update.transactions.some((tr) => tr.isUserEvent("input.paste"))) {
                queueMicrotask(formatOnPaste);
              }
              scheduleAutoValidate();
            }
          }),
        ],
      }),
    });

    return {
      destroy() {
        clearTimeout(autoValidateTimer);
        editorView?.destroy();
        editorView = undefined;
      },
    };
  }

  // validate-as-you-type: re-run validation shortly after the user stops editing, so
  // findings and markers stay current without clicking Validate. skipped while a link
  // check is in flight (its results shouldn't be overwritten mid-run) and for an empty
  // document (a "nothing to validate" error while clearing the editor is just noise).
  let autoValidateTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleAutoValidate() {
    clearTimeout(autoValidateTimer);
    autoValidateTimer = setTimeout(() => {
      if (!busy && manifestText.trim() !== "") {
        handleValidate();
      }
    }, 500);
  }

  // state → editor: replace the whole document when text arrives from elsewhere
  // (URL / file). guarded so it never fights the updateListener above.
  function setManifestText(text: string) {
    manifestText = text;
    if (editorView && editorView.state.doc.toString() !== text) {
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: text },
      });
    }
  }

  // reformat the editor between 2-space pretty-print and compact to match the slider.
  // the checkbox flips `pretty`; on invalid JSON we revert it so the slider can't lie.
  let pretty = $state(true);
  function applyFormat() {
    if (manifestText.trim() === "") {
      return;
    }
    try {
      const parsed = JSON.parse(manifestText);
      setManifestText(pretty ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed));
    } catch {
      pretty = !pretty;
      findings = [{ severity: "error", layer: 1, message: "Can't format - invalid JSON." }];
    }
  }

  // format text to match the current slider; leaves empty or invalid text untouched
  // (loaded content shouldn't error just because it isn't parseable — Validate covers that).
  function formatToCurrent(text: string): string {
    if (text.trim() === "") {
      return text;
    }
    try {
      const parsed = JSON.parse(text);
      return pretty ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed);
    } catch {
      return text;
    }
  }

  function formatOnPaste() {
    const formatted = formatToCurrent(manifestText);
    if (formatted !== manifestText) {
      setManifestText(formatted);
    }
  }

  function handleValidate() {
    findings = validate(manifestText);
    editorView?.dispatch({
      effects: setMarkers.of(computeMarkerRanges(findings, manifestText)),
    });
  }

  // layer 3 is network-bound, so clear the editor markers and show progress while the
  // fetches run; dead links come back with pointers, so they get markers like L2 errors.
  async function handleCheckLinks() {
    if (busy) {
      return;
    }
    busy = true;
    try {
      editorView?.dispatch({ effects: setMarkers.of([]) });
      findings = [{ severity: "ok", layer: 3, message: "Checking links…" }];
      findings = await validateLinks(manifestText, (completed, total) => {
        linkProgress = { completed, total };
        findings = [
          { severity: "ok", layer: 3, message: `Checking links… ${completed} of ${total}` },
        ];
      });
      editorView?.dispatch({
        effects: setMarkers.of(computeMarkerRanges(findings, manifestText)),
      });
    } finally {
      busy = false;
      linkProgress = undefined;
    }
  }

  // resolve a finding's JSON Pointer to a source range — the bridge between "where the
  // spec says the problem is" (a pointer) and "where that is in the text" (an offset),
  // using the positions jsonc-parser retains but JSON.parse drops. takes an already-parsed
  // tree so callers with many findings parse the document once, not once per finding.
  // returns undefined when there is no node to point at (e.g. a stale pointer that no
  // longer matches the current text). shared by markers and click-to-jump so both agree.
  // severity is not its business — the caller knows which finding asked, and adds it.
  function resolvePointerRange(
    tree: Node,
    pointer: string,
  ): Omit<MarkerRange, "severity"> | undefined {
    const node = findNodeAtLocation(tree, jsonPointerToPath(pointer));
    if (node === undefined) {
      return undefined;
    }
    // an empty pointer resolves to the whole root node (a missing required property, or a
    // wrong-typed root). underlining the entire document would be noise, so mark just its
    // opening brace/bracket — enough to see, and to jump to.
    if (pointer === "") {
      return { from: node.offset, to: node.offset + 1 };
    }
    return { from: node.offset, to: node.offset + node.length };
  }

  // resolve a finding to a source range, whichever way it locates itself: Layer-2+
  // errors carry a pointer (possibly "" for root errors) into the successfully-parsed
  // document; a Layer-1 syntax error has no pointer (the document never parsed into
  // JSON), so it points at wherever jsonc-parser's tolerant parser first choked.
  // shared by markers and click-to-jump so both agree on where a finding lives.
  function resolveFindingRange(
    finding: Finding,
    tree: Node,
    parseErrors: ParseError[],
  ): MarkerRange | undefined {
    // "ok" findings are summaries, not locations; errors and warnings both point at
    // something worth marking and jumping to.
    if (finding.severity === "ok") {
      return undefined;
    }
    if (finding.pointer !== undefined) {
      const range = resolvePointerRange(tree, finding.pointer);
      if (range === undefined) {
        return undefined;
      }
      return { ...range, severity: finding.severity };
    }
    if (finding.layer === 1 && parseErrors.length > 0) {
      const firstError = parseErrors[0];
      return {
        from: firstError.offset,
        to: firstError.offset + Math.max(firstError.length, 1),
        severity: finding.severity,
      };
    }
    return undefined;
  }

  function computeMarkerRanges(findings: Finding[], text: string): MarkerRange[] {
    // jsonc-parser is fault-tolerant, so even text that fails JSON.parse (a Layer-1
    // error) still yields a tree plus a list of the syntax errors it stumbled over.
    const parseErrors: ParseError[] = [];
    const tree = parseTree(text, parseErrors);
    if (tree === undefined) {
      return [];
    }
    const ranges: MarkerRange[] = [];
    for (const finding of findings) {
      const range = resolveFindingRange(finding, tree, parseErrors);
      if (range !== undefined) {
        ranges.push(range);
      }
    }
    return ranges;
  }

  // whether a report entry can jump to a node (same test the markers use). a root error's
  // pointer is "" (still jumpable — resolves to the opening brace), so test against
  // undefined; a Layer-1 syntax error has no pointer but is still jumpable.
  function isJumpable(finding: Finding): boolean {
    return finding.severity !== "ok" && (finding.pointer !== undefined || finding.layer === 1);
  }

  // click a report entry → select and scroll to its node in the editor.
  function jumpToFinding(finding: Finding) {
    if (editorView === undefined) {
      return;
    }
    const parseErrors: ParseError[] = [];
    const tree = parseTree(manifestText, parseErrors);
    if (tree === undefined) {
      return;
    }
    const range = resolveFindingRange(finding, tree, parseErrors);
    if (range === undefined) {
      return;
    }
    editorView.dispatch({
      selection: { anchor: range.from, head: range.to },
      scrollIntoView: true,
    });
    editorView.focus();
  }

  // JSON Pointer "/items/0/type" → ["items", 0, "type"]. array indices must be numbers
  // so jsonc-parser matches them; "~1"/"~0" are the pointer escapes for "/" and "~".
  function jsonPointerToPath(pointer: string): (string | number)[] {
    return pointer
      .split("/")
      .slice(1)
      .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
      .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
  }

  async function handleLoadUrl() {
    const url = urlText.trim();
    if (!url) {
      findings = [{ severity: "error", message: "Enter a manifest URL first." }];
      return;
    }
    if (busy) {
      return;
    }
    busy = true;
    findings = [{ severity: "ok", message: `Loading ${url}…` }];
    try {
      const response = await fetch(url);
      if (!response.ok) {
        findings = [
          {
            severity: "error",
            message: `Fetch failed: HTTP ${response.status} ${response.statusText}`,
          },
        ];
        return;
      }
      setManifestText(formatToCurrent(await response.text()));
      findings = [{ severity: "ok", message: `Loaded ${url} - now click Validate.` }];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      findings = [{ severity: "error", message: "Could not fetch: " + reason }];
    } finally {
      busy = false;
    }
  }

  async function handleChooseFile(event: Event) {
    const fileInput = event.currentTarget as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file) {
      return;
    }
    const text = await file.text();
    setManifestText(formatToCurrent(text));
    findings = [{ severity: "ok", message: `Loaded ${file.name} - now click Validate.` }];
  }

  // clears the input right before the native picker opens, not after a file loads -
  // otherwise the browser's own "chosen file" label snaps back to "No file chosen"
  // right after a successful load, which reads as if nothing was selected. clearing
  // here (rather than in handleChooseFile) still lets choosing the same file twice in
  // a row fire another change event, since the value is already empty by then.
  function handleFileInputClick(event: Event) {
    (event.currentTarget as HTMLInputElement).value = "";
  }
</script>

{#snippet severityIcon(severity: Severity)}
  {#if severity === "error"}
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  {:else if severity === "warning"}
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  {:else}
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  {/if}
{/snippet}

<header>
  <h1>loupe-iiif</h1>
  <span>IIIF Presentation Manifest Checker &amp; Validator</span>
  <div class="help">
    <button class="help-button" aria-label="Help" aria-describedby="help-popup">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
        <path d="M12 17h.01" />
      </svg>
    </button>
    <div class="help-popup" id="help-popup" role="tooltip">
      <ul>
        <li>Enter a manifest URL and click <strong>Load</strong>, or</li>
        <li>Pick a .json file from your computer under <strong>Or load a JSON file</strong>, or</li>
        <li>Paste the manifest JSON directly into the box below.</li>
      </ul>
      <p>Then click <strong>Validate</strong> to check it.</p>
    </div>
  </div>
</header>
<main>

  <div class="url-row">
    <input type="url" placeholder="https://.../manifest URL" bind:value={urlText} />
    <button onclick={handleLoadUrl} disabled={busy}>Load</button>
  </div>

  <div class="file-row">
    <label for="file">Or load a JSON file:</label>
    <input
      id="file"
      type="file"
      accept=".json,application/json"
      onclick={handleFileInputClick}
      onchange={handleChooseFile}
    />
  </div>

  <div class="actions">
    <button onclick={handleValidate} disabled={busy}>Validate</button>
    <button onclick={handleCheckLinks} disabled={busy}>
      {busy ? "Checking…" : "Check Links"}
    </button>
    <label class="toggle">
      <input type="checkbox" bind:checked={pretty} onchange={applyFormat} />
      Pretty-print
    </label>
  </div>

  <div class="panes">
    <div class="editor" use:mountEditor></div>

    <!-- polite live region so screen readers announce new findings without interrupting -->
    <div class="report" aria-live="polite">
      {#if linkProgress !== undefined}
        <progress
          class="link-progress"
          value={linkProgress.completed}
          max={linkProgress.total}
        ></progress>
      {/if}
      {#if findings.length > 0}
        <div class="report-summary">
          <span class="error">{@render severityIcon("error")} {errorCount}</span>
          <span class="warning">{@render severityIcon("warning")} {warningCount}</span>
          <span class="ok">{@render severityIcon("ok")} {okCount}</span>
        </div>
      {/if}
      {#each findings as finding}
        {#if isJumpable(finding)}
          <button
            type="button"
            class="finding {finding.severity} jumpable"
            title="Jump to this location in the editor"
            onclick={() => jumpToFinding(finding)}
          >
            <span class="glyph">{@render severityIcon(finding.severity)}</span>
            {finding.layer ? `[L${finding.layer}] ` : ""}{finding.message}
          </button>
        {:else}
          <div class="finding {finding.severity}">
            <span class="glyph">{@render severityIcon(finding.severity)}</span>
            {finding.layer ? `[L${finding.layer}] ` : ""}{finding.message}
          </div>
        {/if}
      {/each}
    </div>
  </div>
</main>

<style>
  header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 16px 24px;
    border-bottom: 1px solid #ddd;
  }
  header h1 {
    margin: 0;
    font-family: "Playfair Display", serif;
    font-size: 26px;
    font-weight: 700;
    color: var(--iiif-blue);
  }
  header span {
    font-size: 13px;
    color: var(--iiif-gray);
  }
  main {
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .editor {
    border: 1px solid #ccc;
    border-radius: 4px;
    overflow: hidden;
  }
  /* help button + hover/focus popover, pushed to the right of the header. the
     margin-right centers the 24px icon above the Load button below it (measured:
     Load is ~66px wide against the same 24px page padding, so 66/2 - 12 ≈ 21). */
  .help {
    position: relative;
    /* flex collapses the div to exactly the icon's box, so centering is true and
       the popup (top: 100%) sits flush under the icon. */
    display: flex;
    margin-left: auto;
    margin-right: 21px;
    /* the header aligns children on the text baseline; center the icon against
       the "loupe-iiif" wordmark's height instead. */
    align-self: center;
  }
  .help-button {
    display: inline-flex;
    padding: 0;
    border: 0;
    background: none;
    color: var(--iiif-blue);
    cursor: pointer;
  }
  .help-button:hover {
    background: none;
    color: var(--iiif-blue-dark);
  }
  .icon {
    width: 14px;
    height: 14px;
  }
  .help-popup {
    display: none;
    position: absolute;
    right: 0;
    top: 100%; /* flush under the button — no gap, so no hover dead zone */
    z-index: 10;
    width: 320px;
    padding: 12px 18px;
    background: #fff;
    border: 1px solid #ddd;
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
  }
  /* speech-bubble pointer: a small rotated square poking up toward the button. */
  .help-popup::after {
    content: "";
    position: absolute;
    top: -7px;
    /* arrow center at 12px from the right edge = the center of the 24px icon above */
    right: 6px;
    width: 12px;
    height: 12px;
    background: #fff;
    border-left: 1px solid #ddd;
    border-top: 1px solid #ddd;
    transform: rotate(45deg);
  }
  /* keep it open while hovering the button or the popup, and for keyboard focus. */
  .help:hover .help-popup,
  .help:focus-within .help-popup {
    display: block;
  }
  .help-popup ul {
    margin: 0 0 10px;
    padding-left: 20px;
    line-height: 1.8;
    font-size: 14px;
  }
  .help-popup li {
    margin-bottom: 4px;
  }
  .help-popup p {
    margin: 0;
    font-size: 14px;
    line-height: 1.5;
  }
  .panes {
    display: grid;
    grid-template-columns: 3fr 2fr;
    gap: 16px;
    align-items: start;
  }
  .report {
    position: sticky;
    top: 16px;
    max-height: 70vh;
    overflow: auto;
  }
  /* native <progress>, restyled: WebKit and Firefox expose different pseudo-elements,
     so the bar and its fill are set for both. */
  .link-progress {
    width: 100%;
    height: 6px;
    margin-bottom: 8px;
    border: none;
    border-radius: 3px;
    background: #eee;
    appearance: none;
  }
  .link-progress::-webkit-progress-bar {
    border-radius: 3px;
    background: #eee;
  }
  .link-progress::-webkit-progress-value {
    border-radius: 3px;
    background: var(--iiif-green);
  }
  .link-progress::-moz-progress-bar {
    border-radius: 3px;
    background: var(--iiif-green);
  }
  .report-summary {
    display: flex;
    gap: 12px;
    margin-bottom: 4px;
    font-family: "Playfair Display", serif;
    font-weight: 500;
    font-size: 14px;
  }
  .report-summary span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .report-summary .error {
    color: var(--iiif-red);
  }
  .report-summary .warning {
    color: var(--iiif-amber);
  }
  .report-summary .ok {
    color: var(--iiif-green);
  }
  .finding .glyph {
    flex-shrink: 0;
    display: inline-flex;
    margin-top: 1px;
  }
  /* CodeMirror renders its own nested DOM, so reach into it with :global. */
  .editor :global(.cm-editor) {
    height: 70vh;
    min-height: 320px;
  }
  .editor :global(.cm-editor.cm-focused) {
    outline: none;
  }
  .editor :global(.cm-scroller) {
    font-family: "Courier Prime", monospace;
    font-size: 13px;
  }
  .url-row {
    display: flex;
    gap: 8px;
  }
  .url-row input {
    flex: 1;
    padding: 8px 10px;
    font-size: 14px;
    font-family: "PT Sans", sans-serif;
    border: 1px solid #ccc;
    border-radius: 4px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: 4px;
    font-family: "Playfair Display", serif;
    font-weight: 500;
    font-size: 13px;
    cursor: pointer;
  }
  .toggle input {
    appearance: none;
    position: relative;
    width: 30px;
    height: 16px;
    border-radius: 8px;
    background: #ccc;
    cursor: pointer;
    transition: background 0.15s;
  }
  .toggle input:checked {
    background: var(--iiif-blue);
  }
  .toggle input::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #fff;
    transition: left 0.15s;
  }
  .toggle input:checked::after {
    left: 16px;
  }
  .file-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-family: "Playfair Display", serif;
    font-weight: 500;
  }
  .file-row input {
    font-size: 12px;
  }
  .file-row input::file-selector-button {
    font-family: "Playfair Display", serif;
    font-size: 12px;
    padding: 3px 8px;
    margin-right: 6px;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: #f5f5f5;
    cursor: pointer;
  }
  button {
    padding: 8px 16px;
    font-size: 15px;
    font-family: "Playfair Display", serif;
    font-weight: 500;
    border: 0;
    border-radius: 4px;
    background: var(--iiif-blue);
    color: #fff;
    cursor: pointer;
  }
  button:hover {
    background: var(--iiif-blue-dark);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button:disabled:hover {
    background: var(--iiif-blue);
  }
  .finding {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 8px 0;
    /* Courier Prime hangs its glyphs high in the line box, leaving ~1px more space
       below the ink than above; the uneven vertical padding compensates (measured). */
    padding: 10px 12px 9px;
    border-radius: 4px;
    font-family: "Courier Prime", monospace;
    font-size: 13px;
  }
  .finding.error {
    background: #fdecef;
    color: var(--iiif-red);
  }
  .finding.ok {
    background: var(--iiif-green-tint);
    color: var(--iiif-green);
  }
  .finding.warning {
    background: #fef3c7;
    color: var(--iiif-amber);
  }
  /* jumpable entries are <button>s; strip the default button chrome (blue fill, Playfair,
     centered) so they read like the other findings — just clickable. the .finding.* rules
     above win on background/color/font by specificity; these only add the button resets. */
  button.finding {
    width: 100%;
    text-align: left;
    font-weight: 400;
    cursor: pointer;
  }
  button.finding.jumpable:hover {
    filter: brightness(0.96);
  }
</style>
