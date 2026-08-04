// hand-written types for the generated v4 validator (manifest-validator-v4.js).
//
// v4's schema files declare JSON Schema draft 2020-12, unlike v2/v3's draft-07, so
// scripts/build-validator.js compiles it with a separate Ajv instance and writes it to
// its own file rather than folding it into manifest-validator.js. see that file's
// header comment for why this declaration file is hand-maintained and committed
// even though the .js it describes is generated.
import type { ValidateManifestStructure } from "./manifest-validator";

export declare const validateManifestV4: ValidateManifestStructure;
