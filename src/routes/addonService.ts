import { invoke } from "@tauri-apps/api/core";
import { load as loadStore } from '@tauri-apps/plugin-store';
import { compareVersions, extractVersionFromToc, extractVersionFromChangelog } from './versionUtils';

export async function getCurrentAddonVersion(): Promise<string | false> {
    const store = await loadStore('store.json');
    try {
        if (store) {
            const storedFolder = await store.get('wow_folder');
            if (storedFolder) {
                const file = await invoke('read_file', { filePath: storedFolder + '/Interface/Addons/NHFAuraManager/NHFAuraManager.toc' }) as string;
                return extractVersionFromToc(file);
            }
        }
    } catch (error) {
        console.error(error);
    }
    return false;
}

export async function getCurrentNSRaidToolsVersion(): Promise<string | false> {
    const store = await loadStore('store.json');
    try {
        if (store) {
            const storedFolder = await store.get('wow_folder');
            if (storedFolder) {
                const file = await invoke('read_file', { filePath: storedFolder + '/Interface/AddOns/NorthernSkyRaidTools/NorthernSkyRaidTools.toc' }) as string;
                return extractVersionFromToc(file);
            }
        }
    } catch (error) {
        console.error(error);
    }
    return false;
}

export async function getCurrentM33kAurasVersion(): Promise<string | false> {
    const store = await loadStore('store.json');
    try {
        if (store) {
            const storedFolder = await store.get('wow_folder');
            if (storedFolder) {
                const file = await invoke('read_file', { filePath: storedFolder + '/Interface/AddOns/M33kAuras/M33kAuras.toc' }) as string;
                return extractVersionFromToc(file);
            }
        }
    } catch (error) {
        console.error(error);
    }
    return false;
}

export async function getCurrentLiquidRemindersVersion(): Promise<string | false> {
    const store = await loadStore('store.json');
    try {
        if (store) {
            const storedFolder = await store.get('wow_folder');
            if (storedFolder) {
                const file = await invoke('read_file', { filePath: storedFolder + '/Interface/AddOns/TimelineReminders/CHANGELOG.md' }) as string;
                return extractVersionFromChangelog(file);
            }
        }
    } catch (error) {
        // Liquid Reminders not installed - this is normal, don't log as error
        console.log('Liquid Reminders not installed or file not found');
    }
    return false;
}

export async function getZipInfo(filePath: string): Promise<any> {
    try {
        return await invoke('get_zip_info', { filePath });
    } catch (error) {
        return `Error getting ZIP info: ${error}`;
    }
}

export async function readTextFile(filePath: string): Promise<string> {
    return await invoke('read_file', { filePath }) as string;
}

export async function fileExists(filePath: string): Promise<boolean> {
    try {
        return await invoke('file_exists', { filePath }) as boolean;
    } catch {
        return false;
    }
}

export async function writeTextFile(filePath: string, contents: string): Promise<void> {
    await invoke('write_file', { filePath, contents });
}

export async function writeBinaryFile(filePath: string, contents: Uint8Array): Promise<void> {
    await invoke('write_binary_file', { filePath, contents: Array.from(contents) });
}

export async function clearDirectory(filePath: string): Promise<void> {
    await invoke('clear_directory', { filePath });
}

export async function validateAndExtractZip(filePath: string, destination: string): Promise<void> {
    try {
        await invoke('validate_zip', { filePath });
    } catch (validationError: any) {
        const zipInfo = await getZipInfo(filePath);
        let message = `ZIP validation failed: ${validationError}`;
        if (typeof validationError === 'string') {
            if (validationError.includes('Could not find EOCD')) {
                message = 'ZIP file is corrupted or incomplete. Please try downloading again.';
            } else if (validationError.includes('Invalid ZIP file')) {
                message = 'ZIP file appears to be corrupted. Please try downloading again.';
            }
        }
        throw new Error(message);
    }
    await invoke('extract_zip', { filePath, destination });
}

export { compareVersions };
