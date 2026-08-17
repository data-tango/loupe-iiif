// where a finding lives in the source text.
//
// a Finding says what is wrong and, for Layer 2 and up, which JSON Pointer it is wrong
// at. the editor needs offsets instead: character ranges to underline and to scroll to.
// this module is the bridge between the two, and it is deliberately UI-free — no Svelte,
// no CodeMirror, just text in and ranges out — so both the markers and click-to-jump ask
// the same question here and can never disagree about where a finding is.
import { parseTree, findNodeAtLocation, type Node, type ParseError } from "jsonc-parser";
import type { Finding } from "./validate";
import type { MarkerRange } from "./findingMarkers";

// JSON Pointer "/items/0/type" → ["items", 0, "type"]. array indices must be numbers
// so jsonc-parser matches them; "~1"/"~0" are the pointer escapes for "/" and "~".
function jsonPointerToPath(pointer: string): (string | number)[] {
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
}

// resolve a JSON Pointer to a source range, using the positions jsonc-parser retains but
// JSON.parse drops. takes an already-parsed tree so callers with many findings parse the
// document once, not once per finding. returns undefined when there is no node to point
// at (e.g. a stale pointer that no longer matches the current text). severity is not its
// business — the caller knows which finding asked, and adds it.
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

// resolve a finding to a source range, whichever way it locates itself: Layer-2+ errors
// carry a pointer (possibly "" for root errors) into the successfully-parsed document;
// a Layer-1 syntax error has no pointer (the document never parsed into JSON), so it
// points at wherever jsonc-parser's tolerant parser first choked.
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

// jsonc-parser is fault-tolerant, so even text that fails JSON.parse (a Layer-1 error)
// still yields a tree plus a list of the syntax errors it stumbled over.
function parseForLocations(text: string): { tree: Node; parseErrors: ParseError[] } | undefined {
  const parseErrors: ParseError[] = [];
  const tree = parseTree(text, parseErrors);
  if (tree === undefined) {
    return undefined;
  }
  return { tree, parseErrors };
}

// every finding that has a place in the text, for the editor's markers. findings with
// nowhere to point are dropped rather than guessed at.
export function computeMarkerRanges(findings: Finding[], text: string): MarkerRange[] {
  const parsed = parseForLocations(text);
  if (parsed === undefined) {
    return [];
  }
  const ranges: MarkerRange[] = [];
  for (const finding of findings) {
    const range = resolveFindingRange(finding, parsed.tree, parsed.parseErrors);
    if (range !== undefined) {
      ranges.push(range);
    }
  }
  return ranges;
}

// one finding's range, for click-to-jump. same answer computeMarkerRanges would give it,
// just parsed on its own since a click is a single lookup.
export function findingRange(finding: Finding, text: string): MarkerRange | undefined {
  const parsed = parseForLocations(text);
  if (parsed === undefined) {
    return undefined;
  }
  return resolveFindingRange(finding, parsed.tree, parsed.parseErrors);
}

// whether a report entry can jump to a node (the same test the markers use). a root
// error's pointer is "" — still jumpable, it resolves to the opening brace — so test
// against undefined; a Layer-1 syntax error has no pointer but is still jumpable.
export function isJumpable(finding: Finding): boolean {
  return finding.severity !== "ok" && (finding.pointer !== undefined || finding.layer === 1);
}
