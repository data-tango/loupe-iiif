// locks down the pointer → source range mapping: given a manifest's text and a finding,
// the editor must underline the right characters. this lived inside App.svelte and was
// untestable there, so these are the first checks it has ever had.
import { expect, test } from "vitest";
import { computeMarkerRanges, findingRange, isJumpable } from "./findingLocations";
import type { Finding } from "./validate";

const manifest = `{
  "id": "https://example.org/manifest",
  "type": "Manifest",
  "items": [
    { "type": "Canvas", "height": "tall" }
  ],
  "odd/key": 1
}`;

// the substring a range covers - what the user would see selected in the editor.
function selected(text: string, range: { from: number; to: number } | undefined) {
  return range === undefined ? undefined : text.slice(range.from, range.to);
}

function error(pointer: string | undefined, layer = 2): Finding {
  return { severity: "error", layer, message: "boom", pointer };
}

test("a pointer selects exactly its value", () => {
  expect(selected(manifest, findingRange(error("/type"), manifest))).toBe('"Manifest"');
});

test("array indices index, rather than being read as keys", () => {
  expect(selected(manifest, findingRange(error("/items/0/height"), manifest))).toBe('"tall"');
});

test("~1 unescapes to a slash inside a key", () => {
  expect(selected(manifest, findingRange(error("/odd~1key"), manifest))).toBe("1");
});

test("the empty pointer marks the opening brace, not the whole document", () => {
  expect(selected(manifest, findingRange(error(""), manifest))).toBe("{");
});

test("a pointer that no longer matches the text resolves to nothing", () => {
  expect(findingRange(error("/items/9/type"), manifest)).toBeUndefined();
});

test("ok findings are summaries, so they have no place in the text", () => {
  const summary: Finding = { severity: "ok", layer: 2, message: "all good", pointer: "/type" };
  expect(findingRange(summary, manifest)).toBeUndefined();
});

test("a Layer-1 syntax error points at where the parser choked", () => {
  const broken = '{ "type": "Manifest",, }';
  const range = findingRange(error(undefined, 1), broken);
  expect(range).toBeDefined();
  // the stray comma, not the start of the document
  expect(range!.from).toBeGreaterThan(0);
  expect(range!.to).toBeGreaterThan(range!.from);
});

test("markers carry the finding's severity through", () => {
  const findings: Finding[] = [
    error("/type"),
    { severity: "warning", layer: 4, message: "meh", pointer: "/items" },
    { severity: "ok", layer: 2, message: "fine" },
  ];
  const ranges = computeMarkerRanges(findings, manifest);
  // the "ok" finding is dropped; the other two keep their severities, in order
  expect(ranges.map((range) => range.severity)).toEqual(["error", "warning"]);
});

test("text too broken to parse at all yields no markers", () => {
  expect(computeMarkerRanges([error("/type")], "")).toEqual([]);
});

test("isJumpable agrees with what findingRange can actually resolve", () => {
  expect(isJumpable(error("/type"))).toBe(true);
  // a root error's pointer is "", which is still a real location
  expect(isJumpable(error(""))).toBe(true);
  expect(isJumpable(error(undefined, 1))).toBe(true);
  expect(isJumpable({ severity: "ok", layer: 2, message: "fine" })).toBe(false);
  // layer 2+ with no pointer has nowhere to go
  expect(isJumpable(error(undefined, 2))).toBe(false);
});
