import type { ExternalToolDefinition, ExternalToolName } from "./catalog";
import { DEFAULT_EXTERNAL_PERMISSIONS, isExternalPermissionCode, type ExternalPermission, type ExternalPermissions, type ExternalTrust } from "./contract";

export type ApprovalNeed =
  | { kind: "none" }
  | { kind: "refuse"; error: "read_only" | "not_permitted" }
  /** sessionGrant: the user may allow this kind of write for the rest of the connection. */
  | { kind: "ask"; sessionGrant: boolean };

const STRICTNESS: Record<ExternalPermission, number> = { deny: 0, ask: 1, allow: 2 };

/** What a custom level lets this call do: its own permission, tightened by overwrite_files when it replaces files. */
export function customPermission(permissions: ExternalPermissions | undefined, tool: ExternalToolName, destructive: boolean): ExternalPermission {
  const all = permissions ?? DEFAULT_EXTERNAL_PERMISSIONS;
  const own = isExternalPermissionCode(tool) ? all[tool] : "ask";
  if (!destructive) return own;
  return STRICTNESS[all.overwrite_files] < STRICTNESS[own] ? all.overwrite_files : own;
}

/**
 * Whether a call needs the user's yes in FusionKit. Reads never ask; read-only
 * refuses every change; full runs everything; custom follows each operation's
 * permission; otherwise destructive and always-confirmed calls ask in every
 * level and other writes ask in confirm_writes unless allowed for this connection.
 */
export function approvalNeed(trust: ExternalTrust, definition: Pick<ExternalToolDefinition, "access" | "group" | "confirm">,
  options: { destructive?: boolean; granted?: boolean; tool?: ExternalToolName; permissions?: ExternalPermissions } = {}): ApprovalNeed {
  if (definition.access === "read") return { kind: "none" };
  if (trust === "read_only") return { kind: "refuse", error: "read_only" };
  if (trust === "full") return { kind: "none" };
  const destructive = definition.access === "destructive" || !!options.destructive;
  if (trust === "custom") {
    const permission = options.tool ? customPermission(options.permissions, options.tool, destructive) : "ask";
    if (permission === "deny") return { kind: "refuse", error: "not_permitted" };
    if (permission === "allow" || (options.granted && !destructive)) return { kind: "none" };
    return { kind: "ask", sessionGrant: !!definition.group && !destructive };
  }
  if (destructive || definition.confirm === "always") return { kind: "ask", sessionGrant: false };
  if (trust === "auto") return { kind: "none" };
  if (options.granted) return { kind: "none" };
  return { kind: "ask", sessionGrant: !!definition.group };
}
