import type { AppUpdateError, AppUpdateSourceId } from "@/app-update/contract";
import { helpPath } from "@/pages/Help/helpNavigation";

/**
 * Next steps an update failure offers, as buttons. "open_mirror_download" is the new installer
 * through a mirror (Windows, when a version was found and the setting allows mirrors);
 * "restart_app" starts FusionKit again after a failed install; "open_help" opens the help on
 * failed downloads (download sources, proxy, mirrors).
 */
export type UpdateGuideAction = "retry" | "open_network_settings" | "open_releases" | "open_mirror_download" | "restart_app" | "open_help";

/** Where "open_help" leads: the help section on failed downloads. */
export const UPDATE_HELP_PATH = helpPath("download-failed");
/** The help section on opening an unsigned app, for the macOS replacement note. */
export const UPDATE_MAC_HELP_PATH = helpPath("cannot-open");

type UpdateErrorKey<Name extends string> = `common:update.error.${Name}`;
export type UpdateGuideTitleKey = UpdateErrorKey<'check_title' | 'download_title' | 'install_title'>;
export type UpdateGuideCauseKey = UpdateErrorKey<
  'network_cause' | 'network_cause_official' | 'not_found_cause' | 'checksum_cause' | 'disk_cause' | 'unknown_cause' | 'install_cause'
  | 'install_prepare_cause'
>;
export type UpdateGuideNextKey = UpdateErrorKey<
  'network_next_check' | 'network_next_download' | 'not_found_next' | 'checksum_next' | 'disk_next' | 'unknown_next' | 'install_next'
  | 'install_prepare_next'
>;

export interface UpdateGuide {
  readonly titleKey: UpdateGuideTitleKey;
  readonly causeKey: UpdateGuideCauseKey;
  readonly nextKey: UpdateGuideNextKey;
  readonly actions: readonly UpdateGuideAction[];
}

/**
 * Why an update step failed and what to do next, in plain words: the network (with or without
 * the mirrors tried), missing release files, a download that failed its integrity check, the
 * disk, or anything else. A failed install always leads to "restart FusionKit": its services were
 * already stopped. With a mirror link to the new installer, the download page is joined by it.
 */
export function updateErrorGuide(error: AppUpdateError, options: { readonly mirrorDownload?: boolean } = {}): UpdateGuide {
  const guide = baseGuide(error);
  if (!options.mirrorDownload || error.during === "check" || !guide.actions.includes("open_releases")) return guide;
  const actions = guide.actions.flatMap(action => action === "open_releases" ? ["open_releases", "open_mirror_download"] as const : [action]);
  return { ...guide, actions };
}

function baseGuide(error: AppUpdateError): UpdateGuide {
  const titleKey: UpdateGuideTitleKey = `common:update.error.${error.during}_title`;
  if (error.during === "install") {
    // Stopping the services failed: the installer never started, so a retry can still work.
    if (error.installStage === "prepare") {
      return {
        titleKey,
        causeKey: "common:update.error.install_prepare_cause",
        nextKey: "common:update.error.install_prepare_next",
        actions: ["restart_app", "retry", "open_releases"],
      };
    }
    return { titleKey, causeKey: "common:update.error.install_cause", nextKey: "common:update.error.install_next", actions: ["restart_app", "open_releases"] };
  }
  switch (error.kind) {
    case "network":
      return {
        titleKey,
        causeKey: error.mirrorsTried ? "common:update.error.network_cause" : "common:update.error.network_cause_official",
        nextKey: error.during === "check" ? "common:update.error.network_next_check" : "common:update.error.network_next_download",
        // A failed download can still be finished by hand: the download page, and the mirror link next to it.
        actions: error.during === "check" ? ["retry", "open_network_settings", "open_help"] : ["retry", "open_network_settings", "open_releases", "open_help"],
      };
    case "not_found":
      return { titleKey, causeKey: "common:update.error.not_found_cause", nextKey: "common:update.error.not_found_next", actions: ["open_releases", "retry"] };
    case "checksum":
      return { titleKey, causeKey: "common:update.error.checksum_cause", nextKey: "common:update.error.checksum_next", actions: ["retry", "open_network_settings", "open_releases", "open_help"] };
    case "disk":
      return { titleKey, causeKey: "common:update.error.disk_cause", nextKey: "common:update.error.disk_next", actions: ["retry", "open_releases"] };
    default:
      return { titleKey, causeKey: "common:update.error.unknown_cause", nextKey: "common:update.error.unknown_next", actions: ["retry", "open_releases"] };
  }
}

/**
 * The one command an unsigned FusionKit may need on macOS ("is damaged"): it removes the download
 * quarantine from the installed app. The same command as in the CHANGELOG note.
 */
export const MAC_QUARANTINE_COMMAND = "xattr -dr com.apple.quarantine /Applications/FusionKit.app";

/** Where a download comes from, for "source: …" (mirrors by their host name). */
const SOURCE_HOSTS: Record<string, string> = { ghfast: "ghfast.top", ghproxy: "ghproxy.net" };

export function updateSourceLabel(source: AppUpdateSourceId | undefined): {
  readonly key: "common:update.source_official" | "common:update.source_mirror";
  readonly host?: string;
} {
  if (!source || source === "official") return { key: "common:update.source_official" };
  return { key: "common:update.source_mirror", host: SOURCE_HOSTS[source] ?? source };
}

/** "297 MB", "18.7 MB", "1.02 GB". */
export function formatUpdateBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[index]}`;
}
