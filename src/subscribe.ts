import { DualMuninnClient } from "./dual-client";
import { ActivationPush } from "./vault";
import { client } from "./shared-client";

/**
 * Starts an SSE subscription to receive real-time memory pushes.
 * Pushes are dispatched to the onPush callback as they arrive.
 * Runs as a background async loop with automatic reconnection.
 */
export async function startSSESubscription(
  client: DualMuninnClient,
  vault: string,
  signal: AbortSignal,
  onPush: (push: ActivationPush) => void,
): Promise<void> {
  (async () => {
    try {
      for await (const push of client.subscribe(vault, signal)) {
        // Dispatch contradiction warnings with higher priority
        if (push.trigger === "contradiction_detected") {
          onPush(push);
        } else if (
          push.trigger === "new_write" &&
          push.engram &&
          push.score != null &&
          push.score >= 0.7
        ) {
          // Only queue high-scoring pushes for context injection
          onPush(push);
        }
        // threshold_crossed events are informational — skip for now
      }
    } catch {
      // Subscription ended (expected on disconnect)
    }
  })();
}
