/** The tool version, read from package.json (the single source of truth). */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** @type {{ version: string }} */
const pkg = require("../package.json");

export const VERSION = pkg.version;
