<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { open } from "@tauri-apps/plugin-dialog";
  import { load } from "@tauri-apps/plugin-store";
  import { download } from "@tauri-apps/plugin-upload";
  import { PUBLIC_SERVER_HOST } from "$env/static/public";
  import { check as clientCheck } from "@tauri-apps/plugin-updater";
  import { relaunch } from "@tauri-apps/plugin-process";
  import { getZipInfo, validateAndExtractZip } from "./addonService";
  import { invoke } from "@tauri-apps/api/core";
  import { open as openShell } from "@tauri-apps/plugin-shell";
  import { listen } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { fetchJsonWithRetry } from "./networkRetry.js";
  import { getPendingAutoUpdateIds } from "./addonUpdateCheck.js";
  import {
    fetchAndWriteCompanionAddon,
    fetchCompanionSeasons,
    type CompanionSeason,
  } from "./companionService";
  import { Package, Link2, Download, LoaderCircle } from "@lucide/svelte";

  async function titleBarMinimize() {
    try {
      await getCurrentWindow().minimize();
    } catch {
      /* e.g. plain Vite dev without Tauri */
    }
  }

  async function titleBarClose() {
    try {
      await getCurrentWindow().close();
    } catch {
      /* e.g. plain Vite dev without Tauri */
    }
  }

  let wowFolder = $state("");
  let apiKey = $state("");
  let isInstalling = $state(false);
  let isNSInstalling = $state(false);
  let isM33Installing = $state(false);
  let isLRInstalling = $state(false);
  let isUpdateAvailable = $state(false);
  let isNSUpdateAvailable = $state(false);
  let isM33UpdateAvailable = $state(false);
  let isLRUpdateAvailable = $state(false);

  let store: any = null;
  let notification = $state({ show: false, message: "", type: "error" });

  // Backup functionality
  let backupEnabled = $state(false);
  let backupOnStartup = $state(false);
  let backupAllData = $state(false);
  let isBackingUp = $state(false);
  let lastBackupTime = $state("");
  let lastAppStartTime = $state("");

  // Minimize to tray functionality
  let minimizeToTray = $state(false);

  // Auto-update functionality
  let autoUpdate = $state(false);
  let isAutoUpdating = $state(false);
  let updateQueue = $state<string[]>([]);
  let currentUpdating = $state("");

  // Startup functionality
  let startOnStartup = $state(false);

  type ActiveView = "manager" | "companion";
  let activeView = $state<ActiveView>("manager");
  let externalApiKey = $state("");
  let companionSeasonId = $state("");
  let companionSeasons = $state<CompanionSeason[]>([]);
  let companionCurrentSeasonId = $state("");
  let isSeasonsLoading = $state(false);
  let seasonsLoadError = $state("");
  let companionLastFetch = $state("");
  let companionSavedData = $state("");
  let isCompanionFetching = $state(false);
  let companionFetchOnStartup = $state(false);

  type InstallDockPhase = "download" | "extract" | "backup";

  let installDock = $state({
    open: false,
    name: "",
    phase: "download" as InstallDockPhase,
    percent: 0,
    detail: "",
  });

  function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n < 0) return "";
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function installDockFromProgress(p: Record<string, unknown>) {
    const cur = Number(p.progress) || 0;
    const total = Number(p.progressTotal) || 0;
    const speed = Number(p.transferSpeed) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((cur / total) * 100)) : 0;
    let detail = "";
    if (total > 0) {
      detail = `${formatBytes(cur)} / ${formatBytes(total)}`;
      if (speed > 0) detail += ` · ${formatBytes(speed)}/s`;
    } else if (speed > 0) {
      detail = `${formatBytes(speed)}/s`;
    } else {
      detail = "Downloading…";
    }
    installDock = {
      ...installDock,
      open: true,
      phase: "download",
      percent: pct,
      detail,
    };
  }

  function openInstallDock(name: string, initialDetail = "Preparing…") {
    installDock = {
      open: true,
      name,
      phase: "download",
      percent: 0,
      detail: initialDetail,
    };
  }

  function installDockExtracting() {
    installDock = {
      ...installDock,
      open: true,
      phase: "extract",
      percent: 100,
      detail: "Unpacking into your WoW AddOns folder…",
    };
  }

  function closeInstallDock() {
    installDock = {
      open: false,
      name: "",
      phase: "download",
      percent: 0,
      detail: "",
    };
  }

  function installDockFromBackup(progress: number, status: string) {
    const pct = Math.min(100, Math.max(0, Number(progress) || 0));
    installDock = {
      open: true,
      name: "WeakAuras backup",
      phase: "backup",
      percent: pct,
      detail: status.trim() ? status : "Backing up…",
    };
  }

  function showNotification(
    message: string,
    type: "error" | "success" = "error",
  ) {
    notification = { show: true, message, type };
    setTimeout(() => {
      notification.show = false;
    }, 5000);
  }

  async function downloadWithRetry(
    url: string,
    path: string,
    onProgress: (progress: any) => void,
    headers: Map<string, string> | undefined,
    maxAttempts = 4,
  ): Promise<void> {
    let last: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await download(url, path, onProgress, headers);
        return;
      } catch (e) {
        last = e;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 600 * attempt * attempt));
        }
      }
    }
    throw last;
  }

  // Button text state variables
  let addonButtonText = $state("Re-Install");
  let nsButtonText = $state("Re-Install");
  let m33ButtonText = $state("Re-Install");
  let lrButtonText = $state("Re-Install");

  function getAddonButtonText() {
    return !wowFolder
      ? "Set Folder"
      : !apiKey
        ? "Set API Key"
        : isInstalling
          ? "Downloading..."
          : addonButtonText;
  }

  function getNSButtonText() {
    return !wowFolder
      ? "Set Folder"
      : !apiKey
        ? "Set API Key"
        : isNSInstalling
          ? "Downloading..."
          : nsButtonText;
  }

  function getM33ButtonText() {
    return !wowFolder
      ? "Set Folder"
      : !apiKey
        ? "Set API Key"
        : isM33Installing
          ? "Downloading..."
          : m33ButtonText;
  }

  function getLRButtonText() {
    return !wowFolder
      ? "Set Folder"
      : !apiKey
        ? "Set API Key"
        : isLRInstalling
          ? "Downloading..."
          : lrButtonText;
  }

  let { data } = $props();

  const check = async () => {
    const addon = await data.addon;
    const nsRaidTools = await data.nsRaidTools;
    const m33kAuras = await data.m33kAuras;
    const liquidReminders = await data.liquidReminders;

    // Set update availability flags
    isUpdateAvailable = !addon.isCurrent;
    isNSUpdateAvailable = !nsRaidTools.isCurrent;
    isM33UpdateAvailable = !m33kAuras.isCurrent;
    isLRUpdateAvailable = !liquidReminders.isCurrent;

    // Set button text based on installation and update status
    if (!addon.isInstalled) {
      addonButtonText = "Install";
    } else if (!addon.isCurrent) {
      addonButtonText = "Update";
    } else {
      addonButtonText = "Re-Install";
    }

    if (!nsRaidTools.isInstalled) {
      nsButtonText = "Install";
    } else if (!nsRaidTools.isCurrent) {
      nsButtonText = "Update";
    } else {
      nsButtonText = "Re-Install";
    }

    if (!m33kAuras.isInstalled) {
      m33ButtonText = "Install";
    } else if (!m33kAuras.isCurrent) {
      m33ButtonText = "Update";
    } else {
      m33ButtonText = "Re-Install";
    }

    if (!liquidReminders.isInstalled) {
      lrButtonText = "Install";
    } else if (!liquidReminders.isCurrent) {
      lrButtonText = "Update";
    } else {
      lrButtonText = "Re-Install";
    }
  };
  check();

  async function refreshPageData() {
    closeInstallDock();
    try {
      await invalidateAll();
      await check();
    } catch (e) {
      console.error("refreshPageData:", e);
    }
  }

  const setupStore = async () => {
    store = await load("store.json");
    if (store) {
      const storedFolder = await store.get("wow_folder");
      const storedApiKey = await store.get("api_key");
      const storedBackupEnabled = await store.get("backup_enabled");
      const storedBackupOnStartup = await store.get("backup_on_startup");
      const storedBackupAllData = await store.get("backup_all_data");
      const storedLastBackupTime = await store.get("last_backup_time");
      const storedLastAppStartTime = await store.get("last_app_start_time");
      const storedMinimizeToTray = await store.get("minimize_to_tray");
      const storedAutoUpdate = await store.get("auto_update");
      const storedStartOnStartup = await store.get("start_on_startup");

      if (storedFolder && typeof storedFolder === "string") {
        if (isRetailWowPath(storedFolder)) {
          wowFolder = normalizeWowFolderPath(storedFolder);
        } else {
          wowFolder = "";
          await store.set("wow_folder", "");
        }
      }
      if (storedApiKey) {
        apiKey = storedApiKey;
      }
      if (storedBackupEnabled !== undefined) {
        backupEnabled = storedBackupEnabled;
      }
      if (storedBackupOnStartup !== undefined) {
        backupOnStartup = storedBackupOnStartup;
      }
      if (storedBackupAllData !== undefined) {
        backupAllData = storedBackupAllData;
      }
      if (storedLastBackupTime) {
        lastBackupTime = storedLastBackupTime;
      }
      if (storedLastAppStartTime) {
        lastAppStartTime = storedLastAppStartTime;
      }
      if (storedMinimizeToTray !== undefined) {
        minimizeToTray = storedMinimizeToTray;
        // Sync the backend state
        try {
          await invoke("set_minimize_to_tray", { enabled: minimizeToTray });
        } catch (error) {
          console.error("Failed to sync minimize to tray setting:", error);
        }
      }
      if (storedAutoUpdate !== undefined) {
        autoUpdate = storedAutoUpdate;
      }
      if (storedStartOnStartup !== undefined) {
        startOnStartup = storedStartOnStartup;
        // Sync the backend state
        try {
          await invoke("set_start_on_startup", { enabled: startOnStartup });
        } catch (error) {
          console.error("Failed to sync start on startup setting:", error);
        }
      }

      const storedExternalApiKey = await store.get("external_api_key");
      const storedCompanionLastFetch = await store.get("companion_last_fetch");
      const storedCompanionSeasonId = await store.get("companion_season_id");
      const storedCompanionFetchOnStartup = await store.get(
        "companion_fetch_on_startup",
      );

      if (storedExternalApiKey && typeof storedExternalApiKey === "string") {
        externalApiKey = storedExternalApiKey;
      }
      if (
        storedCompanionLastFetch &&
        typeof storedCompanionLastFetch === "string"
      ) {
        companionLastFetch = storedCompanionLastFetch;
      }
      if (
        storedCompanionSeasonId &&
        typeof storedCompanionSeasonId === "string"
      ) {
        companionSeasonId = storedCompanionSeasonId;
      }
      if (storedCompanionFetchOnStartup !== undefined) {
        companionFetchOnStartup = storedCompanionFetchOnStartup;
      }
    }
  };
  setupStore();

  // Set up backup progress event listener
  let unlistenBackupProgress: (() => void) | null = null;

  const setupBackupProgressListener = async () => {
    unlistenBackupProgress = await listen("backup-progress", (event: any) => {
      const progressData = event.payload;
      installDockFromBackup(
        Number(progressData.progress) || 0,
        String(progressData.status ?? ""),
      );
    });
  };

  setupBackupProgressListener();

  // Run backup on startup if enabled (only when app is actually opened, not on reloads)
  const runStartupBackup = async () => {
    if (backupEnabled && backupOnStartup && wowFolder) {
      const currentTime = new Date().toISOString();
      const timeDiff = lastAppStartTime
        ? new Date(currentTime).getTime() - new Date(lastAppStartTime).getTime()
        : Infinity;

      // Only run backup if it's been more than 6 hours since last app start
      // This prevents backup from running on page reloads but allows it on actual app opens
      if (timeDiff > 6 * 60 * 60 * 1000) {
        if (store) {
          await store.set("last_app_start_time", currentTime);
        }
        lastAppStartTime = currentTime;
        await backupWeakAuras();
      }
    }
  };

  // Run startup backup after a short delay to ensure everything is loaded
  setTimeout(runStartupBackup, 1000);

  // Run auto-update check on startup after a short delay to ensure all addons are loaded
  setTimeout(async () => {
    if (autoUpdate) {
      await autoUpdateCheck();
    }
  }, 2000); // Reduced delay to 2 seconds for faster startup

  const runStartupCompanionFetch = async () => {
    if (!companionFetchOnStartup) return;
    if (!wowFolder || !isRetailWowPath(wowFolder)) return;
    if (!externalApiKey.trim()) return;
    if (isCompanionFetching) return;

    await loadCompanionSeasons();
    await fetchCompanionData();
  };

  setTimeout(runStartupCompanionFetch, 2000);

  // Set up auto-update interval (much shorter for faster updates)
  let autoUpdateInterval: number | null = null;

  const startAutoUpdateInterval = () => {
    if (autoUpdateInterval) {
      clearInterval(autoUpdateInterval);
    }

    if (autoUpdate) {
      // Run immediately when enabled, then every 2 minutes
      autoUpdateCheck();

      autoUpdateInterval = setInterval(
        async () => {
          await autoUpdateCheck();
        },
        2 * 60 * 1000, // 2 minutes instead of 15 minutes
      );
    }
  };

  // Start the interval when auto-update is enabled
  $effect(() => {
    if (autoUpdate) {
      startAutoUpdateInterval();
    } else {
      if (autoUpdateInterval) {
        clearInterval(autoUpdateInterval);
        autoUpdateInterval = null;
      }
    }
  });

  // Cleanup event listener on component destroy
  $effect(() => {
    return () => {
      if (unlistenBackupProgress) {
        unlistenBackupProgress();
      }
      if (autoUpdateInterval) {
        clearInterval(autoUpdateInterval);
      }
    };
  });

  function normalizeWowFolderPath(path: string): string {
    return path.trim().replace(/[/\\]+$/, "");
  }

  /** Retail install folder name must be the path suffix (case-insensitive). */
  function isRetailWowPath(path: string): boolean {
    const n = normalizeWowFolderPath(path);
    return n.length > 0 && n.toLowerCase().endsWith("_retail_");
  }

  /** Saves WoW folder when valid; on failure shows a toast and restores the last stored path. */
  async function persistWowFolder(path: string): Promise<boolean> {
    if (!store) return false;
    const n = normalizeWowFolderPath(path);
    if (!n) {
      await store.set("wow_folder", "");
      wowFolder = "";
      await refreshPageData();
      return true;
    }
    if (!isRetailWowPath(n)) {
      showNotification(
        "WoW folder must end with _retail_ (your retail game directory).",
        "error",
      );
      const prev = await store.get("wow_folder");
      wowFolder = typeof prev === "string" ? prev : "";
      return false;
    }
    await store.set("wow_folder", n);
    wowFolder = n;
    await refreshPageData();
    return true;
  }

  const openFolder = async () => {
    if (!store) return;
    const folder = await open({
      directory: true,
      multiple: false,
    });
    if (typeof folder === "string") await persistWowFolder(folder);
  };

  async function onWowFolderBlur() {
    await persistWowFolder(wowFolder);
  }

  const resetInstallBtnText = (failed = false) => {
    setTimeout(() => {
      isInstalling = false;
      isUpdateAvailable = failed;
    }, 4000);
  };

  const resetNSInstallBtnText = (failed = false) => {
    setTimeout(() => {
      isNSInstalling = false;
      isNSUpdateAvailable = failed;
    }, 4000);
  };

  const resetM33InstallBtnText = (failed = false) => {
    setTimeout(() => {
      isM33Installing = false;
      isM33UpdateAvailable = failed;
    }, 4000);
  };

  const resetLRInstallBtnText = (failed = false) => {
    setTimeout(() => {
      isLRInstalling = false;
      isLRUpdateAvailable = failed;
    }, 4000);
  };

  // --- Addon ZIP update logic ---
  const update = async () => {
    if (!wowFolder || !apiKey || isInstalling) return;
    try {
      isInstalling = true;
      openInstallDock("NHF Addon");
      await downloadWithRetry(
        PUBLIC_SERVER_HOST + "/assets/addon.zip",
        "./addon.zip",
        (progress) => {
          installDockFromProgress(progress as Record<string, unknown>);
          console.log(
            progress.progress,
            progress.progressTotal,
            progress.transferSpeed,
            progress,
          );
        },
        new Map([["Authorization", apiKey]]),
      );
      installDockExtracting();
      await extractAddonZip();
    } catch (error) {
      closeInstallDock();
      isInstalling = false;
      resetInstallBtnText(true);
      showNotification(
        "Failed to download NHF Addon. Please check your connection and try again.",
      );
    }
  };

  async function extractAddonZip() {
    try {
      await validateAndExtractZip(
        "./addon.zip",
        wowFolder + "/Interface/Addons",
      );
      await refreshPageData();
      isInstalling = false;
    } catch (error: any) {
      closeInstallDock();
      resetInstallBtnText(true);
      showNotification(
        "Failed to extract NHF Addon. Please check your WoW folder path and try again.",
      );
      console.error(error);
    }
  }

  // --- NS Raid Tools ZIP update logic ---
  const updateNSRaidTools = async () => {
    if (!wowFolder || !apiKey || isNSInstalling) return;
    try {
      isNSInstalling = true;
      openInstallDock("NS Raid Tools", "Fetching latest release…");
      const nsData = await fetchJsonWithRetry(
        "https://api.github.com/repos/Reloe/NorthernSkyRaidTools/releases/latest",
      );
      const asset = nsData.assets?.find(
        (a: { content_type: string }) => a.content_type === "application/zip",
      );
      const downloadUrl = asset?.browser_download_url;
      if (!downloadUrl) {
        throw new Error("No NS Raid Tools zip in latest release");
      }
      installDock = { ...installDock, detail: "Downloading…" };
      await downloadWithRetry(
        downloadUrl,
        "./nsRaidTools.zip",
        (progress) => {
          installDockFromProgress(progress as Record<string, unknown>);
          console.log(
            progress.progress,
            progress.progressTotal,
            progress.transferSpeed,
            progress,
          );
        },
        undefined,
      );
      installDockExtracting();
      await extractNSRaidToolsZip();
    } catch (error) {
      closeInstallDock();
      isNSInstalling = false;
      resetNSInstallBtnText(true);
      showNotification(
        "Failed to download NS Raid Tools. Please check your connection and try again.",
      );
    }
  };

  async function extractNSRaidToolsZip() {
    try {
      await validateAndExtractZip(
        "./nsRaidTools.zip",
        wowFolder + "/Interface/Addons",
      );
      await refreshPageData();
      isNSInstalling = false;
    } catch (error: any) {
      closeInstallDock();
      resetNSInstallBtnText(true);
      showNotification(
        "Failed to extract NS Raid Tools. Please check your WoW folder path and try again.",
      );
      console.error(error);
    }
  }

  // --- M33kAuras ZIP update logic ---
  const updateM33kAuras = async () => {
    if (!wowFolder || !apiKey || isM33Installing) return;
    try {
      isM33Installing = true;
      openInstallDock("M33kAuras", "Fetching latest release…");
      const m33Data = await fetchJsonWithRetry(
        "https://api.github.com/repos/m33shoq/M33kAuras/releases/latest",
      );
      const asset = m33Data.assets?.find(
        (a: { content_type: string }) => a.content_type === "application/zip",
      );
      const downloadUrl = asset?.browser_download_url;
      if (!downloadUrl) {
        throw new Error("No M33kAuras zip in latest release");
      }
      installDock = { ...installDock, detail: "Downloading…" };
      await downloadWithRetry(
        downloadUrl,
        "./m33kAuras.zip",
        (progress) => {
          installDockFromProgress(progress as Record<string, unknown>);
          console.log(
            progress.progress,
            progress.progressTotal,
            progress.transferSpeed,
            progress,
          );
        },
        undefined,
      );
      installDockExtracting();
      await extractM33kAurasZip();
    } catch (error) {
      closeInstallDock();
      isM33Installing = false;
      resetM33InstallBtnText(true);
      showNotification(
        "Failed to download M33kAuras. Please check your connection and try again.",
      );
    }
  };

  async function extractM33kAurasZip() {
    try {
      await validateAndExtractZip(
        "./m33kAuras.zip",
        wowFolder + "/Interface/AddOns",
      );
      await refreshPageData();
      isM33Installing = false;
    } catch (error: any) {
      closeInstallDock();
      resetM33InstallBtnText(true);
      showNotification(
        "Failed to extract M33kAuras. Please check your WoW folder path and try again.",
      );
      console.error(error);
    }
  }

  // --- Liquid Reminders ZIP update logic ---
  const updateLiquidReminders = async () => {
    if (!wowFolder || !apiKey || isLRInstalling) return;
    try {
      isLRInstalling = true;
      openInstallDock("Liquid Reminders");

      await downloadWithRetry(
        PUBLIC_SERVER_HOST + "/assets/liquidReminders.zip",
        "./liquidReminders.zip",
        (progress) => {
          installDockFromProgress(progress as Record<string, unknown>);
          console.log(
            progress.progress,
            progress.progressTotal,
            progress.transferSpeed,
            progress,
          );
        },
        new Map([["Authorization", apiKey]]),
      );

      console.log("Liquid Reminders download complete, starting extraction...");
      installDockExtracting();

      // Extract immediately after download completes
      await validateAndExtractZip(
        "./liquidReminders.zip",
        wowFolder + "/Interface/Addons",
      );

      console.log("Liquid Reminders extraction complete");
      await refreshPageData();
      isLRInstalling = false;
    } catch (error) {
      console.error("Failed to update Liquid Reminders:", error);
      closeInstallDock();
      isLRInstalling = false;
      resetLRInstallBtnText(true);
      showNotification(
        "Failed to download Liquid Reminders. Please check your connection and try again.",
      );
    }
  };

  const updateKey = async () => {
    if (!store) return;
    await store.set("api_key", apiKey);
    await refreshPageData();
  };

  const updateExternalApiKey = async () => {
    if (!store) return;
    await store.set("external_api_key", externalApiKey);
    await loadCompanionSeasons();
  };

  const updateCompanionSeasonId = async () => {
    if (!store) return;
    await store.set("companion_season_id", companionSeasonId);
  };

  const updateCompanionFetchOnStartup = async () => {
    if (!store) return;
    await store.set("companion_fetch_on_startup", companionFetchOnStartup);
  };

  async function loadCompanionSeasons() {
    const trimmedKey = externalApiKey.trim();
    if (!trimmedKey) {
      companionSeasons = [];
      companionCurrentSeasonId = "";
      seasonsLoadError = "";
      return;
    }

    isSeasonsLoading = true;
    seasonsLoadError = "";
    try {
      const seasonsResponse = await fetchCompanionSeasons(trimmedKey);
      companionSeasons = seasonsResponse.seasons ?? [];
      companionCurrentSeasonId = seasonsResponse.currentSeasonId;

      const seasonIds = new Set(companionSeasons.map((season) => season.id));
      if (!companionSeasonId || !seasonIds.has(companionSeasonId)) {
        companionSeasonId = seasonsResponse.currentSeasonId;
        if (store) {
          await store.set("companion_season_id", companionSeasonId);
        }
      }
    } catch (e) {
      companionSeasons = [];
      companionCurrentSeasonId = "";
      seasonsLoadError =
        e instanceof Error ? e.message : "Failed to load seasons.";
    } finally {
      isSeasonsLoading = false;
    }
  }

  function openCompanionView() {
    activeView = "companion";
    void loadCompanionSeasons();
  }

  const canFetchCompanion = $derived(
    !!wowFolder &&
      isRetailWowPath(wowFolder) &&
      !!externalApiKey.trim() &&
      !isCompanionFetching,
  );

  async function copyCompanionSavedData() {
    if (!companionSavedData) return;

    try {
      await navigator.clipboard.writeText(companionSavedData);
      showNotification("Companion data copied to clipboard.", "success");
    } catch {
      showNotification("Failed to copy to clipboard.", "error");
    }
  }

  async function fetchCompanionData() {
    if (!canFetchCompanion) return;

    isCompanionFetching = true;
    try {
      const result = await fetchAndWriteCompanionAddon(
        wowFolder,
        externalApiKey,
        companionSeasonId || undefined,
      );

      companionLastFetch = result.fetchedAt;
      companionSavedData = result.dataLua;
      if (store) {
        await store.set("companion_last_fetch", result.fetchedAt);
      }

      showNotification(
        `Companion data written (${result.bossCount} bosses, ${result.raidPlanCount} raid plans, ${result.imageCount} images, season ${result.seasonId}). /reload in WoW to load.`,
        "success",
      );
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Failed to fetch companion data.";
      showNotification(message, "error");
    } finally {
      isCompanionFetching = false;
    }
  }

  const updateClient = async () => {
    if (!apiKey) {
      showNotification("Set your API key before updating the client.", "error");
      return;
    }
    const timeoutMs = 120_000;
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const update = await clientCheck({
          headers: { Authorization: apiKey },
          timeout: timeoutMs,
        });
        if (update) {
          await update.downloadAndInstall(undefined, { timeout: timeoutMs });
          console.log("update installed");
          await relaunch();
        }
        return;
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? error.message
            : String(error ?? "Unknown error");
        if (attempt === maxAttempts) {
          console.error(error);
          showNotification(
            msg.length > 160
              ? `${msg.slice(0, 160)}…`
              : msg ||
                  "Client update failed. Check your connection and try again.",
            "error",
          );
          return;
        }
        await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
      }
    }
  };

  // Backup functionality
  const updateBackupSettings = async () => {
    if (!store) return;
    await store.set("backup_enabled", backupEnabled);
    await store.set("backup_on_startup", backupOnStartup);
    await store.set("backup_all_data", backupAllData);
  };

  // Minimize to tray functionality
  const updateMinimizeToTray = async () => {
    if (!store) return;
    await store.set("minimize_to_tray", minimizeToTray);
    // Notify the backend about the setting change
    try {
      await invoke("set_minimize_to_tray", { enabled: minimizeToTray });
    } catch (error) {
      console.error("Failed to update minimize to tray setting:", error);
    }
  };

  // Show window function (can be called from external sources)
  const showWindow = async () => {
    try {
      await invoke("show_window");
    } catch (error) {
      console.error("Failed to show window:", error);
    }
  };

  // Auto-update functionality
  const updateAutoUpdateSetting = async () => {
    if (!store) return;
    await store.set("auto_update", autoUpdate);
  };

  // Startup functionality
  const updateStartOnStartupSetting = async () => {
    if (!store) return;
    await store.set("start_on_startup", startOnStartup);
    // Notify the backend about the setting change
    try {
      await invoke("set_start_on_startup", { enabled: startOnStartup });
    } catch (error) {
      console.error("Failed to update start on startup setting:", error);
    }
  };

  // Dedicated auto-update functions that don't interfere with manual updates
  const autoUpdateNHFAddon = async () => {
    try {
      console.log("Auto-updating NHF Addon...");
      isInstalling = true; // Set button state
      openInstallDock("NHF Addon (auto-update)");

      console.log("Starting download of NHF Addon...");
      await downloadWithRetry(
        PUBLIC_SERVER_HOST + "/assets/addon.zip",
        "./addon.zip",
        (progress) => {
          installDockFromProgress(progress as Record<string, unknown>);
          console.log("NHF Addon download progress:", progress);
        },
        new Map([["Authorization", apiKey]]),
      );
      console.log("NHF Addon download complete, starting extraction...");
      installDockExtracting();

      // Extract immediately without timer
      await validateAndExtractZip(
        "./addon.zip",
        wowFolder + "/Interface/Addons",
      );
      console.log("NHF Addon extraction complete");

      console.log("NHF Addon auto-update complete");
      isInstalling = false; // Reset button state on success
    } catch (error) {
      console.error("Failed to auto-update NHF Addon:", error);
      closeInstallDock();
      isInstalling = false; // Reset button state on error
      throw error;
    }
  };

  const autoUpdateNSRaidTools = async () => {
    try {
      console.log("Auto-updating NS Raid Tools...");
      isNSInstalling = true; // Set button state
      openInstallDock(
        "NS Raid Tools (auto-update)",
        "Fetching latest release…",
      );

      console.log("Fetching NS Raid Tools release info...");
      const nsData = await fetchJsonWithRetry(
        "https://api.github.com/repos/Reloe/NorthernSkyRaidTools/releases/latest",
      );
      const asset = nsData.assets?.find(
        (a: { content_type: string }) => a.content_type === "application/zip",
      );
      const downloadUrl = asset?.browser_download_url;
      if (!downloadUrl) {
        throw new Error("No NS Raid Tools zip in latest release");
      }
      console.log("Starting download of NS Raid Tools...");
      installDock = { ...installDock, detail: "Downloading…" };

      await downloadWithRetry(
        downloadUrl,
        "./nsRaidTools.zip",
        (progress) => {
          installDockFromProgress(progress as Record<string, unknown>);
          console.log("NS Raid Tools download progress:", progress);
        },
        undefined,
      );

      console.log("NS Raid Tools download complete, starting extraction...");
      installDockExtracting();
      // Extract immediately without timer
      await validateAndExtractZip(
        "./nsRaidTools.zip",
        wowFolder + "/Interface/Addons",
      );
      console.log("NS Raid Tools extraction complete");

      console.log("NS Raid Tools auto-update complete");
      isNSInstalling = false; // Reset button state on success
    } catch (error) {
      console.error("Failed to auto-update NS Raid Tools:", error);
      closeInstallDock();
      isNSInstalling = false; // Reset button state on error
      throw error;
    }
  };

  const autoUpdateM33kAuras = async () => {
    try {
      console.log("Auto-updating M33kAuras...");
      isM33Installing = true;
      openInstallDock("M33kAuras (auto-update)", "Fetching latest release…");

      console.log("Fetching M33kAuras release info...");
      const m33Data = await fetchJsonWithRetry(
        "https://api.github.com/repos/m33shoq/M33kAuras/releases/latest",
      );
      const asset = m33Data.assets?.find(
        (a: { content_type: string }) => a.content_type === "application/zip",
      );
      const downloadUrl = asset?.browser_download_url;
      if (!downloadUrl) {
        throw new Error("No M33kAuras zip in latest release");
      }
      console.log("Starting download of M33kAuras...");
      installDock = { ...installDock, detail: "Downloading…" };

      await downloadWithRetry(
        downloadUrl,
        "./m33kAuras.zip",
        (progress) => {
          installDockFromProgress(progress as Record<string, unknown>);
          console.log("M33kAuras download progress:", progress);
        },
        undefined,
      );

      console.log("M33kAuras download complete, starting extraction...");
      installDockExtracting();
      await validateAndExtractZip(
        "./m33kAuras.zip",
        wowFolder + "/Interface/AddOns",
      );
      console.log("M33kAuras extraction complete");

      console.log("M33kAuras auto-update complete");
      isM33Installing = false;
    } catch (error) {
      console.error("Failed to auto-update M33kAuras:", error);
      closeInstallDock();
      isM33Installing = false;
      throw error;
    }
  };

  const autoUpdateLiquidReminders = async () => {
    try {
      console.log("Auto-updating Liquid Reminders...");
      isLRInstalling = true; // Set button state
      openInstallDock("Liquid Reminders (auto-update)");

      console.log("Starting download of Liquid Reminders...");
      await downloadWithRetry(
        PUBLIC_SERVER_HOST + "/assets/liquidReminders.zip",
        "./liquidReminders.zip",
        (progress) => {
          installDockFromProgress(progress as Record<string, unknown>);
          console.log("Liquid Reminders download progress:", progress);
        },
        new Map([["Authorization", apiKey]]),
      );
      console.log("Liquid Reminders download complete, starting extraction...");
      installDockExtracting();

      // Extract immediately without timer
      await validateAndExtractZip(
        "./liquidReminders.zip",
        wowFolder + "/Interface/Addons",
      );
      console.log("Liquid Reminders extraction complete");

      console.log("Liquid Reminders auto-update complete");
      isLRInstalling = false; // Reset button state on success
    } catch (error) {
      console.error("Failed to auto-update Liquid Reminders:", error);
      closeInstallDock();
      isLRInstalling = false; // Reset button state on error
      throw error;
    }
  };

  const checkForUpdates = async () => {
    console.log(
      "checkForUpdates called, wowFolder:",
      wowFolder,
      "apiKey:",
      apiKey,
    );
    if (!wowFolder || !apiKey) {
      console.log("Missing wowFolder or apiKey, cannot check for updates");
      return false;
    }

    try {
      const updatesNeeded = await getPendingAutoUpdateIds(apiKey);
      console.log("Updates needed:", updatesNeeded);
      if (updatesNeeded.length > 0) {
        updateQueue = updatesNeeded;
        return true;
      }
      return false;
    } catch (error) {
      console.error("Failed to check for updates:", error);
      return false;
    }
  };

  const processUpdateQueue = async () => {
    console.log(
      "processUpdateQueue called, isAutoUpdating:",
      isAutoUpdating,
      "updateQueue:",
      updateQueue,
    );
    if (isAutoUpdating || updateQueue.length === 0) {
      console.log(
        "Cannot process queue - isAutoUpdating:",
        isAutoUpdating,
        "queue length:",
        updateQueue.length,
      );
      return;
    }

    console.log("Starting to process update queue:", updateQueue);
    isAutoUpdating = true;

    for (const addonName of updateQueue) {
      try {
        console.log(`Processing addon: ${addonName}`);
        currentUpdating = addonName;
        showNotification(`Auto-updating ${addonName}...`, "success");

        switch (addonName) {
          case "nhf-addon":
            console.log("Calling autoUpdateNHFAddon...");
            await autoUpdateNHFAddon();
            break;
          case "ns-raid-tools":
            console.log("Calling autoUpdateNSRaidTools...");
            await autoUpdateNSRaidTools();
            break;
          case "m33k-auras":
            console.log("Calling autoUpdateM33kAuras...");
            await autoUpdateM33kAuras();
            break;
          case "liquid-reminders":
            console.log("Calling autoUpdateLiquidReminders...");
            await autoUpdateLiquidReminders();
            break;
        }

        console.log(`Completed auto-update for ${addonName}`);
        // Wait a bit between updates
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`Failed to auto-update ${addonName}:`, error);
        showNotification(`Failed to auto-update ${addonName}`, "error");
      }
    }

    console.log("All updates complete, clearing queue");
    updateQueue = [];
    currentUpdating = "";
    isAutoUpdating = false;

    await refreshPageData();
    showNotification("Auto-updates complete.", "success");
  };

  const autoUpdateCheck = async () => {
    console.log("autoUpdateCheck called, autoUpdate enabled:", autoUpdate);
    if (!autoUpdate) {
      console.log("Auto-update is disabled, skipping check");
      return;
    }

    console.log("Checking for updates...");
    const hasUpdates = await checkForUpdates();
    console.log("Has updates:", hasUpdates);
    if (hasUpdates) {
      console.log("Updates found, processing queue...");
      await processUpdateQueue();
    } else {
      console.log("No updates needed");
    }
  };

  const manualRefresh = async () => {
    await refreshPageData();
  };

  const openBackupFolder = async () => {
    if (!wowFolder) {
      showNotification("Please set your WoW folder first", "error");
      return;
    }

    try {
      const backupPath = `${wowFolder}/NHF-Backup`;
      await openShell(backupPath);
    } catch (error: any) {
      showNotification(`Failed to open backup folder: ${error}`, "error");
    }
  };

  const backupWeakAuras = async () => {
    if (!wowFolder || isBackingUp) return;

    try {
      isBackingUp = true;
      installDock = {
        open: true,
        name: "WeakAuras backup",
        phase: "backup",
        percent: 0,
        detail: "Starting backup…",
      };

      const result = (await invoke("backup_weakauras", {
        wowFolder,
        backupAllData,
      })) as any;

      if (result.error) {
        showNotification(result.error, "error");
        installDock = {
          ...installDock,
          open: true,
          phase: "backup",
          detail: result.error,
        };
      } else {
        installDockFromBackup(
          Number(result.progress) || installDock.percent,
          String(result.status ?? ""),
        );
        if (result.completed) {
          const now = new Date();
          lastBackupTime = now.toLocaleString();
          if (store) {
            await store.set("last_backup_time", lastBackupTime);
          }
          showNotification("Backup completed successfully!", "success");
          installDock = {
            ...installDock,
            open: true,
            phase: "backup",
            percent: 100,
            detail: String(result.status ?? "Backup complete"),
          };
        }
      }
    } catch (error: any) {
      console.error("Backup error:", error);
      showNotification(`Backup failed: ${error}`, "error");
      installDock = {
        ...installDock,
        open: true,
        phase: "backup",
        detail: "Backup failed",
      };
    } finally {
      isBackingUp = false;
      setTimeout(() => {
        if (installDock.phase === "backup") {
          closeInstallDock();
        }
      }, 2800);
    }
  };
</script>

<main>
  {#snippet rowAwaitSpinner()}
    <svg
      class="row-status-spinner"
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden="true"
      ><path
        fill="currentColor"
        d="M12,4a8,8,0,0,1,7.89,6.7A1.53,1.53,0,0,0,21.38,12h0a1.5,1.5,0,0,0,1.48-1.75,11,11,0,0,0-21.72,0A1.5,1.5,0,0,0,2.62,12h0a1.53,1.53,0,0,0,1.49-1.3A8,8,0,0,1,12,4Z"
        ><animateTransform
          attributeName="transform"
          dur="0.75s"
          repeatCount="indefinite"
          type="rotate"
          values="0 12 12;360 12 12"
        /></path
      ></svg
    >
  {/snippet}

  {#if notification.show}
    <div
      class="notification"
      class:error={notification.type === "error"}
      class:success={notification.type === "success"}
    >
      <span class="notification-message">{notification.message}</span>
      <button
        class="notification-close"
        onclick={() => (notification.show = false)}>×</button
      >
    </div>
  {/if}

  <div class="title-bar">
    <div class="title-bar-drag" data-tauri-drag-region>
      <img
        src="/icon.png"
        alt=""
        class="title-bar-icon"
        width="18"
        height="18"
      />
      <span class="title-bar-text">NHF Addon Manager</span>
    </div>
    <div class="title-bar-controls">
      <button
        type="button"
        class="title-bar-btn"
        aria-label="Minimize"
        onclick={titleBarMinimize}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"
          ><path fill="currentColor" d="M0 5h10v1H0z" /></svg
        >
      </button>
      <button
        type="button"
        class="title-bar-btn title-bar-btn-close"
        aria-label="Close"
        onclick={titleBarClose}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"
          ><path
            d="M1 1 9 9M9 1 1 9"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
          /></svg
        >
      </button>
    </div>
  </div>

  <nav class="view-nav" aria-label="Main views">
    <button
      type="button"
      class="view-nav-btn"
      class:view-nav-btn-active={activeView === "manager"}
      onclick={() => (activeView = "manager")}
    >
      <Package size={14} strokeWidth={2.25} aria-hidden="true" />
      <span>Addons</span>
    </button>
    <button
      type="button"
      class="view-nav-btn"
      class:view-nav-btn-active={activeView === "companion"}
      onclick={openCompanionView}
    >
      <Link2 size={14} strokeWidth={2.25} aria-hidden="true" />
      <span>Companion</span>
    </button>
  </nav>

  {#if activeView === "manager"}
    <div class="main-content">
      <div class="left-panel">
        <section class="panel-section">
          <h2 class="panel-section-title">Setup</h2>
          <div class="input">
            <label for="wow_folder">WoW folder</label>
            <div class="folder-picker-row">
              <input
                type="text"
                name="folder"
                id="wow_folder"
                bind:value={wowFolder}
                autocomplete="off"
                onclick={openFolder}
                onblur={onWowFolderBlur}
              />
              <button
                type="button"
                class="browse-folder-btn"
                onclick={openFolder}
                title="Open File Explorer to select WoW folder"
                aria-label="Browse for WoW folder"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path
                    d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
                  />
                </svg>
              </button>
            </div>
          </div>
          <div class="input">
            <label for="api_key">API key (from Discord)</label>
            <input
              name="api_key"
              id="api_key"
              bind:value={apiKey}
              onchange={updateKey}
            />
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-section-title">App behavior</h2>
          <div class="checkbox-list">
            <div class="checkbox-group">
              <input
                type="checkbox"
                id="minimize_to_tray"
                bind:checked={minimizeToTray}
                onchange={updateMinimizeToTray}
              />
              <label for="minimize_to_tray">Hide to tray instead of close</label
              >
            </div>

            <div class="checkbox-group">
              <input
                type="checkbox"
                id="auto_update"
                bind:checked={autoUpdate}
                onchange={updateAutoUpdateSetting}
              />
              <label for="auto_update">Auto-update addons</label>
            </div>

            <div class="checkbox-group">
              <input
                type="checkbox"
                id="start_on_startup"
                bind:checked={startOnStartup}
                onchange={updateStartOnStartupSetting}
              />
              <label for="start_on_startup">Start when Windows starts</label>
            </div>
          </div>
        </section>

        <div class="backup-section">
          <h2 class="panel-section-title">WeakAuras backup</h2>
          <div class="checkbox-group">
            <input
              type="checkbox"
              id="backup_enabled"
              bind:checked={backupEnabled}
              onchange={updateBackupSettings}
            />
            <label for="backup_enabled">Enable Backup</label>
          </div>

          {#if backupEnabled}
            <div class="checkbox-group">
              <input
                type="checkbox"
                id="backup_on_startup"
                bind:checked={backupOnStartup}
                onchange={updateBackupSettings}
              />
              <label for="backup_on_startup">Backup on App Start</label>
            </div>

            <div class="checkbox-group">
              <input
                type="checkbox"
                id="backup_all_data"
                bind:checked={backupAllData}
                onchange={updateBackupSettings}
              />
              <label for="backup_all_data">Backup All Addons</label>
            </div>

            {#if lastBackupTime}
              <div class="last-backup-info">
                <div class="last-backup-text">
                  <span class="last-backup-label">Last backup:</span>
                  <span class="last-backup-time">{lastBackupTime}</span>
                </div>
                <button
                  type="button"
                  class="folder-button"
                  onclick={openBackupFolder}
                  title="Open backup folder"
                >
                  📁 Open
                </button>
              </div>
            {/if}

            <button
              type="button"
              class="backup-button"
              disabled={!wowFolder || isBackingUp}
              onclick={backupWeakAuras}
            >
              {isBackingUp ? "Backing Up..." : "Backup Now"}
            </button>
          {/if}
        </div>
      </div>

      <div class="right-panel">
        <h2 class="panel-section-title actions-heading">Addons</h2>
        <div class="action-buttons">
          <button
            type="button"
            class="refresh-button-full"
            onclick={manualRefresh}
            disabled={!wowFolder || !apiKey}
          >
            Refresh status
          </button>

          <div class="button-group">
            <div class="button-group-label-col">
              <label for="nhf-addon-btn">NHF Addon</label>
              {#if !wowFolder || !apiKey}
                <div
                  class="row-status row-status-idle"
                  title="Set WoW folder and API key to load version"
                >
                  <div class="dot gray"></div>
                  <span class="row-status-version">—</span>
                </div>
              {:else}
                {#await data.addon}
                  <div class="row-status row-status-loading">
                    {@render rowAwaitSpinner()}
                  </div>
                {:then addon}
                  <div class="row-status" title="Installed version">
                    <div
                      class="dot"
                      class:gray={!addon.isActive}
                      class:green={addon.isCurrent}
                    ></div>
                    <span class="row-status-version"
                      >{addon.currentVersion}</span
                    >
                  </div>
                {/await}
              {/if}
            </div>
            <button
              id="nhf-addon-btn"
              type="button"
              disabled={!wowFolder || !apiKey || isInstalling}
              class:glowing={isUpdateAvailable}
              class:btn-reinstall={!isUpdateAvailable}
              class:disabled-btn={!wowFolder || !apiKey}
              onclick={update}>{getAddonButtonText()}</button
            >
          </div>

          <div class="button-group">
            <div class="button-group-label-col">
              <label for="ns-raid-tools-btn">NS Raid Tools</label>
              {#if !wowFolder || !apiKey}
                <div
                  class="row-status row-status-idle"
                  title="Set WoW folder and API key to load version"
                >
                  <div class="dot gray"></div>
                  <span class="row-status-version">—</span>
                </div>
              {:else}
                {#await data.nsRaidTools}
                  <div class="row-status row-status-loading">
                    {@render rowAwaitSpinner()}
                  </div>
                {:then addon}
                  <div class="row-status" title="Installed version">
                    <div
                      class="dot"
                      class:gray={!addon.isActive}
                      class:green={addon.isCurrent}
                    ></div>
                    <span class="row-status-version"
                      >{addon.currentVersion}</span
                    >
                  </div>
                {/await}
              {/if}
            </div>
            <button
              id="ns-raid-tools-btn"
              type="button"
              disabled={!wowFolder || !apiKey || isNSInstalling}
              class:glowing={isNSUpdateAvailable}
              class:btn-reinstall={!isNSUpdateAvailable}
              class:disabled-btn={!wowFolder || !apiKey}
              onclick={updateNSRaidTools}>{getNSButtonText()}</button
            >
          </div>

          <div class="button-group">
            <div class="button-group-label-col">
              <label for="m33k-auras-btn">M33kAuras</label>
              {#if !wowFolder || !apiKey}
                <div
                  class="row-status row-status-idle"
                  title="Set WoW folder and API key to load version"
                >
                  <div class="dot gray"></div>
                  <span class="row-status-version">—</span>
                </div>
              {:else}
                {#await data.m33kAuras}
                  <div class="row-status row-status-loading">
                    {@render rowAwaitSpinner()}
                  </div>
                {:then addon}
                  <div class="row-status" title="Installed version">
                    <div
                      class="dot"
                      class:gray={!addon.isActive}
                      class:green={addon.isCurrent}
                    ></div>
                    <span class="row-status-version"
                      >{addon.currentVersion}</span
                    >
                  </div>
                {/await}
              {/if}
            </div>
            <button
              id="m33k-auras-btn"
              type="button"
              disabled={!wowFolder || !apiKey || isM33Installing}
              class:glowing={isM33UpdateAvailable}
              class:btn-reinstall={!isM33UpdateAvailable}
              class:disabled-btn={!wowFolder || !apiKey}
              onclick={updateM33kAuras}>{getM33ButtonText()}</button
            >
          </div>

          <div class="button-group">
            <div class="button-group-label-col">
              <label for="liquid-reminders-btn">Liquid Reminders</label>
              {#if !wowFolder || !apiKey}
                <div
                  class="row-status row-status-idle"
                  title="Set WoW folder and API key to load version"
                >
                  <div class="dot gray"></div>
                  <span class="row-status-version">—</span>
                </div>
              {:else}
                {#await data.liquidReminders}
                  <div class="row-status row-status-loading">
                    {@render rowAwaitSpinner()}
                  </div>
                {:then addon}
                  <div class="row-status" title="Installed version">
                    <div
                      class="dot"
                      class:gray={!addon.isActive}
                      class:green={addon.isCurrent}
                    ></div>
                    <span class="row-status-version"
                      >{addon.currentVersion}</span
                    >
                  </div>
                {/await}
              {/if}
            </div>
            <button
              id="liquid-reminders-btn"
              type="button"
              disabled={!wowFolder || !apiKey || isLRInstalling}
              class:glowing={isLRUpdateAvailable}
              class:btn-reinstall={!isLRUpdateAvailable}
              class:disabled-btn={!wowFolder || !apiKey}
              onclick={updateLiquidReminders}>{getLRButtonText()}</button
            >
          </div>

          <div class="button-group">
            {#await data.client}
              <div class="button-group-label-col">
                <label for="client-update-btn">Client Update</label>
                <div class="row-status row-status-loading">
                  {@render rowAwaitSpinner()}
                </div>
              </div>
              <div class="client-button-wrap">
                {@render rowAwaitSpinner()}
              </div>
            {:then client}
              <div class="button-group-label-col">
                <label for="client-update-btn">Client Update</label>
                <div class="row-status" title="Running version">
                  <div
                    class="dot"
                    class:gray={!client.isActive}
                    class:green={client.isCurrent}
                  ></div>
                  <span class="row-status-version">{client.currentVersion}</span
                  >
                </div>
              </div>
              <div class="client-button-wrap">
                {#if !client.isCurrent}
                  <button
                    id="client-update-btn"
                    class="clientupdate glowing"
                    onclick={updateClient}>Update</button
                  >
                {:else}
                  <button
                    id="client-update-btn"
                    class="clientupdate noanim"
                    disabled>Up To Date</button
                  >
                {/if}
              </div>
            {/await}
          </div>

          {#if isAutoUpdating}
            <div class="auto-update-info">
              <div class="update-status">
                <span>Auto-updating: {currentUpdating}</span>
              </div>
              {#if updateQueue.length > 0}
                <div class="update-queue">
                  <span
                    >Update queue: {updateQueue.length} addon(s) pending</span
                  >
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <div class="companion-content">
      <section class="companion-panel">
        <h2 class="panel-section-title">Companion</h2>
        <p class="companion-help">
          Fetch raid roster, assignment notes and raid plans into the
          <code>NHFCompanion</code> addon. Generate an API key in the web app
          under
          <strong>Your Profile</strong>.
        </p>
        <p class="companion-disclaimer">
          After fetching, run <code>/reload</code> in WoW for the addon to load updated
          data.
        </p>

        {#if !wowFolder || !isRetailWowPath(wowFolder)}
          <p class="companion-warning">
            Set a valid WoW folder in Addon Manager first (must end with
            <code>_retail_</code>).
          </p>
        {/if}

        <div class="input">
          <label for="external_api_key">External API key</label>
          <input
            type="password"
            name="external_api_key"
            id="external_api_key"
            bind:value={externalApiKey}
            onchange={updateExternalApiKey}
            placeholder="nhf_..."
            autocomplete="off"
          />
        </div>

        <div class="input">
          <label for="companion_season_id">Season</label>
          <select
            id="companion_season_id"
            name="companion_season_id"
            bind:value={companionSeasonId}
            onchange={updateCompanionSeasonId}
            disabled={isSeasonsLoading ||
              !externalApiKey.trim() ||
              companionSeasons.length === 0}
          >
            {#if isSeasonsLoading}
              <option value="">Loading seasons…</option>
            {:else if companionSeasons.length === 0}
              <option value="">Enter API key to load seasons</option>
            {:else}
              {#each companionSeasons as season (season.id)}
                <option value={season.id}>
                  {season.expansion} — {season.name}{season.id ===
                  companionCurrentSeasonId
                    ? " (current)"
                    : ""}
                </option>
              {/each}
            {/if}
          </select>
          {#if seasonsLoadError}
            <p class="companion-season-error">{seasonsLoadError}</p>
          {/if}
        </div>

        <div class="companion-actions">
          <div class="checkbox-group companion-fetch-on-startup">
            <input
              type="checkbox"
              id="companion_fetch_on_startup"
              bind:checked={companionFetchOnStartup}
              onchange={updateCompanionFetchOnStartup}
            />
            <label for="companion_fetch_on_startup"
              >Fetch data on app launch</label
            >
          </div>

          <button
            type="button"
            class="companion-fetch-btn"
            disabled={!canFetchCompanion}
            onclick={fetchCompanionData}
          >
            {#if isCompanionFetching}
              <LoaderCircle
                size={14}
                strokeWidth={2.25}
                aria-hidden="true"
                class="companion-fetch-icon-spin"
              />
              <span>Fetching…</span>
            {:else}
              <Download size={14} strokeWidth={2.25} aria-hidden="true" />
              <span>Fetch Data</span>
            {/if}
          </button>
        </div>

        <div class="companion-data-preview">
          <label for="companion_saved_data">Saved companion data</label>
          <textarea
            id="companion_saved_data"
            readonly
            class="companion-data-textarea"
            class:companion-data-textarea-empty={!companionSavedData}
            value={companionSavedData}
            placeholder="Fetch data to preview the saved Data.lua content…"
            title={companionSavedData
              ? "Click to copy to clipboard"
              : undefined}
            onclick={copyCompanionSavedData}
          ></textarea>
          {#if companionSavedData}
            <p class="companion-data-hint">Click to copy to clipboard</p>
          {/if}
        </div>

        <div class="companion-meta">
          {#if companionLastFetch}
            <p class="companion-status">
              Last fetch: {new Date(companionLastFetch).toLocaleString()}
            </p>
          {/if}

          <p class="companion-output-path">
            Writes to
            <code>{wowFolder || "…"}/Interface/AddOns/NHFCompanion/</code>
          </p>
        </div>
      </section>
    </div>
  {/if}

  <div
    class="install-dock-panel"
    class:install-dock-open={installDock.open}
    aria-hidden={!installDock.open}
  >
    <div
      class="install-dock-inner"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div class="install-dock-top">
        <span class="install-dock-name">{installDock.name}</span>
        <span class="install-dock-phase">
          {#if installDock.phase === "download"}
            Downloading
          {:else if installDock.phase === "extract"}
            Extracting
          {:else}
            Backing up
          {/if}
        </span>
      </div>
      <div class="install-dock-bar">
        {#if installDock.phase === "extract"}
          <div class="install-dock-fill install-dock-fill-busy"></div>
        {:else}
          <div
            class="install-dock-fill"
            style="width: {installDock.percent}%"
          ></div>
        {/if}
      </div>
      <p class="install-dock-detail">{installDock.detail}</p>
    </div>
  </div>

  <footer class="server-footer">
    {#await data.isServerUp}
      <div class="server-footer-inner">
        {@render rowAwaitSpinner()}
      </div>
    {:then isServerUp}
      <div class="server-footer-inner">
        <div class="dot server-dot" class:green={isServerUp}></div>
        <span class="server-footer-label">Server</span>
        <span class="server-footer-state" class:online={isServerUp}>
          {isServerUp ? "Online" : "Offline"}
        </span>
      </div>
    {/await}
  </footer>
</main>

<style>
  @import url("https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap");

  :global(html) {
    height: 100%;
    background: transparent;
  }

  :global(body) {
    margin: 0;
    height: 100%;
    min-height: 100%;
    overflow: hidden;
    color-scheme: dark;
    background: transparent;
  }

  main {
    --very-dark: #0f0f0f;
    --dark: #191516;
    --header-bg: #282223;
    --border-color: #292224;
    --gray-light: #5b626e;
    --light: #eeeeee;
    --accent: #ab2346;
    --accent-light: #e73361;
    --accent-dark: #8a1c38;

    --app-bg: var(--very-dark);
    --surface-0: rgba(25, 21, 22, 0.96);
    --surface-1: rgba(40, 34, 35, 0.95);
    --surface-2: rgba(41, 34, 36, 0.98);
    --surface-panel: rgba(40, 34, 35, 0.72);
    --border: var(--border-color);
    --border-strong: #352d30;
    --text: var(--light);
    --text-muted: var(--gray-light);
    --text-subtle: #4a4f58;
    --accent-soft: rgba(171, 35, 70, 0.18);
    --accent-ring: rgba(171, 35, 70, 0.45);
    --accent-glow: rgba(171, 35, 70, 0.38);
    --btn-primary-bg: linear-gradient(
      180deg,
      var(--accent-light) 0%,
      var(--accent) 52%,
      var(--accent-dark) 100%
    );
    --btn-primary-shadow: 0 4px 14px rgba(171, 35, 70, 0.32);
    --btn-primary-shadow-hover: 0 6px 20px rgba(171, 35, 70, 0.42);
    --success: #34c759;
    --success-muted: rgba(52, 199, 89, 0.16);
    --danger: #ff5c5c;
    --danger-muted: rgba(255, 92, 92, 0.14);
    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 16px;
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.35);
    --shadow-md: 0 8px 32px rgba(0, 0, 0, 0.45);
    --font: "DM Sans", system-ui, -apple-system, sans-serif;

    color: var(--text);
    font-family: var(--font);
    font-weight: 400;
    height: 100%;
    min-height: 100%;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    padding: 16px 24px 12px;
    box-sizing: border-box;
    position: relative;
    overflow: hidden;
    border-radius: var(--radius-lg);
    /* Dark edge hides WebView alpha fringe; avoid light outer rings (read as white corners). */
    border: 1px solid rgba(0, 0, 0, 0.55);
    background: radial-gradient(
        ellipse 120% 80% at 50% -20%,
        rgba(171, 35, 70, 0.14),
        transparent 55%
      ),
      linear-gradient(
        165deg,
        var(--very-dark) 0%,
        var(--dark) 45%,
        #120f10 100%
      );
    /* No outer blur: OS + WebView2 often composite it as a square on transparent windows. */
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }

  .notification {
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    padding: 14px 18px;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 300px;
    max-width: 500px;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    box-shadow: var(--shadow-md);
    animation: slideInFromTop 0.35s cubic-bezier(0.22, 1, 0.36, 1);
    border: 1px solid var(--border-strong);
  }

  .notification.error {
    background: linear-gradient(
      135deg,
      rgba(171, 35, 70, 0.96),
      rgba(138, 28, 56, 0.94)
    );
    color: #fff;
  }

  .notification.success {
    background: linear-gradient(
      135deg,
      rgba(36, 120, 72, 0.95),
      rgba(24, 90, 52, 0.92)
    );
    color: #fff;
  }

  .notification-message {
    flex: 1;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.45;
  }

  .notification-close {
    background: rgba(255, 255, 255, 0.12);
    border: none;
    color: white;
    font-size: 18px;
    line-height: 1;
    font-weight: 500;
    cursor: pointer;
    padding: 6px;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    transition: background-color 0.2s ease;
    flex: 0 0 auto;
    margin-left: 2px;
  }

  .notification-close:hover {
    background: rgba(255, 255, 255, 0.22);
  }

  @keyframes slideInFromTop {
    from {
      transform: translateX(-50%) translateY(-120%);
      opacity: 0;
    }
    to {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }
  }

  .title-bar {
    position: relative;
    z-index: 1;
    flex-shrink: 0;
    display: flex;
    align-items: stretch;
    justify-content: space-between;
    min-height: 38px;
    margin: -16px -24px 18px -24px;
    background: rgba(40, 34, 35, 0.97);
    border-bottom: 1px solid var(--border);
    user-select: none;
  }

  .title-bar-drag {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    padding: 0 14px;
    cursor: default;
  }

  .title-bar-icon {
    flex-shrink: 0;
    border-radius: 5px;
    object-fit: contain;
    box-shadow: 0 0 0 1px var(--border);
  }

  .title-bar-text {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .title-bar-controls {
    display: flex;
    flex-shrink: 0;
  }

  .title-bar-btn {
    display: inline-flex !important;
    align-items: center;
    justify-content: center;
    width: 46px;
    min-width: 46px;
    min-height: 38px;
    padding: 0 !important;
    margin: 0 !important;
    flex: 0 0 auto !important;
    border: none !important;
    border-radius: 0 !important;
    background: transparent !important;
    box-shadow: none !important;
    color: var(--text-muted);
    cursor: pointer;
    font-family: var(--font);
    transition:
      background 0.12s ease,
      color 0.12s ease;
  }

  .title-bar-btn:hover {
    background: rgba(255, 255, 255, 0.08) !important;
    color: var(--text);
    filter: none !important;
  }

  .title-bar-btn-close:hover {
    background: #c42b1c !important;
    color: #fff !important;
  }

  .title-bar-btn:active {
    background: rgba(255, 255, 255, 0.12) !important;
  }

  .title-bar-btn-close:active:hover {
    background: #a92418 !important;
    color: #fff !important;
  }

  .view-nav {
    position: relative;
    z-index: 1;
    display: inline-flex;
    gap: 2px;
    margin: 0 0 10px;
    padding: 2px;
    background: rgba(25, 21, 22, 0.72);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    width: fit-content;
    max-width: 100%;
  }

  .view-nav-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-family: var(--font);
    font-size: 12px;
    font-weight: 600;
    padding: 5px 10px;
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
    line-height: 1;
    transition:
      background 0.15s ease,
      color 0.15s ease;
  }

  .view-nav-btn :global(svg) {
    flex-shrink: 0;
  }

  .view-nav-btn:hover {
    color: var(--text);
    background: rgba(255, 255, 255, 0.06);
  }

  .view-nav-btn-active {
    color: var(--text);
    background: var(--accent-soft);
    box-shadow: 0 0 0 1px var(--accent-ring);
  }

  .companion-content {
    position: relative;
    z-index: 1;
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
  }

  .companion-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--surface-panel);
    backdrop-filter: blur(20px) saturate(1.4);
    -webkit-backdrop-filter: blur(20px) saturate(1.4);
    border-radius: var(--radius-lg);
    padding: 20px 22px 22px;
    border: 1px solid var(--border);
    min-height: 0;
    min-width: 0;
    overflow: auto;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.05) inset,
      0 0 32px rgba(0, 0, 0, 0.28);
  }

  .companion-help,
  .companion-warning,
  .companion-status,
  .companion-output-path {
    margin: 0 0 10px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .companion-disclaimer {
    margin: 0 0 14px;
    padding: 10px 12px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text);
    background: var(--accent-soft);
    border: 1px solid var(--accent-ring);
    border-radius: var(--radius-sm);
  }

  .companion-actions {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 0 0 auto;
    margin: 0 0 14px;
  }

  .companion-data-preview {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0 0 8px;
    min-height: 0;
    min-width: 0;
    max-width: 100%;
    flex: 0 0 auto;
  }

  .companion-data-preview label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
  }

  .companion-data-textarea {
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    height: 44px;
    min-height: 44px;
    max-height: 44px;
    padding: 8px 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    line-height: 1.45;
    font-weight: 500;
    color: var(--text);
    background: var(--surface-0);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    resize: none;
    overflow: hidden;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    cursor: pointer;
    transition:
      border-color 0.2s ease,
      box-shadow 0.2s ease;
  }

  .companion-data-textarea-empty {
    cursor: default;
  }

  .companion-data-textarea:not(.companion-data-textarea-empty):hover {
    border-color: var(--accent-ring);
  }

  .companion-data-textarea:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .companion-data-hint {
    margin: 0 0 2px;
    font-size: 12px;
    color: var(--text-subtle);
  }

  .companion-meta {
    flex: 0 0 auto;
    flex-shrink: 0;
    padding-top: 0;
  }

  .companion-meta .companion-status,
  .companion-meta .companion-output-path {
    margin-bottom: 8px;
  }

  .companion-meta .companion-output-path:last-child {
    margin-bottom: 0;
  }

  .companion-warning {
    color: #ffb347;
    padding: 10px 12px;
    background: rgba(255, 179, 71, 0.1);
    border: 1px solid rgba(255, 179, 71, 0.25);
    border-radius: var(--radius-sm);
  }

  .companion-help code,
  .companion-disclaimer code,
  .companion-output-path code {
    font-size: 12px;
    color: var(--text);
    font-weight: 600;
  }

  .companion-fetch-btn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    width: 100%;
    min-height: 0;
    height: auto;
    margin: 0;
    padding: 12px 16px;
    font-weight: 600;
    font-size: 12px;
    line-height: 1;
    font-family: var(--font);
    color: var(--light);
    background: var(--btn-primary-bg);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: var(--radius-sm);
    cursor: pointer;
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.1) inset,
      var(--btn-primary-shadow);
    transition:
      filter 0.2s ease,
      transform 0.15s ease,
      box-shadow 0.2s ease;
  }

  .companion-fetch-btn :global(svg) {
    flex-shrink: 0;
  }

  .companion-fetch-btn :global(.companion-fetch-icon-spin) {
    animation: companion-spin 0.75s linear infinite;
  }

  @keyframes companion-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .companion-fetch-btn:hover:not(:disabled) {
    filter: brightness(1.05);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.14) inset,
      var(--btn-primary-shadow-hover);
  }

  .companion-fetch-btn:active:not(:disabled) {
    transform: scale(0.995);
  }

  .companion-fetch-btn:disabled {
    background: var(--surface-2);
    color: var(--text-subtle);
    border-color: var(--border);
    box-shadow: none;
    cursor: not-allowed;
    filter: none;
  }

  .main-content {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: minmax(280px, 1fr) minmax(300px, 1.12fr);
    gap: 20px;
    margin: 0;
    flex: 1;
    min-height: 0;
    align-items: stretch;
  }

  @media (max-width: 640px) {
    .main-content {
      grid-template-columns: 1fr;
    }
  }

  .left-panel,
  .right-panel {
    display: flex;
    flex-direction: column;
    background: var(--surface-panel);
    backdrop-filter: blur(20px) saturate(1.4);
    -webkit-backdrop-filter: blur(20px) saturate(1.4);
    border-radius: var(--radius-lg);
    padding: 20px 22px 22px;
    border: 1px solid var(--border);
    min-height: 0;
    overflow: auto;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.05) inset,
      0 8px 32px rgba(0, 0, 0, 0.28);
    scrollbar-width: thin;
    scrollbar-color: var(--accent-ring) rgba(255, 255, 255, 0.04);
  }

  .left-panel::-webkit-scrollbar,
  .right-panel::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  .left-panel::-webkit-scrollbar-button,
  .right-panel::-webkit-scrollbar-button {
    display: block;
    width: 0 !important;
    height: 0 !important;
    min-height: 0 !important;
    min-width: 0 !important;
  }

  .left-panel::-webkit-scrollbar-button:vertical:decrement,
  .right-panel::-webkit-scrollbar-button:vertical:decrement,
  .left-panel::-webkit-scrollbar-button:vertical:increment,
  .right-panel::-webkit-scrollbar-button:vertical:increment,
  .left-panel::-webkit-scrollbar-button:horizontal:decrement,
  .right-panel::-webkit-scrollbar-button:horizontal:decrement,
  .left-panel::-webkit-scrollbar-button:horizontal:increment,
  .right-panel::-webkit-scrollbar-button:horizontal:increment {
    display: block;
    width: 0 !important;
    height: 0 !important;
  }

  .left-panel::-webkit-scrollbar-track,
  .right-panel::-webkit-scrollbar-track {
    background: rgba(255, 255, 255, 0.04);
    border-radius: 6px;
    margin: 4px 0;
  }

  .left-panel::-webkit-scrollbar-thumb,
  .right-panel::-webkit-scrollbar-thumb {
    background: rgba(171, 35, 70, 0.38);
    border-radius: 6px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }

  .left-panel::-webkit-scrollbar-thumb:hover,
  .right-panel::-webkit-scrollbar-thumb:hover {
    background: rgba(171, 35, 70, 0.58);
    border: 2px solid transparent;
    background-clip: padding-box;
  }

  .left-panel::-webkit-scrollbar-corner,
  .right-panel::-webkit-scrollbar-corner {
    background: transparent;
  }

  .panel-section {
    margin-bottom: 20px;
  }

  .panel-section:last-of-type {
    margin-bottom: 0;
  }

  .panel-section-title {
    margin: 0 0 12px;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-subtle);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .actions-heading {
    margin: 0 0 14px;
    flex-shrink: 0;
  }

  .checkbox-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .action-buttons {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 1;
    min-height: 0;
  }

  .button-group {
    display: grid;
    grid-template-columns: minmax(128px, 34%) minmax(0, 1fr);
    align-items: center;
    gap: 10px 14px;
  }

  .button-group-label-col {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 5px;
    min-width: 0;
  }

  .button-group-label-col label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
    text-align: left;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    line-height: 1.25;
    margin: 0;
  }

  .client-button-wrap {
    min-width: 0;
    display: flex;
    align-items: stretch;
    justify-content: stretch;
  }

  .client-button-wrap button {
    width: 100%;
  }

  .row-status {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 7px;
    min-width: 0;
    max-width: 100%;
  }

  .row-status-version {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    line-height: 1.2;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    text-align: left;
  }

  .row-status-idle .row-status-version {
    color: var(--text-subtle);
    font-weight: 500;
  }

  .row-status-loading {
    justify-content: flex-start;
    min-height: 18px;
  }

  .row-status-spinner {
    color: var(--accent);
    opacity: 0.88;
    flex-shrink: 0;
  }

  .input {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0 0 12px;
  }

  .input:last-child {
    margin-bottom: 0;
  }

  .input input {
    padding: 10px 14px;
    font-weight: 500;
    font-size: 13px;
  }

  .input select {
    padding: 10px 14px;
    font-weight: 500;
    font-size: 13px;
    font-family: var(--font);
    color: var(--text);
    background: var(--surface-0);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .input select:disabled {
    color: var(--text-subtle);
    cursor: not-allowed;
    opacity: 0.75;
  }

  .companion-season-error {
    margin: 0;
    font-size: 12px;
    color: var(--danger);
  }

  .folder-picker-row {
    display: flex;
    align-items: stretch;
    gap: 8px;
    min-width: 0;
  }

  .folder-picker-row input {
    flex: 1;
    min-width: 0;
  }

  .browse-folder-btn {
    flex: 0 0 auto !important;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 10px 12px;
    font-size: 13px;
    font-weight: 600;
    font-family: var(--font);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    color: var(--text-muted);
    white-space: nowrap;
    transition:
      background 0.2s ease,
      border-color 0.2s ease,
      color 0.2s ease,
      box-shadow 0.2s ease;
  }

  .browse-folder-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: var(--accent-ring);
    color: var(--accent);
  }

  .browse-folder-btn:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .install-dock-panel {
    position: relative;
    z-index: 1;
    flex-shrink: 0;
    max-height: 0;
    opacity: 0;
    overflow: hidden;
    transform: translateY(12px);
    transition:
      max-height 0.42s cubic-bezier(0.22, 1, 0.36, 1),
      opacity 0.28s ease,
      transform 0.42s cubic-bezier(0.22, 1, 0.36, 1),
      margin 0.42s ease;
    margin-top: 0;
    pointer-events: none;
  }

  .install-dock-panel.install-dock-open {
    max-height: 120px;
    opacity: 1;
    transform: translateY(0);
    margin-top: 10px;
    pointer-events: auto;
  }

  .install-dock-inner {
    padding: 12px 14px 14px;
    border-radius: var(--radius-md);
    background: var(--surface-1);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow-md);
  }

  .install-dock-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }

  .install-dock-name {
    font-size: 13px;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.02em;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .install-dock-phase {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent);
  }

  .install-dock-bar {
    height: 5px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.07);
    overflow: hidden;
    margin-bottom: 8px;
  }

  .install-dock-fill {
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--accent), var(--accent-light));
    transition: width 0.22s ease-out;
    min-width: 0;
  }

  .install-dock-fill-busy {
    width: 38%;
    animation: installDockIndeterminate 1.1s ease-in-out infinite;
  }

  @keyframes installDockIndeterminate {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(280%);
    }
  }

  .install-dock-detail {
    margin: 0;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
    line-height: 1.35;
  }

  .server-footer {
    position: relative;
    z-index: 1;
    margin-top: auto;
    padding-top: 10px;
    flex-shrink: 0;
    display: flex;
    justify-content: flex-end;
    align-items: center;
  }

  .server-footer-inner {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-subtle);
  }

  .server-footer-label {
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 10px;
  }

  .server-footer-state {
    font-weight: 600;
    color: var(--accent);
  }

  .server-footer-state.online {
    color: var(--success);
  }

  .server-dot {
    width: 7px;
    height: 7px;
  }

  .dot {
    width: 9px;
    height: 9px;
    flex-shrink: 0;
    background: var(--accent);
    border-radius: 50%;
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  .dot.green {
    background: var(--success);
    box-shadow: 0 0 0 2px var(--success-muted);
  }

  .dot.gray {
    background: var(--gray-light);
    box-shadow: 0 0 0 2px rgba(91, 98, 110, 0.2);
  }

  input {
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-strong);
    background: var(--surface-0);
    color: var(--text);
    padding: 10px 14px;
    font-size: 13px;
    transition:
      border-color 0.2s ease,
      box-shadow 0.2s ease;
  }

  input:hover:not(:focus) {
    border-color: rgba(255, 255, 255, 0.16);
  }

  input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .input label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 0.03em;
  }

  .backup-section {
    margin-top: 4px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
  }

  .checkbox-group {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 0;
    min-height: 28px;
  }

  .checkbox-group input[type="checkbox"] {
    width: 17px;
    height: 17px;
    border-radius: 4px;
    accent-color: var(--accent);
    cursor: pointer;
  }

  .checkbox-group label {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted);
    cursor: pointer;
  }

  .auto-update-info {
    margin-top: 4px;
    margin-bottom: 8px;
    padding: 12px 14px;
    background: var(--accent-soft);
    border: 1px solid rgba(171, 35, 70, 0.28);
    border-radius: var(--radius-sm);
  }

  .update-status,
  .update-queue {
    font-size: 12px;
    color: var(--accent);
    font-weight: 600;
    margin-top: 4px;
  }

  .refresh-button-full {
    width: 100%;
    margin: 0 0 6px;
    flex: 0 0 auto;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 10px 16px;
    font-weight: 600;
    font-size: 12px;
    font-family: var(--font);
    cursor: pointer;
    transition:
      background 0.2s ease,
      border-color 0.2s ease,
      transform 0.15s ease;
  }

  .refresh-button-full:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.18);
  }

  .refresh-button-full:active:not(:disabled) {
    transform: scale(0.99);
  }

  .refresh-button-full:disabled {
    background: rgba(255, 255, 255, 0.04);
    color: var(--text-subtle);
    border-color: var(--border);
    cursor: not-allowed;
    opacity: 0.75;
  }

  .backup-button {
    width: 100%;
    margin-top: 10px;
    background: linear-gradient(135deg, #2d9f5e 0%, #248a52 100%);
    color: #fff;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 16px;
    font-weight: 600;
    font-size: 13px;
    font-family: var(--font);
    cursor: pointer;
    transition:
      filter 0.2s ease,
      transform 0.15s ease;
    box-shadow: 0 2px 8px rgba(36, 138, 82, 0.25);
  }

  .backup-button:hover:not(:disabled) {
    filter: brightness(1.06);
  }

  .backup-button:active:not(:disabled) {
    transform: scale(0.995);
  }

  .backup-button:disabled {
    background: var(--surface-2);
    color: var(--text-subtle);
    border-color: var(--border);
    box-shadow: none;
    cursor: not-allowed;
    filter: none;
  }

  .last-backup-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 10px 0;
    padding: 10px 14px;
    background: var(--surface-0);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    gap: 10px;
  }

  .last-backup-text {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    align-items: baseline;
    min-width: 0;
  }

  .last-backup-label {
    font-size: 11px;
    color: var(--text-subtle);
    font-weight: 500;
  }

  .last-backup-time {
    font-size: 11px;
    color: var(--accent);
    font-weight: 600;
  }

  .folder-button {
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    font-family: var(--font);
    padding: 6px 10px;
    transition:
      background 0.2s ease,
      border-color 0.2s ease,
      color 0.2s ease;
    min-height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .folder-button:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: var(--accent-ring);
    color: var(--accent);
  }

  /* Base: all buttons */
  button {
    font-family: var(--font);
    margin: 0;
    border: none;
    cursor: pointer;
    flex: 1;
  }

  /* Primary addon + client actions */
  .action-buttons .button-group > button,
  .action-buttons button.clientupdate {
    position: relative;
    padding: 10px 18px;
    font-weight: 600;
    font-size: 13px;
    border-radius: var(--radius-sm);
    color: var(--light);
    background: var(--btn-primary-bg);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.1) inset,
      var(--btn-primary-shadow);
    transition:
      transform 0.15s ease,
      box-shadow 0.2s ease,
      filter 0.2s ease;
  }

  .action-buttons .button-group > button:hover:not(:disabled),
  .action-buttons button.clientupdate:hover:not(:disabled) {
    filter: brightness(1.05);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.14) inset,
      var(--btn-primary-shadow-hover);
  }

  .action-buttons .button-group > button:active:not(:disabled),
  .action-buttons button.clientupdate:active:not(:disabled) {
    transform: scale(0.99);
  }

  /* Up to date — secondary reinstall action */
  .action-buttons .button-group > button.btn-reinstall:not(:disabled) {
    color: var(--text-muted);
    background: var(--surface-1);
    border: 1px solid var(--border-strong);
    box-shadow: none;
    filter: none;
  }

  .action-buttons .button-group > button.btn-reinstall:hover:not(:disabled) {
    color: var(--light);
    background: var(--header-bg);
    border-color: rgba(171, 35, 70, 0.32);
    box-shadow: none;
    filter: none;
  }

  .action-buttons .button-group > button.btn-reinstall:active:not(:disabled) {
    background: var(--surface-2);
  }

  /* Update available — attention without rainbow */
  .action-buttons .button-group > button.glowing:not(:disabled),
  .action-buttons button.clientupdate.glowing:not(:disabled) {
    color: var(--light);
    background: linear-gradient(
      180deg,
      var(--accent-light) 0%,
      var(--accent) 100%
    );
    border-color: var(--accent-ring);
    box-shadow:
      0 0 0 1px var(--accent-soft),
      0 0 28px var(--accent-glow);
    animation: accentPulse 2.2s ease-in-out infinite;
  }

  @keyframes accentPulse {
    0%,
    100% {
      box-shadow:
        0 0 0 1px var(--accent-soft),
        0 0 22px rgba(171, 35, 70, 0.3);
    }
    50% {
      box-shadow:
        0 0 0 1px var(--accent-ring),
        0 0 36px rgba(171, 35, 70, 0.48);
    }
  }

  /* Busy / downloading */
  .action-buttons .button-group > button:disabled:not(.disabled-btn),
  .action-buttons button.clientupdate:disabled:not(.noanim):not(.disabled-btn) {
    color: var(--text-muted);
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    box-shadow: none;
    animation: none;
    cursor: wait;
    filter: none;
  }

  .action-buttons button.clientupdate.noanim:disabled {
    background: linear-gradient(180deg, #30a85e 0%, #248a4e 100%) !important;
    color: #fff !important;
    border: 1px solid rgba(255, 255, 255, 0.12) !important;
    box-shadow: 0 2px 12px rgba(36, 138, 78, 0.3) !important;
    cursor: not-allowed !important;
    filter: none !important;
    opacity: 1 !important;
    animation: none !important;
  }

  .action-buttons .button-group > button.disabled-btn,
  .action-buttons .button-group > button:disabled.disabled-btn {
    background: rgba(255, 255, 255, 0.06) !important;
    color: var(--text-subtle) !important;
    border: 1px solid var(--border) !important;
    box-shadow: none !important;
    cursor: not-allowed !important;
    opacity: 0.85 !important;
    filter: none !important;
    animation: none !important;
  }
</style>
