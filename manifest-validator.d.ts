// hand-written types for the generated validator (manifest-validator.js).
//
// scripts/build-validator.js precompiles the IIIF schemas (one per supported
// Presentation API version) with Ajv and writes manifest-validator.js as plain,
// eval-free JavaScript — with no type information. this declaration tells
// TypeScript the shape validate.ts relies on. it sits next to the generated .js
// file, so TypeScript uses it as that module's types.
//
// the export shape (a boolean-returning function that hangs its problems off an
// `errors` property) is Ajv's stable standalone contract, so this file is
// hand-maintained and committed even though the .js it describes is generated.

// one problem Ajv found, trimmed to the fields the workbench actually reads.
export interface ValidationError {
  // JSON Pointer to the offending value, e.g. "/items/0/type" ("" means the root).
  instancePath: string;
  // JSON Pointer into the schema that failed, e.g. "#/definitions/canvas/anyOf/0/required".
  schemaPath: string;
  // the failed schema keyword, e.g. "required", "type", "anyOf".
  keyword: string;
  // keyword-specific details: missingProperty (from "required") and pattern (from
  // "pattern") are the two used here, to build readable anyOf/oneOf branch messages.
  params?: { missingProperty?: string; pattern?: string };
  message?: string;
}

// returns true when the data matches the schema; otherwise false, and the problems
// are left on `errors` until the next call.
export interface ValidateManifestStructure {
  (data: unknown): boolean;
  errors?: ValidationError[] | null;
}

// one named export per supported IIIF Presentation API version.
export declare const validateManifestV3: ValidateManifestStructure;
export declare const validateManifestV2: ValidateManifestStructure;
