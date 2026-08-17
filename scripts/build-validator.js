// precompiles the IIIF schema into a standalone, eval-free validator module.
//
// browser extensions forbid eval / new Function via their Content Security Policy.
// Ajv normally compiles a schema at runtime by generating code and running it with
// new Function, which the extension blocks. generating the validator ahead of time
// produces plain JavaScript we can import like any other module — no eval needed.

import Ajv from "ajv";
// v4's schema files declare draft 2020-12 ($schema: ".../2020-12/schema"), unlike v2/v3's
// draft-07 - a different Ajv class is required to understand that dialect.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

// load the schemas (the rules) as plain objects, one per supported IIIF Presentation
// API version. add a new entry here (and a matching .schema.json) to support a version.
//
// schemas/presentation-3.schema.json is the official schema from the IIIF-run
// presentation-validator project (the same one behind
// https://presentation-validator.iiif.io/), not hand-rolled. its root schema validates
// any IIIF Presentation resource (Manifest, Collection, Range, ...) via a five-way
// oneOf, which is the wrong entry point for us: loupe-iiif only ever validates a
// Manifest, and compiling the oneOf root makes Ajv report a failed match against all
// five resource types for every real error. point the compiled validator at
// #/classes/manifest instead - the same "types"/"classes" definitions the oneOf root
// draws from, just entered directly at the Manifest shape. ($ref overrides sibling
// validation keywords in draft-07, but types/classes are plain data, not validation
// keywords, so they still resolve normally.)
const schemaV3Source = JSON.parse(
  readFileSync("schemas/presentation-3.schema.json", "utf8"),
);
const schemaV3 = {
  ...schemaV3Source,
  $id: "iiif-presentation-3-manifest",
  $ref: "#/classes/manifest",
};
delete schemaV3.oneOf;
const schemaV2 = JSON.parse(
  readFileSync("schemas/presentation-2.schema.json", "utf8"),
);

// allErrors: report every problem, not just the first.
// code.source: keep the generated code so it can be exported as standalone source.
// strict: false - the official IIIF Presentation 3 schema uses "types"/"classes" as
// custom definition containers (like $defs, just not named that), which Ajv's strict
// mode flags as unknown keywords even though they're valid, inert JSON Schema.
const ajv = new Ajv({ allErrors: true, code: { source: true }, strict: false });
// both official schemas lean on format: "uri" / "date-time" throughout - without
// ajv-formats registering what those words mean, Ajv silently skips them ("unknown
// format ... ignored"), so e.g. "rights": "not a url" would pass unchecked.
addFormats(ajv);

// compile each schema (this is the step that uses eval — fine in Node) and register it
// under its $id, so standaloneCode below can look each one up by name.
ajv.compile(schemaV3);
ajv.compile(schemaV2);

// serialize both validators into one plain, eval-free JavaScript source, named exports
// matching the keys below (validateManifestV3, validateManifestV2).
const moduleSource = standaloneCode(ajv, {
  validateManifestV3: schemaV3.$id,
  validateManifestV2: schemaV2.$id,
});

// write it out; workbench.js imports this file. the length log is a quick sanity check.
console.log("Generated validator length:", moduleSource.length);
writeFileSync("manifest-validator.js", moduleSource);
console.log("Wrote manifest-validator.js");

// --- Presentation 4 ---
//
// the official v4 schema (also from the presentation-validator project, still tracking
// the upstream draft) ships as 73 separate files that $ref each other by relative
// filename, resolved against each file's own $id - e.g. Manifest.json refs
// "Canvas.json" and "properties.json#/$defs/id". registering every file with
// addSchema() lets Ajv resolve those refs the same way a browser would resolve
// relative URLs. kept in its own Ajv2020 instance (and compiled to its own output
// file below) rather than merged into the draft-07 ajv above: standalone code
// generation names its internal variables per Ajv instance (schema11, validate10, ...),
// and two independently generated blobs sharing one file risk colliding on those names.
const schemaV4Directory = "schemas/presentation-4";
const ajv2020 = new Ajv2020({ allErrors: true, code: { source: true }, strict: false });
addFormats(ajv2020);
for (const fileName of readdirSync(schemaV4Directory)) {
  const schema = JSON.parse(readFileSync(`${schemaV4Directory}/${fileName}`, "utf8"));
  ajv2020.addSchema(schema);
}

// same reasoning as v3 above: point the compiled validator at Manifest.json directly
// (it's already registered under its own $id via addSchema, so no separate compile()
// call is needed) rather than main.json, which is a five-way dispatcher
// (Manifest/Collection/AnnotationCollection/AnnotationPage/Annotation) that would
// report failed matches against all five alternatives for every real error, since
// loupe-iiif only ever validates a Manifest.
const schemaV4Id = "https://iiif.io/api/presentation/4.0/schema/Manifest.json";

const moduleSourceV4 = standaloneCode(ajv2020, { validateManifestV4: schemaV4Id });

console.log("Generated v4 validator length:", moduleSourceV4.length);
writeFileSync("manifest-validator-v4.js", moduleSourceV4);
console.log("Wrote manifest-validator-v4.js");
