import { PUBLIC_EXTERNAL_API_HOST } from '$env/static/public';
import { fetch } from '@tauri-apps/plugin-http';
import { clearDirectory, fileExists, getAddonsDir, readTextFile, writeBinaryFile, writeTextFile } from './addonService';
import { buildNHFDataLua } from './jsonToLua';
import { NHF_COMPANION_ADDON_NAME, NHF_COMPANION_TOC } from './companionToc';
import { getImageSize, type ImageSize } from './imageSize';

export interface SeasonBoss {
    bossId: string;
    name: string;
    journalEncounterId?: number | null;
    dungeonEncounterId?: number | null;
    imageUrl?: string;
    imagePath?: string;
    imageSize?: ImageSize;
    [key: string]: unknown;
}

export interface SeasonResponse {
    teamId: string;
    seasonId: string;
    season: CompanionSeason;
    roster: unknown;
    bosses: SeasonBoss[];
}

export interface RosterBoss {
    bossId: string;
    bossName?: string;
    journalEncounterId?: number | null;
    dungeonEncounterId?: number | null;
    imagePath?: string;
    imageSize?: ImageSize;
    slots?: unknown[];
    bench?: unknown[];
    piAssignments?: unknown[];
    groupSetup?: unknown;
    assignmentId?: string;
    [key: string]: unknown;
}

export interface AssignmentNotesBoss {
    bossId: string;
    bossName?: string;
    journalEncounterId?: number | null;
    dungeonEncounterId?: number | null;
    imagePath?: string;
    imageSize?: ImageSize;
    assignments?: unknown[];
    [key: string]: unknown;
}

export interface RostersResponse {
    teamId: string;
    seasonId: string;
    roster: unknown;
    bosses: RosterBoss[];
}

export interface AssignmentNotesResponse {
    teamId: string;
    seasonId: string;
    bosses: AssignmentNotesBoss[];
}

export interface RaidPlanSlide {
    id: string;
    name?: string;
    backgroundUrl?: string | null;
    backgroundPath?: string;
    backgroundSize?: ImageSize;
    elements?: unknown[];
    [key: string]: unknown;
}

export interface RaidPlanBoard {
    id: string;
    name?: string;
    bossId?: string | null;
    order?: number;
    updatedAt?: string;
    slides?: RaidPlanSlide[];
    [key: string]: unknown;
}

export interface RaidPlanAssetIcon {
    iconUrl?: string;
    iconPath?: string;
    iconSize?: ImageSize;
    [key: string]: unknown;
}

export interface RaidPlanMediaAsset {
    path: string;
    url?: string;
    filePath?: string;
    fileSize?: ImageSize;
    [key: string]: unknown;
}

export interface RaidPlansAssets {
    markers?: RaidPlanAssetIcon[];
    roles?: RaidPlanAssetIcon[];
    classes?: RaidPlanAssetIcon[];
    abilities?: RaidPlanAssetIcon[];
    media?: RaidPlanMediaAsset[];
}

export interface RaidPlansResponse {
    teamId: string;
    seasonId: string;
    stage?: { width: number; height: number };
    assets?: RaidPlansAssets;
    boards: RaidPlanBoard[];
}

export interface CompanionSeason {
    id: string;
    name: string;
    shortLabel: string;
    expansion: string;
    expansionLogo?: string;
    journalPath?: string;
}

export interface SeasonsResponse {
    teamId: string;
    currentSeasonId: string;
    currentSeason: CompanionSeason | null;
    defaultSeasonId: string;
    seasons: CompanionSeason[];
}

export interface CompanionFetchResult {
    teamId: string;
    seasonId: string;
    bossCount: number;
    raidPlanCount: number;
    imageCount: number;
    fetchedAt: string;
    dataLua: string;
}

const COMPANION_INTERFACE_PATH = `Interface/Addons/${NHF_COMPANION_ADDON_NAME}`;

function buildExternalUrl(path: string, seasonId?: string): string {
    const url = new URL(path, PUBLIC_EXTERNAL_API_HOST);
    if (seasonId?.trim()) {
        url.searchParams.set('seasonId', seasonId.trim());
    }
    return url.toString();
}

async function fetchExternalJson<T>(url: string, apiKey: string): Promise<T> {
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
    });

    if (response.status === 401) {
        throw new Error('Invalid or revoked API key. Generate a new key in Profile → Companion API Keys.');
    }

    if (!response.ok) {
        let message = `Request failed (${response.status})`;
        try {
            const body = await response.json();
            if (body?.error) {
                message = body.error;
            }
        } catch {
            // ignore parse errors
        }
        throw new Error(message);
    }

    return response.json() as Promise<T>;
}

async function getCompanionAddonDir(wowFolder: string): Promise<string> {
    const addonsDir = await getAddonsDir(wowFolder.trim());
    return `${addonsDir}/${NHF_COMPANION_ADDON_NAME}`;
}

function sanitizePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getImageExtension(imageUrl: string): string {
    try {
        const pathname = new URL(imageUrl).pathname;
        const match = pathname.match(/(\.[a-zA-Z0-9]+)$/);
        if (match) {
            const ext = match[1].toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.blp'].includes(ext)) {
                return ext;
            }
        }
    } catch {
        // ignore invalid URLs
    }
    return '.png';
}

function getBossImageFilename(bossId: string, imageUrl: string): string {
    try {
        const pathname = new URL(imageUrl).pathname;
        const baseName = pathname.split('/').pop();
        if (baseName) {
            const sanitized = sanitizePathSegment(baseName);
            if (sanitized.length > 0) {
                return sanitized;
            }
        }
    } catch {
        // ignore invalid URLs
    }

    return `${sanitizePathSegment(bossId)}${getImageExtension(imageUrl)}`;
}

function toCompanionImagePath(filename: string): string {
    return `${COMPANION_INTERFACE_PATH}/Images/${filename}`;
}

interface BossImageInfo {
    path: string;
    size?: ImageSize;
}

async function downloadBossImage(imageUrl: string): Promise<Uint8Array | null> {
    try {
        const response = await fetch(imageUrl, { method: 'GET' });
        if (!response.ok) {
            return null;
        }

        return new Uint8Array(await response.arrayBuffer());
    } catch {
        return null;
    }
}

async function downloadBossImages(
    addonDir: string,
    bosses: SeasonBoss[],
): Promise<Map<string, BossImageInfo>> {
    const imagesDir = `${addonDir}/Images`;
    await clearDirectory(imagesDir);

    const imageInfoByBossId = new Map<string, BossImageInfo>();
    const usedFilenames = new Set<string>();

    const downloads = bosses.map(async (boss) => {
        const imageUrl = boss.imageUrl?.trim();
        if (!imageUrl) {
            return;
        }

        let filename = getBossImageFilename(boss.bossId, imageUrl);
        if (usedFilenames.has(filename)) {
            const extension = getImageExtension(imageUrl);
            const stem = filename.replace(/\.[^.]+$/, '');
            filename = `${stem}-${sanitizePathSegment(boss.bossId)}${extension}`;
        }

        const imageBytes = await downloadBossImage(imageUrl);
        if (!imageBytes || imageBytes.length === 0) {
            return;
        }

        const size = getImageSize(imageBytes);

        await writeBinaryFile(`${imagesDir}/${filename}`, imageBytes);
        usedFilenames.add(filename);
        imageInfoByBossId.set(boss.bossId, {
            path: toCompanionImagePath(filename),
            ...(size ? { size } : {}),
        });
    });

    await Promise.all(downloads);
    return imageInfoByBossId;
}

type BossCatalogEntry = Omit<SeasonBoss, 'imageUrl'>;

function buildBossCatalog(
    bosses: SeasonBoss[],
    imageInfoByBossId: Map<string, BossImageInfo>,
): BossCatalogEntry[] {
    return bosses.map((boss) => {
        const { imageUrl: _imageUrl, ...rest } = boss;
        const imageInfo = imageInfoByBossId.get(boss.bossId);
        return imageInfo
            ? {
                  ...rest,
                  imagePath: imageInfo.path,
                  ...(imageInfo.size ? { imageSize: imageInfo.size } : {}),
              }
            : rest;
    });
}

function enrichWithBossCatalog<T extends { bossId: string }>(
    entry: T,
    catalogById: Map<string, BossCatalogEntry>,
): T & {
    bossName?: string;
    journalEncounterId?: number | null;
    dungeonEncounterId?: number | null;
    imagePath?: string;
    imageSize?: ImageSize;
} {
    const catalog = catalogById.get(entry.bossId);
    if (!catalog) {
        return entry;
    }

    return {
        ...entry,
        bossName: catalog.name,
        journalEncounterId: catalog.journalEncounterId,
        dungeonEncounterId: catalog.dungeonEncounterId,
        ...(catalog.imagePath ? { imagePath: catalog.imagePath } : {}),
        ...(catalog.imageSize ? { imageSize: catalog.imageSize } : {}),
    };
}

const RAID_PLAN_IMAGES_DIR = 'RaidPlans';
const RAID_PLAN_MANIFEST_FILE = 'images.json';

// Manifest maps cached filename -> image size (or null when the size is unknown),
// so cache hits keep their size without re-reading the image bytes.
type RaidPlanImageManifest = Record<string, ImageSize | null>;

function getRaidPlanImageFilename(imageUrl: string): string {
    try {
        const pathname = new URL(imageUrl).pathname;
        let segments = pathname.split('/').filter(Boolean);
        if (segments[0]?.toLowerCase() === 'images') {
            segments = segments.slice(1);
        }
        if (segments[0]?.toLowerCase() === 'raid-plans') {
            segments = segments.slice(1);
        }
        if (segments[0]?.toLowerCase() === 'media') {
            segments = segments.slice(1);
        }
        const filename = segments.map(sanitizePathSegment).join('_');
        if (filename.length > 0) {
            return filename;
        }
    } catch {
        // ignore invalid URLs
    }
    return `${sanitizePathSegment(imageUrl)}${getImageExtension(imageUrl)}`;
}

function toRaidPlanImagePath(filename: string): string {
    return `${COMPANION_INTERFACE_PATH}/${RAID_PLAN_IMAGES_DIR}/${filename}`;
}

async function readRaidPlanManifest(imagesDir: string): Promise<RaidPlanImageManifest> {
    try {
        const raw = await readTextFile(`${imagesDir}/${RAID_PLAN_MANIFEST_FILE}`);
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as RaidPlanImageManifest;
        }
    } catch {
        // missing or unreadable manifest -> start fresh
    }
    return {};
}

function getElementIconUrl(element: unknown): string | null {
    if (!element || typeof element !== 'object') {
        return null;
    }

    const el = element as Record<string, unknown>;
    if (el.type !== 'icon') {
        return null;
    }

    const icon = el.icon;
    if (!icon || typeof icon !== 'object') {
        return null;
    }

    const iconUrl = (icon as Record<string, unknown>).iconUrl;
    return typeof iconUrl === 'string' && iconUrl.trim() ? iconUrl.trim() : null;
}

function addRaidPlanImageUrl(urls: Set<string>, value: unknown): void {
    if (typeof value === 'string' && value.trim()) {
        urls.add(value.trim());
    }
}

function collectRaidPlanImageUrls(
    boards: RaidPlanBoard[],
    assets?: RaidPlansAssets,
): Set<string> {
    const urls = new Set<string>();

    if (assets) {
        for (const item of assets.markers ?? []) {
            addRaidPlanImageUrl(urls, item.iconUrl);
        }
        for (const item of assets.roles ?? []) {
            addRaidPlanImageUrl(urls, item.iconUrl);
        }
        for (const item of assets.classes ?? []) {
            addRaidPlanImageUrl(urls, item.iconUrl);
        }
        for (const item of assets.abilities ?? []) {
            addRaidPlanImageUrl(urls, item.iconUrl);
        }
        for (const item of assets.media ?? []) {
            addRaidPlanImageUrl(urls, item.url);
        }
    }

    for (const board of boards) {
        for (const slide of board.slides ?? []) {
            addRaidPlanImageUrl(urls, slide.backgroundUrl);

            for (const element of slide.elements ?? []) {
                const iconUrl = getElementIconUrl(element);
                if (iconUrl) {
                    urls.add(iconUrl);
                }
            }
        }
    }

    return urls;
}

async function downloadRaidPlanImages(
    addonDir: string,
    boards: RaidPlanBoard[],
    assets?: RaidPlansAssets,
): Promise<Map<string, BossImageInfo>> {
    const imageInfoByUrl = new Map<string, BossImageInfo>();
    const urls = collectRaidPlanImageUrls(boards, assets);

    if (urls.size === 0) {
        return imageInfoByUrl;
    }

    const imagesDir = `${addonDir}/${RAID_PLAN_IMAGES_DIR}`;
    const manifest = await readRaidPlanManifest(imagesDir);

    await Promise.all(
        [...urls].map(async (url) => {
            const filename = getRaidPlanImageFilename(url);
            const filePath = `${imagesDir}/${filename}`;

            const cachedSize = manifest[filename];
            if (cachedSize !== undefined && (await fileExists(filePath))) {
                imageInfoByUrl.set(url, {
                    path: toRaidPlanImagePath(filename),
                    ...(cachedSize ? { size: cachedSize } : {}),
                });
                return;
            }

            const imageBytes = await downloadBossImage(url);
            if (!imageBytes || imageBytes.length === 0) {
                return;
            }

            const size = getImageSize(imageBytes);
            await writeBinaryFile(filePath, imageBytes);
            manifest[filename] = size ?? null;
            imageInfoByUrl.set(url, {
                path: toRaidPlanImagePath(filename),
                ...(size ? { size } : {}),
            });
        }),
    );

    await writeTextFile(
        `${imagesDir}/${RAID_PLAN_MANIFEST_FILE}`,
        JSON.stringify(manifest, null, 2),
    );

    return imageInfoByUrl;
}

function withElementIconPaths(
    elements: unknown[] | undefined,
    imageInfoByUrl: Map<string, BossImageInfo>,
): unknown[] | undefined {
    if (!elements) {
        return elements;
    }

    return elements.map((element) => {
        const iconUrl = getElementIconUrl(element);
        if (!iconUrl) {
            return element;
        }

        const imageInfo = imageInfoByUrl.get(iconUrl);
        if (!imageInfo) {
            return element;
        }

        const el = element as Record<string, unknown>;
        const { iconUrl: _iconUrl, ...iconRest } = el.icon as Record<string, unknown>;
        return {
            ...el,
            icon: {
                ...iconRest,
                iconPath: imageInfo.path,
                ...(imageInfo.size ? { iconSize: imageInfo.size } : {}),
            },
        };
    });
}

function withIconAssetPaths<T extends RaidPlanAssetIcon>(
    items: T[] | undefined,
    imageInfoByUrl: Map<string, BossImageInfo>,
): T[] | undefined {
    if (!items) {
        return items;
    }

    return items.map((item) => {
        const url = item.iconUrl?.trim();
        const { iconUrl: _iconUrl, ...rest } = item;
        if (!url) {
            return rest as T;
        }

        const imageInfo = imageInfoByUrl.get(url);
        if (!imageInfo) {
            return rest as T;
        }

        return {
            ...rest,
            iconPath: imageInfo.path,
            ...(imageInfo.size ? { iconSize: imageInfo.size } : {}),
        } as T;
    });
}

function withRaidPlanAssetPaths(
    assets: RaidPlansAssets | undefined,
    imageInfoByUrl: Map<string, BossImageInfo>,
): RaidPlansAssets | undefined {
    if (!assets) {
        return undefined;
    }

    return {
        markers: withIconAssetPaths(assets.markers, imageInfoByUrl),
        roles: withIconAssetPaths(assets.roles, imageInfoByUrl),
        classes: withIconAssetPaths(assets.classes, imageInfoByUrl),
        abilities: withIconAssetPaths(assets.abilities, imageInfoByUrl),
        media: assets.media?.map((item) => {
            const url = item.url?.trim();
            const { url: _url, ...rest } = item;
            if (!url) {
                return rest;
            }

            const imageInfo = imageInfoByUrl.get(url);
            if (!imageInfo) {
                return rest;
            }

            return {
                ...rest,
                filePath: imageInfo.path,
                ...(imageInfo.size ? { fileSize: imageInfo.size } : {}),
            };
        }),
    };
}

function withRaidPlanImagePaths(
    boards: RaidPlanBoard[],
    imageInfoByUrl: Map<string, BossImageInfo>,
): RaidPlanBoard[] {
    return boards.map((board) => ({
        ...board,
        slides: (board.slides ?? []).map((slide) => {
            const { backgroundUrl, ...rest } = slide;
            const url = typeof backgroundUrl === 'string' ? backgroundUrl.trim() : '';
            const imageInfo = url ? imageInfoByUrl.get(url) : undefined;
            const elements = withElementIconPaths(slide.elements, imageInfoByUrl);

            return {
                ...rest,
                ...(imageInfo
                    ? {
                          backgroundPath: imageInfo.path,
                          ...(imageInfo.size ? { backgroundSize: imageInfo.size } : {}),
                      }
                    : {}),
                ...(elements ? { elements } : {}),
            };
        }),
    }));
}

export async function fetchCompanionSeasons(
    externalApiKey: string,
): Promise<SeasonsResponse> {
    const trimmedKey = externalApiKey.trim();
    if (!trimmedKey) {
        throw new Error('Companion API key is required.');
    }

    return fetchExternalJson<SeasonsResponse>(
        buildExternalUrl('/api/external/v1/seasons'),
        trimmedKey,
    );
}

export async function fetchAndWriteCompanionAddon(
    wowFolder: string,
    externalApiKey: string,
    seasonId?: string,
): Promise<CompanionFetchResult> {
    const trimmedKey = externalApiKey.trim();
    if (!trimmedKey) {
        throw new Error('Companion API key is required.');
    }

    if (!wowFolder?.trim()) {
        throw new Error('Set WoW folder in Addon Manager first.');
    }

    const [season, rosters, assignmentNotes, raidPlans] = await Promise.all([
        fetchExternalJson<SeasonResponse>(
            buildExternalUrl('/api/external/v1/season', seasonId),
            trimmedKey,
        ),
        fetchExternalJson<RostersResponse>(
            buildExternalUrl('/api/external/v1/rosters', seasonId),
            trimmedKey,
        ),
        fetchExternalJson<AssignmentNotesResponse>(
            buildExternalUrl('/api/external/v1/assignment-notes', seasonId),
            trimmedKey,
        ),
        fetchExternalJson<RaidPlansResponse>(
            buildExternalUrl('/api/external/v1/raid-plans', seasonId),
            trimmedKey,
        ).catch((error) => {
            // Older backends may not expose raid plans yet; keep the rest of the sync working.
            console.warn('Failed to fetch raid plans:', error);
            return null;
        }),
    ]);

    const addonDir = await getCompanionAddonDir(wowFolder.trim());
    const imageInfoByBossId = await downloadBossImages(addonDir, season.bosses ?? []);
    const bossCatalog = buildBossCatalog(season.bosses ?? [], imageInfoByBossId);
    const catalogById = new Map(bossCatalog.map((boss) => [boss.bossId, boss]));

    const rosterBosses = (rosters.bosses ?? []).map((boss) =>
        enrichWithBossCatalog(boss, catalogById),
    );
    const assignmentBosses = (assignmentNotes.bosses ?? []).map((boss) =>
        enrichWithBossCatalog(boss, catalogById),
    );

    const raidPlanImages = await downloadRaidPlanImages(
        addonDir,
        raidPlans?.boards ?? [],
        raidPlans?.assets,
    );
    const raidPlanBoards = withRaidPlanImagePaths(raidPlans?.boards ?? [], raidPlanImages);
    const raidPlanAssets = withRaidPlanAssetPaths(raidPlans?.assets, raidPlanImages);

    const fetchedAt = new Date().toISOString();
    const nhfData = {
        teamId: season.teamId,
        seasonId: season.seasonId,
        fetchedAt,
        season: {
            season: season.season,
            roster: season.roster,
            bosses: bossCatalog,
        },
        rosters: {
            roster: rosters.roster,
            bosses: rosterBosses,
        },
        assignmentNotes: {
            bosses: assignmentBosses,
        },
        raidPlans: {
            stage: raidPlans?.stage ?? { width: 1600, height: 900 },
            assets: raidPlanAssets,
            boards: raidPlanBoards,
        },
    };

    const dataLua = buildNHFDataLua(nhfData);

    await writeTextFile(`${addonDir}/NHFCompanion.toc`, NHF_COMPANION_TOC);
    await writeTextFile(`${addonDir}/Data.lua`, dataLua);

    return {
        teamId: season.teamId,
        seasonId: season.seasonId,
        bossCount: bossCatalog.length,
        raidPlanCount: raidPlanBoards.length,
        imageCount: imageInfoByBossId.size + raidPlanImages.size,
        fetchedAt,
        dataLua,
    };
}
