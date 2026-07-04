import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/**
 * @param {RequestInit} [init]
 */
function normalizeInit(init = {}) {
  const headers = init.headers;
  if (!headers) return init;
  if (headers instanceof Headers) {
    return { ...init, headers: Object.fromEntries(headers.entries()) };
  }
  if (Array.isArray(headers)) {
    return { ...init, headers: Object.fromEntries(headers) };
  }
  return init;
}

/**
 * Use Tauri's HTTP client in the desktop app (no CORS). Fall back to browser
 * fetch during SSG build or plain Vite dev without the Tauri shell.
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function platformFetch(url, init = {}) {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return tauriFetch(url, normalizeInit(init));
  }
  return fetch(url, init);
}

/**
 * Fetch with retries and backoff for transient DNS / TLS / wake-from-sleep failures.
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} [maxAttempts]
 */
export async function fetchWithRetry(url, init = {}, maxAttempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await platformFetch(url, init);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response;
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 400 * attempt * attempt));
      }
    }
  }
  throw lastError;
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} [maxAttempts]
 */
export async function fetchJsonWithRetry(url, init, maxAttempts) {
  const response = await fetchWithRetry(url, init, maxAttempts);
  return response.json();
}
