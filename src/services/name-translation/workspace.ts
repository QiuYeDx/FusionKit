import type { NameEntry, NameIssueCode } from "@/name-translation/contract";
import {
  composeName,
  getNameIssue,
  nameKey,
  numberName,
} from "@/name-translation/naming-rules";

/**
 * Pure derivations for the name translator workspace. The store keeps raw
 * facts (entries, selections, translations); everything shown in rows is
 * derived here so statuses and conflicts can never drift out of sync.
 */

export interface DirectoryState {
  readonly status: "loading" | "loaded" | "error";
  readonly children: readonly string[];
  readonly truncated: boolean;
  readonly error?: string;
}

export interface Proposal {
  /** Cleaned translated stem returned by the model. */
  readonly stem?: string;
  /** Full name typed by the user; wins over the translation. */
  readonly edited?: string;
  readonly translating?: boolean;
  readonly failed?: boolean;
  /** Settings the stem was translated with. */
  readonly settingsKey?: string;
}

export interface ServerIssue {
  readonly issue: NameIssueCode;
  /** Proposed name that the main process rejected. */
  readonly name: string;
}

export interface WorkspaceData {
  readonly roots: readonly string[];
  readonly entries: Readonly<Record<string, NameEntry>>;
  readonly dirs: Readonly<Record<string, DirectoryState>>;
  readonly checked: Readonly<Record<string, true>>;
  readonly proposals: Readonly<Record<string, Proposal>>;
  readonly serverIssues: Readonly<Record<string, ServerIssue>>;
}

export interface WorkspaceSettings {
  /** `{translated}` / `{original}` name template. */
  readonly template: string;
  readonly settingsKey: string;
  readonly platform: string;
}

export type RowStatus =
  | "idle"
  | "pending"
  | "translating"
  | "stale"
  | "failed"
  | "unchanged"
  | "issue"
  | "ready";

export interface RowState {
  readonly status: RowStatus;
  readonly proposedName?: string;
  readonly issue?: NameIssueCode;
  readonly edited: boolean;
}

export function settingsKeyOf(settings: {
  sourceLang: string;
  targetLang: string;
  instructions: string;
}): string {
  return `${settings.sourceLang}|${settings.targetLang}|${settings.instructions.trim()}`;
}

export function proposedNameOf(
  entry: NameEntry,
  proposal: Proposal | undefined,
  template: string,
): string | undefined {
  if (!proposal) return undefined;
  if (proposal.edited !== undefined) return proposal.edited;
  if (proposal.stem === undefined) return undefined;
  return composeName({
    originalName: entry.name,
    kind: entry.kind,
    translatedStem: proposal.stem,
    template,
  });
}

function baseStatus(
  entry: NameEntry,
  checked: boolean,
  proposal: Proposal | undefined,
  proposedName: string | undefined,
  settings: WorkspaceSettings,
): RowStatus {
  if (proposal?.translating) return "translating";
  if (!checked) return "idle";
  const edited = proposal?.edited !== undefined;
  if (!edited && proposal?.failed && proposal.stem === undefined) return "failed";
  if (proposedName === undefined) return "pending";
  if (!edited && proposal?.settingsKey !== settings.settingsKey) return "stale";
  if (proposedName === entry.name) return "unchanged";
  return "ready";
}

/**
 * Computes the row state of every checked or translated entry, including
 * conflicts between siblings. Entries that drop out keep their current name,
 * which can block another entry, so conflicts are resolved to a fixpoint.
 */
export function computeRowStates(
  data: WorkspaceData,
  settings: WorkspaceSettings,
): Map<string, RowState> {
  const states = new Map<string, RowState>();
  const candidates = new Map<string, { entry: NameEntry; name: string }>();

  const keys = new Set([...Object.keys(data.checked), ...Object.keys(data.proposals)]);
  for (const key of keys) {
    const entry = data.entries[key];
    if (!entry) continue;
    const proposal = data.proposals[key];
    const proposedName = proposedNameOf(entry, proposal, settings.template);
    let status = baseStatus(entry, Boolean(data.checked[key]), proposal, proposedName, settings);
    let issue: NameIssueCode | undefined;
    if (status === "ready" && proposedName !== undefined) {
      const local = getNameIssue(proposedName);
      const server = data.serverIssues[key];
      if (local) issue = local;
      else if (server && server.name === proposedName) issue = server.issue;
      if (issue) status = "issue";
      else candidates.set(key, { entry, name: proposedName });
    }
    states.set(key, {
      status,
      ...(proposedName !== undefined ? { proposedName } : {}),
      ...(issue ? { issue } : {}),
      edited: proposal?.edited !== undefined,
    });
  }

  for (const [key, issue] of resolveSiblingConflicts(data, candidates, settings.platform)) {
    const state = states.get(key)!;
    states.set(key, { ...state, status: "issue", issue });
  }
  return states;
}

function siblingsOf(data: WorkspaceData, parentPath: string, members: readonly string[]): string[] {
  const listing = data.dirs[parentPath];
  const siblings = new Set<string>(listing?.status === "loaded" ? listing.children : []);
  for (const root of data.roots) {
    if (data.entries[root]?.parentPath === parentPath) siblings.add(root);
  }
  members.forEach((member) => siblings.add(member));
  return [...siblings];
}

export function resolveSiblingConflicts(
  data: WorkspaceData,
  candidates: ReadonlyMap<string, { entry: NameEntry; name: string }>,
  platform: string,
): Map<string, NameIssueCode> {
  const issues = new Map<string, NameIssueCode>();
  const byParent = new Map<string, string[]>();
  for (const [key, { entry }] of candidates) {
    const group = byParent.get(entry.parentPath) ?? [];
    group.push(key);
    byParent.set(entry.parentPath, group);
  }

  for (const [parentPath, members] of byParent) {
    const siblings = siblingsOf(data, parentPath, members);
    let changed = true;
    while (changed) {
      changed = false;
      const owners = new Map<string, string[]>();
      for (const sibling of siblings) {
        const candidate = !issues.has(sibling) ? candidates.get(sibling) : undefined;
        const name = candidate?.name ?? data.entries[sibling]?.name;
        if (name === undefined) continue;
        const nameKeyValue = nameKey(name, platform);
        owners.set(nameKeyValue, [...(owners.get(nameKeyValue) ?? []), sibling]);
      }
      // Judge every member against the same snapshot of this pass.
      const found = new Map<string, NameIssueCode>();
      for (const member of members) {
        if (issues.has(member)) continue;
        const candidate = candidates.get(member)!;
        const sameName = owners.get(nameKey(candidate.name, platform)) ?? [];
        if (sameName.length <= 1) continue;
        const otherCandidate = sameName.some(
          (owner) => owner !== member && candidates.has(owner) && !issues.has(owner),
        );
        found.set(member, otherCandidate ? "duplicate_target" : "target_exists");
      }
      for (const [member, issue] of found) issues.set(member, issue);
      changed = found.size > 0;
    }
  }
  return issues;
}

/**
 * Suggests numbered names (" (2)", " (3)") for entries that share a target name
 * in the same folder. Returns path -> new full name.
 */
export function suggestNumberedNames(
  data: WorkspaceData,
  states: ReadonlyMap<string, RowState>,
  platform: string,
): Map<string, string> {
  const duplicates = [...states.entries()].filter(([, state]) => state.issue === "duplicate_target");
  const byParent = new Map<string, string[]>();
  for (const [key] of duplicates) {
    const parent = data.entries[key]?.parentPath;
    if (parent === undefined) continue;
    byParent.set(parent, [...(byParent.get(parent) ?? []), key]);
  }
  const result = new Map<string, string>();
  for (const [parentPath, members] of byParent) {
    const memberSet = new Set(members);
    const taken = new Set<string>();
    for (const sibling of siblingsOf(data, parentPath, members)) {
      if (memberSet.has(sibling)) continue;
      const state = states.get(sibling);
      const name = state?.status === "ready" ? state.proposedName : data.entries[sibling]?.name;
      if (name !== undefined) taken.add(nameKey(name, platform));
    }
    for (const member of members) {
      const entry = data.entries[member]!;
      const proposed = states.get(member)?.proposedName ?? entry.name;
      result.set(member, numberName(proposed, entry.kind, taken, platform));
    }
  }
  return result;
}

export interface VisibleRow {
  readonly key: string;
  readonly depth: number;
  readonly expanded: boolean;
  readonly expandable: boolean;
  readonly checkedInside: number;
  readonly loadedInside: number;
}

export type RowFilter = "all" | "checked" | "issues";

/** Walks expanded folders and returns rows in display order. */
export function computeVisibleRows(
  data: WorkspaceData,
  expanded: Readonly<Record<string, true>>,
  states: ReadonlyMap<string, RowState>,
  filter: RowFilter,
): VisibleRow[] {
  const insideCache = new Map<string, { checked: number; loaded: number; matches: boolean }>();
  const matches = (key: string): boolean => {
    if (filter === "checked") return Boolean(data.checked[key]);
    if (filter === "issues") {
      const status = states.get(key)?.status;
      return status === "issue" || status === "failed";
    }
    return true;
  };
  const inside = (key: string): { checked: number; loaded: number; matches: boolean } => {
    const cached = insideCache.get(key);
    if (cached) return cached;
    const listing = data.dirs[key];
    const summary = { checked: 0, loaded: 0, matches: false };
    insideCache.set(key, summary);
    if (listing?.status === "loaded") {
      for (const child of listing.children) {
        const childInside = inside(child);
        summary.loaded += 1 + childInside.loaded;
        summary.checked += (data.checked[child] ? 1 : 0) + childInside.checked;
        summary.matches = summary.matches || matches(child) || childInside.matches;
      }
    }
    return summary;
  };

  const rows: VisibleRow[] = [];
  const visit = (key: string, depth: number) => {
    const entry = data.entries[key];
    if (!entry) return;
    const childSummary = inside(key);
    if (filter !== "all" && !matches(key) && !childSummary.matches) return;
    const expandable = entry.kind === "directory" && !entry.symlink;
    const isExpanded = expandable && Boolean(expanded[key]);
    rows.push({
      key,
      depth,
      expanded: isExpanded,
      expandable,
      checkedInside: childSummary.checked,
      loadedInside: childSummary.loaded,
    });
    if (!isExpanded) return;
    const listing = data.dirs[key];
    if (listing?.status !== "loaded") return;
    for (const child of listing.children) visit(child, depth + 1);
  };
  for (const root of data.roots) visit(root, 0);
  return rows;
}

/**
 * Maps a path through completed renames. `renamed` holds final paths, so the
 * deepest renamed ancestor alone determines the new location.
 */
export function remapPath(
  target: string,
  renamed: readonly { from: string; to: string }[],
  platform: string,
): string {
  const caseInsensitive = platform === "win32" || platform === "darwin";
  const normalize = (value: string) =>
    (caseInsensitive ? value.toLowerCase() : value).replace(/\\/g, "/");
  const normalizedTarget = normalize(target);
  let best: { from: string; to: string } | undefined;
  for (const rename of renamed) {
    const from = normalize(rename.from);
    const isSelf = normalizedTarget === from;
    const isInside = normalizedTarget.startsWith(from.endsWith("/") ? from : `${from}/`);
    if ((isSelf || isInside) && (!best || rename.from.length > best.from.length)) best = rename;
  }
  if (!best) return target;
  return `${best.to}${target.slice(best.from.length)}`;
}
