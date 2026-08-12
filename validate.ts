// pure validation logic: text in, findings out. no DOM, no UI.
// the UI (App.svelte) is purely a rendering of the Finding[] this returns —
// keeping the two apart is the core architecture contract (see CLAUDE.md).
//
// the validator is precompiled from the IIIF schema at build time
// (see scripts/build-validator.js). browser extensions forbid eval, and Ajv's
// normal runtime compilation uses new Function, so the ready-made validation
// function is imported here instead of compiling the schema at runtime.
import {
  validateManifestV2,
  validateManifestV3,
  type ValidationError,
} from "./manifest-validator.js";
// v4's schema declares JSON Schema draft 2020-12, unlike v2/v3's draft-07, so it's
// compiled by a separate Ajv instance into its own file (see build-validator.js).
import { validateManifestV4 } from "./manifest-validator-v4.js";

// the one shape the whole app agrees on: validation produces a list of findings,
// and the UI is purely a rendering of that list.
export type Severity = "error" | "ok" | "warning";

export type Finding = {
  severity: Severity;
  message: string;
  // present for layered checks (L1, L2, …); omitted for plain status messages.
  layer?: number;
  // JSON Pointer to the offending value (e.g. "/items/0/type"), when the finding is
  // tied to a spot in the document. the UI uses it to place an editor marker.
  pointer?: string;
};

// layered validation: each layer only runs if the earlier ones passed.
export function validate(text: string): Finding[] {
  if (text.trim() === "") {
    return [
      {
        severity: "error",
        layer: 1,
        message: "Nothing to validate - paste a manifest first.",
      },
    ];
  }

  // layer 1: can the JSON be parsed?
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [
      {
        severity: "error",
        layer: 1,
        message: "Invalid JSON: " + reason,
      },
    ];
  }

  const findings: Finding[] = [
    { severity: "ok", layer: 1, message: "Layer 1 passed - well-formed JSON." },
  ];

  // layer 2: does the parsed manifest match a supported IIIF Presentation structure?
  // loupe-iiif only knows the IIIF Presentation API's shape, so it detects which version
  // a manifest declares (via @context) and validates against that version's schema.
  const version = detectPresentationVersion(parsedManifest);
  if (version === "unknown") {
    findings.push({
      severity: "error",
      layer: 2,
      message:
        "Layer 2: could not detect a supported IIIF Presentation version from @context. " +
        "loupe-iiif currently validates Presentation 2.1, 3.0, and 4.0.",
      pointer: "/@context",
    });
    return findings;
  }

  const { validateStructure, versionLabel, lint } = presentationVersions[version];
  const matchesSchema = validateStructure(parsedManifest);
  if (matchesSchema) {
    // the official v3/v4 schemas (see the comment on schemaV3 in build-validator.js)
    // don't enforce two real IIIF spec rules that loupe-iiif's old hand-rolled schema
    // used to catch: a Manifest needs at least one item, and a Canvas id must not carry
    // a fragment (canvas ids get referenced with fragment-based selectors elsewhere, so
    // the id itself must be bare). checked here rather than patched into the schema
    // files, so an upstream schema update can't silently drop them again.
    const structuralGaps = version === "3" || version === "4" ? checkStructuralGaps(parsedManifest) : [];
    if (structuralGaps.length === 0) {
      findings.push({
        severity: "ok",
        layer: 2,
        message: `Layer 2 passed - matches the IIIF Presentation ${versionLabel} structure.`,
      });
      // layer 4: best-practice lint only makes sense once the structure is valid.
      findings.push(...lint(parsedManifest));
    } else {
      findings.push(...structuralGaps);
    }
  } else {
    for (const schemaError of collapseAnyOfNoise(validateStructure.errors ?? [])) {
      const location = schemaError.instancePath || "(root)";
      const rightsSchemeExplanation = explainRightsSchemeMismatch(schemaError, parsedManifest);
      findings.push({
        severity: "error",
        layer: 2,
        message: rightsSchemeExplanation ?? `${location} ${schemaError.message ?? "is invalid"}`,
        pointer: schemaError.instancePath,
      });
    }
  }

  return findings;
}

type PresentationVersion = "2" | "3" | "4";

// one entry per supported IIIF Presentation API version: which schema validates it,
// what to call it in messages, and which best-practice lint rules apply.
const presentationVersions: Record<
  PresentationVersion,
  {
    validateStructure: typeof validateManifestV3;
    versionLabel: string;
    lint: (manifest: unknown) => Finding[];
  }
> = {
  "4": { validateStructure: validateManifestV4, versionLabel: "4.0", lint: lintBestPracticesV4 },
  "3": { validateStructure: validateManifestV3, versionLabel: "3.0", lint: lintBestPracticesV3 },
  "2": { validateStructure: validateManifestV2, versionLabel: "2.1", lint: lintBestPracticesV2 },
};

// Presentation 4 is still a draft upstream (this schema tracks the presentation-validator
// project's current snapshot of it, not a finalized spec) - its shape may still change
// before it's finalized, which could require updating iiif-presentation-4-schema/.
const presentation4ContextUri = "http://iiif.io/api/presentation/4/context.json";
const presentation3ContextUri = "http://iiif.io/api/presentation/3/context.json";
// Presentation 2 and the legacy Shared Canvas context it grew out of are structurally
// identical, and real institutions (e.g. the Smithsonian) still publish the latter.
const presentation2ContextUris = new Set([
  "http://iiif.io/api/presentation/2/context.json",
  "http://www.shared-canvas.org/ns/context.json",
]);

// sniffs @context to figure out which IIIF Presentation API version a manifest claims
// to be. this only reads @context - it does not confirm the rest of the document
// matches that version's schema, which is what the L2 schema check above is for.
function detectPresentationVersion(manifest: unknown): PresentationVersion | "unknown" {
  if (!isRecord(manifest)) {
    return "unknown";
  }
  const context = manifest["@context"];
  const contextUris = typeof context === "string" ? [context] : Array.isArray(context) ? context : [];

  if (contextUris.includes(presentation4ContextUri)) {
    return "4";
  }
  if (contextUris.includes(presentation3ContextUri)) {
    return "3";
  }
  if (contextUris.some((uri) => presentation2ContextUris.has(uri))) {
    return "2";
  }
  return "unknown";
}

// Ajv reports an anyOf/oneOf failure as every branch's individual errors plus a generic
// "must match a schema in anyOf" — so one canvas missing its dimensions becomes four
// findings. drop the branch errors and, where the branches share a readable shape, spell
// them out in the surviving error instead: required-property alternatives become
// "must have height + width, or duration"; pattern alternatives (regex-based enums like
// viewingDirection, or URI prefixes like rights) become "must match one of: ...". a schema
// with more than a couple of pattern-only oneOf/anyOf fields probably means this file's
// worth generalizing further rather than one-off handling each field.
const branchKeywordPattern = /\/(anyOf|oneOf)\//;

function collapseAnyOfNoise(errors: ValidationError[]): ValidationError[] {
  const branchErrors = errors.filter((error) => branchKeywordPattern.test(error.schemaPath));
  const keptErrors = errors.filter((error) => !branchKeywordPattern.test(error.schemaPath));

  return keptErrors.map((error) => {
    if (error.keyword !== "anyOf" && error.keyword !== "oneOf") {
      return error;
    }
    const branchesForThisError = branchErrors.filter(
      (branch) => branch.instancePath === error.instancePath,
    );

    // required-property alternatives, grouped by which branch they belong to (a branch
    // with two required properties, e.g. height + width, should read as one alternative).
    const missingByBranch = new Map<string, string[]>();
    for (const branch of branchesForThisError) {
      const branchIndex = branch.schemaPath.match(/\/(?:anyOf|oneOf)\/(\d+)\//)?.[1];
      const missingProperty = branch.params?.missingProperty;
      if (branchIndex === undefined || missingProperty === undefined) {
        continue;
      }
      missingByBranch.set(branchIndex, [
        ...(missingByBranch.get(branchIndex) ?? []),
        missingProperty,
      ]);
    }
    if (missingByBranch.size > 0) {
      const alternatives = [...missingByBranch.values()]
        .map((properties) => properties.join(" + "))
        .join(", or ");
      return { ...error, message: `must have ${alternatives}` };
    }

    // pattern alternatives - each branch is a single regex the value could have matched.
    // strip a bare ^...$ anchor pair (regex-flavored enums like "^left-to-right$") so
    // those read as plain values; a partial pattern like a URI prefix is left as-is.
    const patterns = branchesForThisError
      .filter((branch) => branch.keyword === "pattern" && branch.params?.pattern !== undefined)
      .map((branch) => (branch.params?.pattern as string).replace(/^\^(.*)\$$/, "$1"));
    if (patterns.length > 0) {
      return { ...error, message: `must match one of these: ${patterns.join(", ")}` };
    }

    return error;
  });
}

// the two spec rules the official v3/v4 schemas don't check (see the caller for why).
// message wording matches what Ajv itself generates for these keywords elsewhere, so a
// gap-filled finding reads the same as a schema-generated one.
function checkStructuralGaps(manifest: unknown): Finding[] {
  const gaps: Finding[] = [];
  if (!isRecord(manifest) || !Array.isArray(manifest.items)) {
    return gaps;
  }

  if (manifest.items.length === 0) {
    gaps.push({
      severity: "error",
      layer: 2,
      message: "/items must NOT have fewer than 1 items",
      pointer: "/items",
    });
  }

  manifest.items.forEach((item, index) => {
    if (isRecord(item) && item.type === "Canvas" && typeof item.id === "string" && item.id.includes("#")) {
      gaps.push({
        severity: "error",
        layer: 2,
        message: `/items/${index}/id must not have a fragment identifier ("#...")`,
        pointer: `/items/${index}/id`,
      });
    }
  });

  return gaps;
}

// the official schema correctly requires the canonical http:// form for Creative Commons
// and RightsStatements.org rights URIs - both vocabularies define http as the identifier
// (their pages redirect to https for browsing, but the identifier itself must stay http
// for RDF/linked-data interoperability - see IIIF/trc#32 and the CC license RDF wiki).
// that's an easy mistake to make since https is the modern default everywhere else, so
// this replaces Ajv's generic "must match exactly one schema in oneOf" with a message
// that names the actual, correct fix instead of leaving someone to guess it.
const httpOnlyRightsHosts = ["https://creativecommons.org/", "https://rightsstatements.org/"];

// RightsStatements.org's human-facing pages live at /page/{id}/{version}/ (often with a
// ?language= query param from their site's own language switcher) - a different path
// from the canonical machine identifier at /vocab/{id}/{version}/. copying a link
// straight from their website is probably the single most common way to end up with a
// rights value that's wrong in more than just its scheme, so a plain scheme swap isn't
// enough to fix it - the path needs rewriting too.
const rightsStatementsPagePattern =
  /^https?:\/\/rightsstatements\.org\/page\/([^/?#]+)\/([^/?#]+)\/?(?:[?#].*)?$/;

// computes the canonical rights URI for a value that's wrong in a way loupe-iiif knows
// how to fix, or undefined if it isn't one of those known cases.
function canonicalizeRightsValue(value: string): string | undefined {
  const pageMatch = value.match(rightsStatementsPagePattern);
  if (pageMatch) {
    const [, id, version] = pageMatch;
    return `http://rightsstatements.org/vocab/${id}/${version}/`;
  }
  if (!httpOnlyRightsHosts.some((host) => value.startsWith(host))) {
    return undefined;
  }
  // scheme swap, plus drop a stray query string/fragment (e.g. a copied "?language=en")
  // that isn't part of the canonical identifier either.
  return value.replace(/^https:\/\//, "http://").replace(/[?#].*$/, "");
}

function explainRightsSchemeMismatch(
  schemaError: ValidationError,
  manifest: unknown,
): string | undefined {
  if (schemaError.keyword !== "oneOf" || !schemaError.instancePath.endsWith("/rights")) {
    return undefined;
  }
  const value = resolveJsonPointer(manifest, schemaError.instancePath);
  if (typeof value !== "string") {
    return undefined;
  }
  const canonical = canonicalizeRightsValue(value);
  if (canonical === undefined) {
    return undefined;
  }
  // the sharp, single-cause message for the common case; a generic one for everything
  // else canonicalizeRightsValue can fix (a /page/ rewrite, a stray query string, or
  // both), rather than a message variant per specific thing that changed.
  const isSchemeOnlyFix = canonical === value.replace(/^https:\/\//, "http://");
  return isSchemeOnlyFix
    ? `Use 'http' instead of 'https'. Use "${canonical}".`
    : `Use the canonical rights URI. Use "${canonical}".`;
}

// resolves a JSON Pointer (e.g. "/items/0/rights") against a parsed document.
function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") {
    return document;
  }
  const segments = pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = document;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

// layer 4: things that are valid but not recommended by the IIIF spec. warnings, not
// errors. ponytail: a small growable set of high-value checks, not the full recommendation
// list — add rules as real manifests surface them.
function lintBestPracticesV3(manifest: unknown): Finding[] {
  const warnings: Finding[] = [];
  if (!isRecord(manifest)) {
    return warnings;
  }

  if (typeof manifest.id === "string" && manifest.id.startsWith("http://")) {
    warnings.push(warn("Manifest id uses http; https is recommended."));
  }

  if (isRecord(manifest.label) && "none" in manifest.label) {
    warnings.push(
      warn(
        'Manifest label uses "none"; use a BCP-47 language code (e.g. "en") if the language is known.',
      ),
    );
  }

  if (manifest.summary === undefined) {
    warnings.push(warn("Manifest has no summary; a short description is recommended."));
  }

  if (manifest.thumbnail === undefined) {
    warnings.push(warn("Manifest has no thumbnail; one is recommended for previews."));
  }

  if (manifest.metadata === undefined) {
    warnings.push(warn("Manifest has no metadata; descriptive metadata is recommended."));
  }

  if (manifest.rights === undefined && manifest.requiredStatement === undefined) {
    warnings.push(
      warn(
        "Manifest has no rights or requiredStatement; consider adding licensing/attribution info (optional per spec).",
      ),
    );
  }

  if (manifest.provider === undefined) {
    warnings.push(
      warn("Manifest has no provider; naming the publishing institution is recommended."),
    );
  }

  if (Array.isArray(manifest.items)) {
    // an empty items array is a spec violation and is caught by the schema (minItems),
    // so the lint rules here only look at the canvases that exist.
    const unlabeled = manifest.items.filter(
      (item) => isRecord(item) && item.label === undefined,
    ).length;
    if (unlabeled > 0) {
      warnings.push(warn(`${unlabeled} canvas(es) have no label; labels are recommended.`));
    }

    const withoutContent = manifest.items.filter(
      (item) => isRecord(item) && (!Array.isArray(item.items) || item.items.length === 0),
    ).length;
    if (withoutContent > 0) {
      warnings.push(
        warn(
          `${withoutContent} canvas(es) have no content (items); each canvas should have at least one annotation page.`,
        ),
      );
    }
  }

  return warnings;
}

// layer 4 for Presentation 4: the same spirit as lintBestPracticesV3, adapted to what
// the v4 Manifest schema actually defines at the top level. unlike v3, the current draft
// does not give Manifest its own thumbnail/rights/provider properties (those live on
// Container, i.e. Canvas/Timeline/Scene) - warning on their absence here would be
// flagging manifests for skipping fields the spec doesn't ask them to have, so those
// checks are dropped rather than ported over. an item can be a Canvas, Timeline, or
// Scene (v4 adds 3D), so items are called "item(s)", not "canvas(es)".
function lintBestPracticesV4(manifest: unknown): Finding[] {
  const warnings: Finding[] = [];
  if (!isRecord(manifest)) {
    return warnings;
  }

  if (typeof manifest.id === "string" && manifest.id.startsWith("http://")) {
    warnings.push(warn("Manifest id uses http; https is recommended."));
  }

  if (isRecord(manifest.label) && "none" in manifest.label) {
    warnings.push(
      warn(
        'Manifest label uses "none"; use a BCP-47 language code (e.g. "en") if the language is known.',
      ),
    );
  }

  if (manifest.summary === undefined) {
    warnings.push(warn("Manifest has no summary; a short description is recommended."));
  }

  if (manifest.metadata === undefined) {
    warnings.push(warn("Manifest has no metadata; descriptive metadata is recommended."));
  }

  if (manifest.requiredStatement === undefined) {
    warnings.push(
      warn(
        "Manifest has no requiredStatement; consider adding licensing/attribution info (optional per spec).",
      ),
    );
  }

  if (Array.isArray(manifest.items)) {
    const unlabeled = manifest.items.filter(
      (item) => isRecord(item) && item.label === undefined,
    ).length;
    if (unlabeled > 0) {
      warnings.push(warn(`${unlabeled} item(s) have no label; labels are recommended.`));
    }

    const withoutContent = manifest.items.filter(
      (item) => isRecord(item) && (!Array.isArray(item.items) || item.items.length === 0),
    ).length;
    if (withoutContent > 0) {
      warnings.push(
        warn(
          `${withoutContent} item(s) have no content (items); each Canvas/Timeline/Scene should have at least one annotation page.`,
        ),
      );
    }
  }

  return warnings;
}

// layer 4 for Presentation 2: the same spirit as lintBestPracticesV3, adapted to v2's
// field names (description/license/attribution instead of summary/rights/provider) and
// its extra sequences → canvases nesting. label is skipped here since the v2 schema
// already requires it on both Manifest and Canvas, so a missing one is an L2 error, not
// an L4 warning.
function lintBestPracticesV2(manifest: unknown): Finding[] {
  const warnings: Finding[] = [];
  if (!isRecord(manifest)) {
    return warnings;
  }

  if (typeof manifest["@id"] === "string" && manifest["@id"].startsWith("http://")) {
    warnings.push(warn("Manifest @id uses http; https is recommended."));
  }

  if (manifest.description === undefined) {
    warnings.push(warn("Manifest has no description; a short description is recommended."));
  }

  if (manifest.thumbnail === undefined) {
    warnings.push(warn("Manifest has no thumbnail; one is recommended for previews."));
  }

  if (manifest.metadata === undefined) {
    warnings.push(warn("Manifest has no metadata; descriptive metadata is recommended."));
  }

  if (manifest.license === undefined && manifest.attribution === undefined) {
    warnings.push(
      warn(
        "Manifest has no license or attribution; consider adding licensing/attribution info (optional per spec).",
      ),
    );
  }

  const canvases = collectV2Canvases(manifest);
  const withoutContent = canvases.filter(
    (canvas) => !Array.isArray(canvas.images) || canvas.images.length === 0,
  ).length;
  if (withoutContent > 0) {
    warnings.push(
      warn(
        `${withoutContent} canvas(es) have no content (images); each canvas should have at least one image.`,
      ),
    );
  }

  return warnings;
}

// flattens every canvas across every sequence. safe against a manifest that failed the
// sequences/canvases shape checks, since that path never reaches L4 lint.
function collectV2Canvases(manifest: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(manifest.sequences)) {
    return [];
  }
  return manifest.sequences.flatMap((sequence) =>
    isRecord(sequence) && Array.isArray(sequence.canvases)
      ? sequence.canvases.filter(isRecord)
      : [],
  );
}

function warn(message: string): Finding {
  return { severity: "warning", layer: 4, message };
}

// content resources whose id should actually dereference. canvas/service/manifest-child
// identifiers are deliberately excluded — in IIIF those need not resolve. covers
// Presentation 3's plain types, Presentation 2's DCMI "dctypes:" ones (e.g. a v2
// canvas's images[].resource is a dctypes:Image nested inside an oa:Annotation), and
// Presentation 4's renamed/added ones ("Audio" replaces "Sound"; "Model" is new, for 3D).
// dctypes:Image/Sound/Text are named explicitly by the 2.0 spec; dctypes:MovingImage
// isn't spec-mandated but is the de facto convention real AV manifests use.
const contentResourceTypes = new Set([
  "Image",
  "Sound",
  "Audio",
  "Video",
  "Model",
  "Text",
  "Dataset",
  "dctypes:Image",
  "dctypes:Sound",
  "dctypes:MovingImage",
  "dctypes:Text",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

// a path segment escaped per the JSON Pointer spec: "~" → "~0", "/" → "~1".
function escapePointerSegment(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

// collect the http(s) URLs worth fetching — the manifest's own id plus every nested
// content resource id — each mapped to the JSON Pointer of the id that referenced it,
// so a dead link can be marked and jumped to in the editor. deduped (first wins).
// checks both Presentation 3's "id"/"type" and Presentation 2's "@id"/"@type", since
// this walk runs on manifests of either version.
// referenceCount counts every id that pointed at a URL, so the caller can say how many
// references the deduped set came from.
function collectResourceUrls(manifest: unknown): {
  urlToPointer: Map<string, string>;
  referenceCount: number;
} {
  const urlToPointer = new Map<string, string>();
  let referenceCount = 0;

  function walk(value: unknown, path: (string | number)[]): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, index]));
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    const type = value.type ?? value["@type"];
    const isContentResource = typeof type === "string" && contentResourceTypes.has(type);
    const isManifestRoot = path.length === 0;
    const idKey = typeof value.id === "string" ? "id" : typeof value["@id"] === "string" ? "@id" : undefined;
    if (
      (isContentResource || isManifestRoot) &&
      idKey !== undefined &&
      isHttpUrl(value[idKey] as string)
    ) {
      const url = value[idKey] as string;
      referenceCount += 1;
      if (!urlToPointer.has(url)) {
        const pointer = [...path, idKey]
          .map((segment) => "/" + escapePointerSegment(segment))
          .join("");
        urlToPointer.set(url, pointer);
      }
    }
    for (const key of Object.keys(value)) {
      walk(value[key], [...path, key]);
    }
  }
  walk(manifest, []);

  return { urlToPointer, referenceCount };
}

// returns a finding on failure, undefined on success. the pointer locates the id that
// referenced this URL, so the UI can mark and jump to dead links like schema errors.
async function checkUrl(url: string, pointer: string): Promise<Finding | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    // the status line is all we need — cancel the body so the browser doesn't
    // download entire images/videos just to prove they exist.
    void response.body?.cancel();
    if (!response.ok) {
      return {
        severity: "error",
        layer: 3,
        message: `${response.status} ${response.statusText} - ${url}`,
        pointer,
      };
    }
    return undefined;
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    const reason = timedOut
      ? "timed out after 10s"
      : error instanceof Error
        ? error.message
        : String(error);
    return {
      severity: "error",
      layer: 3,
      message: `Unreachable (${reason}) - ${url}`,
      pointer,
    };
  }
}

// checks every URL, but with a fixed number of requests in flight so a large manifest
// doesn't hit one host with hundreds of parallel fetches and collect rate-limit errors
// that look like dead links. workers pull from a shared cursor until the list runs out.
// ponytail: 8 is a guess that behaves politely; tune if checks feel slow.
async function checkUrlsWithPool(
  entries: [string, string][],
  onProgress?: (completed: number, total: number) => void,
  concurrency = 8,
): Promise<Finding[]> {
  // results are stored by position, not appended, so findings stay in manifest order
  // however the workers happen to interleave.
  const results: (Finding | undefined)[] = new Array(entries.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      const [url, pointer] = entries[index];
      results[index] = await checkUrl(url, pointer);
      completed += 1;
      onProgress?.(completed, entries.length);
    }
  }

  const workerCount = Math.min(concurrency, entries.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results.filter((finding): finding is Finding => finding !== undefined);
}

// layer 3: do the URLs the manifest references actually resolve? this is the extension's
// edge — host_permissions let it fetch cross-origin. network-bound, so it is async and a
// separate action rather than part of the sync validate().
export async function validateLinks(
  text: string,
  onProgress?: (completed: number, total: number) => void,
): Promise<Finding[]> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [{ severity: "error", layer: 1, message: "Invalid JSON - fix Layer 1 first." }];
  }

  const { urlToPointer, referenceCount } = collectResourceUrls(manifest);
  if (urlToPointer.size === 0) {
    return [
      { severity: "ok", layer: 3, message: "Layer 3: no resolvable resource URLs found." },
    ];
  }

  const failures = await checkUrlsWithPool([...urlToPointer.entries()], onProgress);

  const duplicateNote =
    referenceCount > urlToPointer.size ? ` (deduped from ${referenceCount} references)` : "";
  const summary: Finding = {
    severity: failures.length > 0 ? "error" : "ok",
    layer: 3,
    message:
      failures.length > 0
        ? `Layer 3: ${failures.length} of ${urlToPointer.size} resource(s) failed to resolve${duplicateNote}.`
        : `Layer 3 passed - all ${urlToPointer.size} resource(s) resolved${duplicateNote}.`,
  };

  return [summary, ...failures];
}
