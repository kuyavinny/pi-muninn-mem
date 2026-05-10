/**
 * Shared MuninnDB client singleton.
 *
 * Uses the fixed REST URL (http://127.0.0.1:8475) for SSE subscription.
 * All other operations go through MCP tools.
 */
import { MuninnClient } from "./client";
import { MUNINN_REST_URL } from "./vault";

export const client = new MuninnClient({ restUrl: MUNINN_REST_URL });