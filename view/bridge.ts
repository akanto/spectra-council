/**
 * What the view needs from its host, whatever the host is: Mirador's canvas (hosts/mirador/view.tsx), a test harness, or
 * a standalone app later. The view draws the review it is handed and sends the user's actions back; it runs nothing.
 */
import type { Review } from "../core/model.ts";
import type { ViewAction } from "../core/schemas.ts";

export interface CouncilBridge {
  /** Hands the listener the review now and on every change. */
  onReview(listener: (review: Review) => void): () => void;
  /** Rejects with the host's reason when it refuses the action. */
  send(action: ViewAction): Promise<unknown>;
  /** Opens a file, by its absolute path, where the host shows files; absent where it can't. */
  openFile?(path: string): void;
}
