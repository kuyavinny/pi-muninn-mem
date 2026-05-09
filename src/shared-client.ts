/**
 * Shared MuninnDB client instance.
 *
 * Both the lifecycle hooks (extension.ts) and custom tools (tools.ts)
 * must use the same DualMuninnClient so that environment switches
 * via the `muninn_env` tool affect all operations.
 *
 * The initial environment is read from MUNINN_ENV (default: "prod").
 */
import { DualMuninnClient } from "./dual-client";
import { DEFAULT_ENV, Environment } from "./vault";

const MUNINN_ENV = (process.env.MUNINN_ENV as Environment) || DEFAULT_ENV;
export const client = new DualMuninnClient(MUNINN_ENV);