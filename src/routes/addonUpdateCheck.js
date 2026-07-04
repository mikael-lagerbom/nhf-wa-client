import {
  getCurrentAddonVersion,
  getCurrentNSRaidToolsVersion,
  getCurrentM33kAurasVersion,
  getCurrentLiquidRemindersVersion,
  compareVersions,
} from "./addonService";
import { fetchJsonWithRetry } from "./networkRetry.js";
import {
  fetchLatestAddon,
  fetchLatestLiquidReminders,
} from "./releasesApi.js";

/**
 * Same version rules as +page.js load(), without touching SvelteKit load / invalidate.
 * Used for periodic auto-update polling so the UI does not re-enter loading states.
 *
 * @param {string | undefined | null} apiKey
 * @returns {Promise<string[]>}
 */
export async function getPendingAutoUpdateIds(apiKey) {
  const updatesNeeded = [];

  try {
    const latestAddon = await fetchLatestAddon(apiKey);
    const semVersion = latestAddon.semVersion;
    const currentVersion = await getCurrentAddonVersion();
    const isInstalled = !!currentVersion;
    const isCurrent =
      !!currentVersion && compareVersions(semVersion, currentVersion) === 0;
    if (isInstalled && !isCurrent) {
      updatesNeeded.push("nhf-addon");
    }
  } catch {
    /* skip */
  }

  try {
    const gh = await fetchJsonWithRetry(
      "https://api.github.com/repos/Reloe/NorthernSkyRaidTools/releases/latest",
    );
    const remoteTag = gh.tag_name ?? "";
    const currentVersion = await getCurrentNSRaidToolsVersion();
    const isInstalled = !!currentVersion;
    const isCurrent =
      !!currentVersion && compareVersions(remoteTag, currentVersion) === 0;
    if (isInstalled && !isCurrent) {
      updatesNeeded.push("ns-raid-tools");
    }
  } catch {
    /* skip */
  }

  try {
    const gh = await fetchJsonWithRetry(
      "https://api.github.com/repos/m33shoq/M33kAuras/releases/latest",
    );
    const remoteTag = gh.tag_name ?? "";
    const currentVersion = await getCurrentM33kAurasVersion();
    const isInstalled = !!currentVersion;
    const isCurrent =
      !!currentVersion && compareVersions(remoteTag, currentVersion) === 0;
    if (isInstalled && !isCurrent) {
      updatesNeeded.push("m33k-auras");
    }
  } catch {
    /* skip */
  }

  try {
    const lr = await fetchLatestLiquidReminders(apiKey);
    const semVersion = lr.semVersion;
    const currentVersion = await getCurrentLiquidRemindersVersion();
    const isInstalled = !!currentVersion;
    const isCurrent =
      !!currentVersion && compareVersions(semVersion, currentVersion) === 0;
    if (isInstalled && !isCurrent) {
      updatesNeeded.push("liquid-reminders");
    }
  } catch {
    /* skip */
  }

  return updatesNeeded;
}
