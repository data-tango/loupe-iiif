// CodeMirror plumbing that flags the source ranges a validation run points to, both as
// inline underlines and as dots in a margin gutter. the ranges themselves are computed in
// App.svelte (each finding's JSON Pointer mapped to an offset via jsonc-parser); this
// module only holds and renders them, all driven by one setMarkers effect.
import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  type DecorationSet,
} from "@codemirror/view";

// a character range in the document to flag, and how loudly to flag it.
export type MarkerRange = {
  from: number;
  to: number;
  severity: "error" | "warning";
};

// effect that carries a fresh set of ranges into the editor state. dispatching it
// replaces whatever markers were showing before (so re-validating clears stale ones).
export const setMarkers = StateEffect.define<MarkerRange[]>();

// keep only ranges that actually cover some text.
function nonEmptyRanges(ranges: readonly MarkerRange[]): MarkerRange[] {
  return ranges.filter((range) => range.to > range.from);
}

// --- inline underline decorations ---

const marksBySeverity = {
  error: Decoration.mark({ class: "cm-finding-error" }),
  warning: Decoration.mark({ class: "cm-finding-warning" }),
};

const underlineField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    // shift existing marks so they stay aligned as the user edits around them.
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setMarkers)) {
        const marks = nonEmptyRanges(effect.value).map((range) =>
          marksBySeverity[range.severity].range(range.from, range.to),
        );
        // second argument sorts the marks, which Decoration.set requires.
        decorations = Decoration.set(marks, true);
      }
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// --- margin gutter dots ---

class FindingGutterMarker extends GutterMarker {
  constructor(private readonly severity: "error" | "warning") {
    super();
  }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = `cm-finding-gutter-dot cm-finding-gutter-dot-${this.severity}`;
    dot.textContent = "●"; // ● filled circle
    return dot;
  }
}

const gutterMarkersBySeverity = {
  error: new FindingGutterMarker("error"),
  warning: new FindingGutterMarker("warning"),
};

const gutterField = StateField.define<RangeSet<GutterMarker>>({
  create() {
    return RangeSet.empty;
  },
  update(markers, transaction) {
    markers = markers.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setMarkers)) {
        const doc = transaction.state.doc;
        // one dot per affected line, even if several findings share that line; an error
        // on the line outranks a warning, so the dot shows the worst of them.
        const severityByLineStart = new Map<number, "error" | "warning">();
        for (const range of nonEmptyRanges(effect.value)) {
          const lineStart = doc.lineAt(range.from).from;
          if (severityByLineStart.get(lineStart) === "error") {
            continue;
          }
          severityByLineStart.set(lineStart, range.severity);
        }
        const gutterMarks = [...severityByLineStart].map(([lineStart, severity]) =>
          gutterMarkersBySeverity[severity].range(lineStart),
        );
        markers = RangeSet.of(gutterMarks, true);
      }
    }
    return markers;
  },
});

const errorGutter = gutter({
  class: "cm-finding-gutter",
  markers: (view) => view.state.field(gutterField),
});

// --- shared theme ---

const markerTheme = EditorView.baseTheme({
  ".cm-finding-error": {
    textDecoration: "underline wavy var(--iiif-red)",
  },
  // same amber as the report's warning rows.
  ".cm-finding-warning": {
    textDecoration: "underline wavy var(--iiif-amber)",
  },
  ".cm-finding-gutter": {
    width: "1.2em",
  },
  ".cm-finding-gutter-dot": {
    display: "block",
    textAlign: "center",
  },
  ".cm-finding-gutter-dot-error": {
    color: "var(--iiif-red)",
  },
  ".cm-finding-gutter-dot-warning": {
    color: "var(--iiif-amber)",
  },
});

export function findingMarkers(): Extension {
  return [underlineField, gutterField, errorGutter, markerTheme];
}
