import type { ExternalToolDefinition } from "./catalog";
import type { ExternalTrust } from "./contract";

export type ApprovalNeed =
  | { kind: "none" }
  | { kind: "refuse"; error: "read_only" }
  /** sessionGrant: the user may allow this kind of write for the rest of the connection. */
  | { kind: "ask"; sessionGrant: boolean };

/**
 * Whether a call needs the user's yes in FusionKit. Reads never ask; read-only
 * refuses every change; destructive and always-confirmed calls ask in every
 * level; other writes ask in confirm_writes unless allowed for this connection.
 */
export function approvalNeed(trust: ExternalTrust, definition: Pick<ExternalToolDefinition, "access" | "group" | "confirm">,
  options: { destructive?: boolean; granted?: boolean } = {}): ApprovalNeed {
  if (definition.access === "read") return { kind: "none" };
  if (trust === "read_only") return { kind: "refuse", error: "read_only" };
  if (definition.access === "destructive" || options.destructive || definition.confirm === "always") return { kind: "ask", sessionGrant: false };
  if (trust === "auto") return { kind: "none" };
  if (options.granted) return { kind: "none" };
  return { kind: "ask", sessionGrant: !!definition.group };
}
