import { getVersion } from '@tauri-apps/api/app';
import { load as loadStore } from '@tauri-apps/plugin-store';
import { getCurrentAddonVersion, getCurrentNSRaidToolsVersion, getCurrentM33kAurasVersion, getCurrentLiquidRemindersVersion, compareVersions } from './addonService';
import { fetchJsonWithRetry } from './networkRetry.js';
import {
    checkApiReachable,
    fetchLatestAddon,
    fetchLatestClient,
    fetchLatestLiquidReminders,
} from './releasesApi.js';

export const load = async () => {
    const store = await loadStore('store.json');
    const apiKey = await store?.get('external_api_key');

    const latestClient = fetchLatestClient(apiKey);
    const latestAddon = fetchLatestAddon(apiKey);
    const latestLiquidReminders = fetchLatestLiquidReminders(apiKey);

    return {
        isServerUp: checkApiReachable(apiKey),
        client: new Promise((resolve) => {
            latestClient.then((data) => {
                data.semVersion = data.semVersion.replace("v", "");
                data.isActive = true;
                getVersion().then((currentVersion) => {
                    data.isCurrent = data.semVersion === currentVersion;
                    data.currentVersion = currentVersion;
                    resolve(data);
                })
            }).catch((error) => {
                console.error(error);
                getVersion().then((currentVersion) => {
                    resolve({
                        isActive: false,
                        isCurrent: false,
                        currentVersion: currentVersion,
                    });
                })
            })
        }),
        addon: new Promise((resolve) => {
            latestAddon.then((data) => {
                data.semVersion = data.semVersion;
                data.isActive = true;
                getCurrentAddonVersion().then((currentVersion) => {
                    if (!currentVersion) {
                        data.isCurrent = false;
                        data.currentVersion = 'N/A';
                        data.isInstalled = false;
                    } else {
                        data.currentVersion = currentVersion;
                        data.isCurrent = compareVersions(data.semVersion, currentVersion) === 0;
                        data.isInstalled = true;
                    }
                    resolve(data);
                })
            }).catch((error) => {
                console.error(error);
                getCurrentAddonVersion().then((currentVersion) => {
                    resolve({
                        isActive: false,
                        isCurrent: false,
                        currentVersion: currentVersion || 'N/A',
                        isInstalled: !!currentVersion
                    });
                })
            })
        }),
        nsRaidTools: new Promise((resolve) => {
            fetchJsonWithRetry('https://api.github.com/repos/Reloe/NorthernSkyRaidTools/releases/latest')
                .then((data) => {
                    const resolvedData = { isCurrent: false, currentVersion: 'N/A', isActive: true, isInstalled: false };
                    const remoteTag = data.tag_name ?? '';
                    getCurrentNSRaidToolsVersion().then((currentVersion) => {
                        if (!currentVersion) {
                            resolvedData.isCurrent = false;
                            resolvedData.currentVersion = 'N/A';
                            resolvedData.isInstalled = false;
                        } else {
                            resolvedData.currentVersion = currentVersion;
                            resolvedData.isCurrent = compareVersions(remoteTag, currentVersion) === 0;
                            resolvedData.isInstalled = true;
                        }
                        resolve(resolvedData);
                    }).catch((error) => {
                        console.error(error);
                        getCurrentNSRaidToolsVersion().then((currentVersion) => {
                            resolve({
                                isActive: false,
                                isCurrent: false,
                                currentVersion: currentVersion || 'N/A',
                                isInstalled: !!currentVersion
                            })
                        }).catch(() => {
                            resolve({
                                isActive: false,
                                isCurrent: false,
                                currentVersion: 'N/A',
                                isInstalled: false
                            });
                        });
                    })
                })
                .catch((error) => {
                    console.error(error);
                    getCurrentNSRaidToolsVersion().then((currentVersion) => {
                        resolve({
                            isActive: false,
                            isCurrent: false,
                            currentVersion: currentVersion || 'N/A',
                            isInstalled: !!currentVersion
                        });
                    }).catch(() => {
                        resolve({
                            isActive: false,
                            isCurrent: false,
                            currentVersion: 'N/A',
                            isInstalled: false
                        });
                    });
                });
        }),
        m33kAuras: new Promise((resolve) => {
            fetchJsonWithRetry('https://api.github.com/repos/m33shoq/M33kAuras/releases/latest')
                .then((data) => {
                    const resolvedData = { isCurrent: false, currentVersion: 'N/A', isActive: true, isInstalled: false };
                    const remoteTag = data.tag_name ?? '';
                    getCurrentM33kAurasVersion().then((currentVersion) => {
                        if (!currentVersion) {
                            resolvedData.isCurrent = false;
                            resolvedData.currentVersion = 'N/A';
                            resolvedData.isInstalled = false;
                        } else {
                            resolvedData.currentVersion = currentVersion;
                            resolvedData.isCurrent = compareVersions(remoteTag, currentVersion) === 0;
                            resolvedData.isInstalled = true;
                        }
                        resolve(resolvedData);
                    }).catch((error) => {
                        console.error(error);
                        getCurrentM33kAurasVersion().then((currentVersion) => {
                            resolve({
                                isActive: false,
                                isCurrent: false,
                                currentVersion: currentVersion || 'N/A',
                                isInstalled: !!currentVersion
                            })
                        }).catch(() => {
                            resolve({
                                isActive: false,
                                isCurrent: false,
                                currentVersion: 'N/A',
                                isInstalled: false
                            });
                        });
                    })
                })
                .catch((error) => {
                    console.error(error);
                    getCurrentM33kAurasVersion().then((currentVersion) => {
                        resolve({
                            isActive: false,
                            isCurrent: false,
                            currentVersion: currentVersion || 'N/A',
                            isInstalled: !!currentVersion
                        });
                    }).catch(() => {
                        resolve({
                            isActive: false,
                            isCurrent: false,
                            currentVersion: 'N/A',
                            isInstalled: false
                        });
                    });
                });
        }),
        liquidReminders: new Promise((resolve) => {
            latestLiquidReminders.then((data) => {
                data.semVersion = data.semVersion;
                data.isActive = true;
                getCurrentLiquidRemindersVersion().then((currentVersion) => {
                    if (!currentVersion) {
                        data.isCurrent = false;
                        data.currentVersion = 'N/A';
                        data.isInstalled = false;
                    } else {
                        data.currentVersion = currentVersion;
                        data.isCurrent = compareVersions(data.semVersion, currentVersion) === 0;
                        data.isInstalled = true;
                    }
                    resolve(data);
                })
            }).catch((error) => {
                console.error(error);
                getCurrentLiquidRemindersVersion().then((currentVersion) => {
                    resolve({
                        isActive: false,
                        isCurrent: false,
                        currentVersion: currentVersion || 'N/A'
                    });
                })
            })
        })
    };
}
