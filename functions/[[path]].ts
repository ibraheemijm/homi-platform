import worker from "../src/index";
import type { Env } from "../src/types";

/**
 * Pages adapter for the Preview deployment only.
 * Keep this adapter isolated from the standalone Worker entry point.
 * The application API remains the same Worker fetch handler.
 */
export function onRequest(context: { request: Request; env: Env }): Promise<Response> {
  return worker.fetch(context.request, context.env);
}

// Preview API deployment remains on the dedicated feature branch.
