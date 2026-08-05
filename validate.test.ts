// locks down the validate() contract: text in, Finding[] out, layered L1/L2/L4.
// run with `npm test` (the pretest hook regenerates manifest-validator.js first).
import { describe, expect, test } from "vitest";
import { validate, type Finding } from "./validate";

// a manifest that passes L2 and trips none of the L4 lint rules.
function cleanManifest(): Record<string, unknown> {
  return {
    "@context": "http://iiif.io/api/presentation/3/context.json",
    id: "https://example.org/manifest",
    type: "Manifest",
    label: { en: ["Clean example"] },
    summary: { en: ["A clean example manifest."] },
    thumbnail: [{ id: "https://example.org/thumb.jpg", type: "Image" }],
    metadata: [{ label: { en: ["Date"] }, value: { en: ["1900"] } }],
    rights: "http://creativecommons.org/publicdomain/zero/1.0/",
    provider: [
      { id: "https://example.org/about", type: "Agent", label: { en: ["Example Org"] } },
    ],
    items: [
      {
        id: "https://example.org/canvas/1",
        type: "Canvas",
        label: { en: ["Page 1"] },
        height: 100,
        width: 100,
        items: [
          {
            id: "https://example.org/page/1",
            type: "AnnotationPage",
            items: [
              {
                id: "https://example.org/annotation/1",
                type: "Annotation",
                motivation: "painting",
                target: "https://example.org/canvas/1",
                body: {
                  id: "https://example.org/image/1.jpg",
                  type: "Image",
                  format: "image/jpeg",
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

// a Presentation 4.0 manifest that passes L2 and trips none of the L4 lint rules.
// unlike v3, an item's target/motivation/type wiring is stricter (target is an object,
// not a bare URI string; motivation is always an array) — see the v4 lint/tests below.
function cleanManifestV4(): Record<string, unknown> {
  return {
    "@context": "http://iiif.io/api/presentation/4/context.json",
    id: "https://example.org/manifest",
    type: "Manifest",
    label: { en: ["Clean v4 example"] },
    summary: { en: ["A clean v4 example manifest."] },
    metadata: [{ label: { en: ["Date"] }, value: { en: ["1900"] } }],
    requiredStatement: {
      label: { en: ["Attribution"] },
      value: { en: ["Example Org"] },
    },
    items: [
      {
        id: "https://example.org/canvas/1",
        type: "Canvas",
        label: { en: ["Page 1"] },
        height: 100,
        width: 100,
        items: [
          {
            id: "https://example.org/page/1",
            type: "AnnotationPage",
            items: [
              {
                id: "https://example.org/annotation/1",
                type: "Annotation",
                motivation: ["painting"],
                target: { id: "https://example.org/canvas/1", type: "Canvas" },
                body: {
                  id: "https://example.org/image/1.jpg",
                  type: "Image",
                  format: "image/jpeg",
                  height: 100,
                  width: 100,
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

// a Presentation 2.1 manifest that passes L2 and trips none of the L4 lint rules.
function cleanManifestV2(): Record<string, unknown> {
  return {
    "@context": "http://iiif.io/api/presentation/2/context.json",
    "@id": "https://example.org/manifest",
    "@type": "sc:Manifest",
    label: "Clean example",
    description: "A clean example manifest.",
    thumbnail: { "@id": "https://example.org/thumb.jpg" },
    metadata: [{ label: "Date", value: "1900" }],
    license: "http://creativecommons.org/publicdomain/zero/1.0/",
    sequences: [
      {
        "@type": "sc:Sequence",
        canvases: [
          {
            "@id": "https://example.org/canvas/1",
            "@type": "sc:Canvas",
            label: "Page 1",
            height: 100,
            width: 100,
            images: [{ "@id": "https://example.org/image/1" }],
          },
        ],
      },
    ],
  };
}

function errors(findings: Finding[]): Finding[] {
  return findings.filter((finding) => finding.severity === "error");
}

function warnings(findings: Finding[]): Finding[] {
  return findings.filter((finding) => finding.severity === "warning");
}

describe("layer 1 - JSON well-formedness", () => {
  test("empty input is a single L1 error", () => {
    const findings = validate("   ");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].layer).toBe(1);
  });

  test("malformed JSON is a single L1 error", () => {
    const findings = validate('{"trailing": true,}');
    expect(findings).toHaveLength(1);
    expect(findings[0].layer).toBe(1);
    expect(findings[0].message).toContain("Invalid JSON");
  });
});

describe("layer 2 - IIIF structure", () => {
  test("a clean manifest passes L1 and L2 with no errors", () => {
    const findings = validate(JSON.stringify(cleanManifest()));
    expect(errors(findings)).toHaveLength(0);
    const okLayers = findings
      .filter((finding) => finding.severity === "ok")
      .map((finding) => finding.layer);
    expect(okLayers).toEqual([1, 2]);
  });

  test("a wrong-typed field carries a pointer to it", () => {
    const manifest = { ...cleanManifest(), type: 123 };
    const findings = validate(JSON.stringify(manifest));
    const typeErrors = errors(findings).filter((finding) => finding.pointer === "/type");
    expect(typeErrors.length).toBeGreaterThan(0);
    expect(typeErrors[0].layer).toBe(2);
  });

  test("a missing required property points at the root (empty pointer)", () => {
    const manifest = cleanManifest();
    delete manifest.id;
    const findings = validate(JSON.stringify(manifest));
    const rootErrors = errors(findings).filter((finding) => finding.pointer === "");
    expect(rootErrors.length).toBeGreaterThan(0);
    expect(rootErrors[0].message).toContain("'id'");
  });

  test("a malformed manifest id fails the schema's format: uri check", () => {
    // starts with "http" (satisfies the id type's separate pattern check) but has an
    // unencoded space, which format: "uri" rejects and a bare pattern check would not.
    // proves ajv-formats is actually wired up: without it, Ajv silently skips
    // format: "uri" and this manifest would incorrectly pass L2.
    const manifest = { ...cleanManifest(), id: "http://example.org/not a valid uri" };
    const findings = validate(JSON.stringify(manifest));
    const idErrors = errors(findings).filter((finding) => finding.pointer === "/id");
    expect(idErrors.length).toBeGreaterThan(0);
  });

  test("an https Creative Commons rights URI gets a specific, actionable message", () => {
    // creativecommons.org and rightsstatements.org define http as their canonical rights
    // URI (their pages redirect to https for browsing, but the identifier itself must
    // stay http for RDF/linked-data interoperability - see IIIF/trc#32). Ajv's raw
    // message for this ("must match exactly one schema in oneOf") doesn't explain that,
    // so it's replaced with one that does.
    const manifest = {
      ...cleanManifest(),
      rights: "https://creativecommons.org/publicdomain/mark/1.0/",
    };
    const findings = validate(JSON.stringify(manifest));
    const rightsErrors = errors(findings).filter((finding) => finding.pointer === "/rights");
    expect(rightsErrors).toHaveLength(1);
    expect(rightsErrors[0].message).toContain("canonical rights URI");
    expect(rightsErrors[0].message).toContain(
      'Use "http://creativecommons.org/publicdomain/mark/1.0/" instead.',
    );
  });

  test("an https RightsStatements.org URI gets the same specific message", () => {
    const manifest = {
      ...cleanManifest(),
      rights: "https://rightsstatements.org/vocab/InC/1.0/",
    };
    const findings = validate(JSON.stringify(manifest));
    const rightsErrors = errors(findings).filter((finding) => finding.pointer === "/rights");
    expect(rightsErrors).toHaveLength(1);
    expect(rightsErrors[0].message).toContain('Use "http://rightsstatements.org/vocab/InC/1.0/" instead.');
  });

  test("an unrelated invalid rights URI still gets Ajv's generic message", () => {
    const manifest = { ...cleanManifest(), rights: "https://example.org/not-a-real-license" };
    const findings = validate(JSON.stringify(manifest));
    const rightsErrors = errors(findings).filter((finding) => finding.pointer === "/rights");
    expect(rightsErrors).toHaveLength(1);
    expect(rightsErrors[0].message).toContain("must match exactly one schema in oneOf");
  });

  test("a canvas without dimensions or duration collapses to one readable error", () => {
    const manifest = cleanManifest();
    const canvas = (manifest.items as Record<string, unknown>[])[0];
    delete canvas.height;
    delete canvas.width;
    const findings = validate(JSON.stringify(manifest));
    const canvasErrors = errors(findings).filter((finding) =>
      finding.pointer?.startsWith("/items/0"),
    );
    // Ajv's raw output is four errors (three required + one anyOf); the anyOf branch
    // noise is collapsed into a single finding that names the alternatives. the
    // official schema anyOfs width/height/duration as three separate one-property
    // branches (a separate "dependencies" clause enforces width+height must co-occur),
    // unlike the old hand-rolled schema's two-branch [height+width] or [duration].
    expect(canvasErrors).toHaveLength(1);
    expect(canvasErrors[0].message).toContain("must have width, or height, or duration");
  });

  test("L4 lint does not run when L2 fails", () => {
    const manifest = { ...cleanManifest(), type: 123 };
    const findings = validate(JSON.stringify(manifest));
    expect(warnings(findings)).toHaveLength(0);
  });

  test("an empty items array is a spec violation, not a warning", () => {
    const manifest = { ...cleanManifest(), items: [] };
    const findings = validate(JSON.stringify(manifest));
    const itemErrors = errors(findings).filter((finding) => finding.pointer === "/items");
    expect(itemErrors).toHaveLength(1);
    expect(itemErrors[0].message).toContain("fewer than 1 items");
  });

  test("an @context that matches no supported version is rejected", () => {
    const manifest = { ...cleanManifest(), "@context": "http://example.org/wrong.json" };
    const findings = validate(JSON.stringify(manifest));
    const contextErrors = errors(findings).filter(
      (finding) => finding.pointer === "/@context",
    );
    expect(contextErrors).toHaveLength(1);
    expect(contextErrors[0].message).toContain("Presentation 2.1, 3.0, and 4.0");
  });

  test("a canvas id with a fragment is rejected", () => {
    const manifest = cleanManifest();
    const canvas = (manifest.items as Record<string, unknown>[])[0];
    canvas.id = "https://example.org/canvas/1#fragment";
    const findings = validate(JSON.stringify(manifest));
    const idErrors = errors(findings).filter(
      (finding) => finding.pointer === "/items/0/id",
    );
    expect(idErrors).toHaveLength(1);
  });
});

describe("layer 4 - best-practice lint", () => {
  test("a clean manifest produces no warnings", () => {
    const findings = validate(JSON.stringify(cleanManifest()));
    expect(warnings(findings)).toHaveLength(0);
  });

  test("all lint rules fire on a worst-practice manifest", () => {
    const manifest = {
      "@context": "http://iiif.io/api/presentation/3/context.json",
      id: "http://example.org/manifest",
      type: "Manifest",
      label: { none: ["Untranslated"] },
      items: [
        {
          id: "https://example.org/canvas/1",
          type: "Canvas",
          height: 100,
          width: 100,
          // present but empty: the official schema requires the "items" key on a
          // Canvas but doesn't require it to be non-empty, so this still passes L2
          // while tripping the L4 "no content" lint warning below.
          items: [],
        },
      ],
    };
    const findings = validate(JSON.stringify(manifest));
    const messages = warnings(findings).map((finding) => finding.message);
    expect(messages).toHaveLength(9);
    expect(messages.join("\n")).toContain("https is recommended");
    expect(messages.join("\n")).toContain('label uses "none"');
    expect(messages.join("\n")).toContain("no summary");
    expect(messages.join("\n")).toContain("no thumbnail");
    expect(messages.join("\n")).toContain("no metadata");
    expect(messages.join("\n")).toContain("no rights or requiredStatement");
    expect(messages.join("\n")).toContain("no provider");
    expect(messages.join("\n")).toContain("have no label");
    expect(messages.join("\n")).toContain("have no content");
  });
});

describe("layer 2 - IIIF Presentation 2.1 structure", () => {
  test("a clean Presentation 2 manifest passes L1 and L2 with no errors", () => {
    const findings = validate(JSON.stringify(cleanManifestV2()));
    expect(errors(findings)).toHaveLength(0);
    const okLayers = findings
      .filter((finding) => finding.severity === "ok")
      .map((finding) => finding.layer);
    expect(okLayers).toEqual([1, 2]);
    expect(findings.find((finding) => finding.layer === 2)?.message).toContain(
      "Presentation 2.1",
    );
  });

  test("the legacy Shared Canvas context is also accepted as Presentation 2", () => {
    const manifest = {
      ...cleanManifestV2(),
      "@context": "http://www.shared-canvas.org/ns/context.json",
    };
    const findings = validate(JSON.stringify(manifest));
    expect(errors(findings)).toHaveLength(0);
  });

  test("a canvas missing height/width is a Layer 2 error", () => {
    const manifest = cleanManifestV2();
    const canvas = (manifest.sequences as Record<string, unknown>[])[0]
      .canvases as Record<string, unknown>[];
    delete canvas[0].height;
    const findings = validate(JSON.stringify(manifest));
    const canvasErrors = errors(findings).filter((finding) =>
      finding.pointer?.startsWith("/sequences/0/canvases/0"),
    );
    expect(canvasErrors.length).toBeGreaterThan(0);
  });

  test("a Presentation 2 manifest with no content warns at L4", () => {
    const manifest = cleanManifestV2();
    const canvas = (manifest.sequences as Record<string, unknown>[])[0]
      .canvases as Record<string, unknown>[];
    delete canvas[0].images;
    delete manifest.description;
    delete manifest.thumbnail;
    delete manifest.metadata;
    delete manifest.license;
    const findings = validate(JSON.stringify(manifest));
    const messages = warnings(findings).map((finding) => finding.message);
    expect(messages.join("\n")).toContain("no description");
    expect(messages.join("\n")).toContain("no thumbnail");
    expect(messages.join("\n")).toContain("no metadata");
    expect(messages.join("\n")).toContain("no license or attribution");
    expect(messages.join("\n")).toContain("have no content");
  });
});

describe("layer 2 - IIIF Presentation 4.0 structure", () => {
  test("a clean Presentation 4 manifest passes L1 and L2 with no errors", () => {
    const findings = validate(JSON.stringify(cleanManifestV4()));
    expect(errors(findings)).toHaveLength(0);
    const okLayers = findings
      .filter((finding) => finding.severity === "ok")
      .map((finding) => finding.layer);
    expect(okLayers).toEqual([1, 2]);
    expect(findings.find((finding) => finding.layer === 2)?.message).toContain(
      "Presentation 4.0",
    );
  });

  test("a v4 canvas without dimensions is a Layer 2 error", () => {
    const manifest = cleanManifestV4();
    const canvas = (manifest.items as Record<string, unknown>[])[0];
    delete canvas.height;
    delete canvas.width;
    const findings = validate(JSON.stringify(manifest));
    const canvasErrors = errors(findings).filter((finding) =>
      finding.pointer?.startsWith("/items/0"),
    );
    expect(canvasErrors.length).toBeGreaterThan(0);
  });

  test("a v4 annotation target must be an object, not a bare URI string", () => {
    const manifest = cleanManifestV4();
    const canvas = (manifest.items as Record<string, unknown>[])[0];
    const page = (canvas.items as Record<string, unknown>[])[0] as Record<string, unknown>;
    const annotation = (page.items as Record<string, unknown>[])[0];
    annotation.target = "https://example.org/canvas/1";
    const findings = validate(JSON.stringify(manifest));
    expect(errors(findings).length).toBeGreaterThan(0);
  });

  test("a v4 manifest with no content warns at L4", () => {
    const manifest = cleanManifestV4();
    const canvas = (manifest.items as Record<string, unknown>[])[0];
    canvas.items = [];
    delete manifest.summary;
    delete manifest.metadata;
    delete manifest.requiredStatement;
    const findings = validate(JSON.stringify(manifest));
    const messages = warnings(findings).map((finding) => finding.message);
    expect(messages.join("\n")).toContain("no summary");
    expect(messages.join("\n")).toContain("no metadata");
    expect(messages.join("\n")).toContain("no requiredStatement");
    expect(messages.join("\n")).toContain("have no content");
  });
});
