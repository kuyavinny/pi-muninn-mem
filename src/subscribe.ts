import { MuninnClient } from "./client";
import { ActivationPush } from "./vault";

/**
 * Starts an SSE subscription to receive real-time memory pushes.
 *
 * Pushes are dispatched to the onPush callback as they arrive.
 * Runs as a background async loop with automatic reconnection.
 *
 * Only two event types are forwarded:
 * - contradiction_detected: always forwarded (high priority)
 * - new_write: only if score >= 0.7 (relevant memories)
 * - threshold_crossed: silently dropped (informational only)
 */
export async function startSSESubscription(
  client: MuninnClient,
  vault: string,
  signal: AbortSignal,
  onPush: (push: ActivationPush) => void,
): Promise<void> {
  (async () => {
    try {
      for await (const push of client.subscribe(vault, signal)) {
        // Contradiction warnings are always high priority
        if (push.trigger === "contradiction_detected") {
          onPush(push);
        } else if (
          push.trigger === "new_write" &&
          push.engram &&
          push.score != null &&
          push.score >= 0.7
        ) {
          // Only queue high-scoring relevant memories
          onPush(push);
        }
        // threshold_crossed events are informational — skip
      }
    } catch {
      // Subscription ended (expected on disconnect)
    }
  })();
}