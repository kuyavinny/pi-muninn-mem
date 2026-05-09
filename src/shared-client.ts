/**
 * Shared MuninnDB client singleton.
 *
 * Reads the MCP configuration (mcp.json) to determine which MuninnDB
 * server to connect to. The REST URL is derived from the MCP URL
 * using the MuninnDB port convention (REST port = MCP port - 275).
 *
 * This is the single MuninnClient instance used by the extension
 * for SSE subscription. All other operations go through MCP tools.
 */
import { MuninnClient } from "./client";
import { getMuninnRestUrl } from "./vault";

export const client = new MuninnClient({ restUrl: getMuninnRestUrl() });