import { PUBLIC_EXTERNAL_API_HOST } from "$env/static/public";
import { fetchJsonWithRetry } from "./networkRetry.js";

/** @param {string} path */
export function buildApiUrl(path) {
  return new URL(path, PUBLIC_EXTERNAL_API_HOST).toString();
}

/** @param {string | undefined | null} apiKey */
export function bearerAuthHeader(apiKey) {
  const key = apiKey?.trim() ?? "";
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** @param {string | undefined | null} apiKey */
export async function fetchLatestAddon(apiKey) {
  return fetchJsonWithRetry(
    buildApiUrl("/api/external/v1/releases/addon/latest"),
    { headers: bearerAuthHeader(apiKey) },
  );
}

/** @param {string | undefined | null} apiKey */
export async function fetchLatestLiquidReminders(apiKey) {
  return fetchJsonWithRetry(
    buildApiUrl("/api/external/v1/releases/liquid-reminders/latest"),
    { headers: bearerAuthHeader(apiKey) },
  );
}

/** @param {string | undefined | null} apiKey */
export async function fetchLatestClient(apiKey) {
  return fetchJsonWithRetry(
    buildApiUrl("/api/external/v1/releases/client/latest"),
    { headers: bearerAuthHeader(apiKey) },
  );
}

/** @param {string | undefined | null} apiKey */
export async function checkApiReachable(apiKey) {
  const key = apiKey?.trim() ?? "";
  if (!key) {
    return false;
  }

  try {
    await fetchJsonWithRetry(buildApiUrl("/api/external/v1/status"), {
      headers: bearerAuthHeader(apiKey),
    });
    return true;
  } catch {
    return false;
  }
}
