export interface FolderConfig {
    id: string;
    resourceKey?: string;
    maxDepth: number;
}

export const DRIVE_FOLDERS: Record<string, FolderConfig> = {
    current: {
        id: "0ByPao_qBUjN-YXJZSG5Fancybmc",
        resourceKey: "0-MKTgAd4XnpTp7S5flJBKuA",
        maxDepth: 0,
    },
    "2025-2026": {
        id: "1Tqtn2oN96UAyeARYtmYFGSfzkrSJOG9s",
        maxDepth: 2,
    },
    "2024-2025": {
        id: "12ugwc-i-fQEKbqfS-qbUtaYvz3ozTIsh",
        maxDepth: 2,
    },
    "2023-2024": {
        id: "1UyODoUB5Qsix6J-VqkD40OcmvFsBKTWm",
        maxDepth: 2,
    },
    "2022-2023": {
        id: "1h9aPtw5t_Q7WOyhx39LJAgMKbvixzI0k",
        maxDepth: 2,
    },
    "2021-2022": {
        id: "1-0-qvqZRfoVImZcgzHLgUwpAd35FaNZ4",
        maxDepth: 2,
    },
};

export function getFolderConfig(key: string): FolderConfig {
    const cfg = DRIVE_FOLDERS[key];
    if (!cfg) {
        throw new Error(`Bilinmeyen klasör anahtarı: "${key}". Geçerli anahtarlar: ${Object.keys(DRIVE_FOLDERS).join(", ")}`);
    }
    return cfg;
}

export function getFolderIdString(key: string): string {
    const cfg = getFolderConfig(key);
    if (cfg.resourceKey) return `${cfg.id}?resourcekey=${cfg.resourceKey}`;
    return cfg.id;
}

export function getSyncMode(): "normal" | "archive-full" {
    const mode = process.env.SYNC_MODE;
    return mode === "archive-full" ? "archive-full" : "normal";
}

export function getSyncFolderKey(): string {
    const key = process.env.SYNC_FOLDER_KEY;
    if (!key) throw new Error("SYNC_FOLDER_KEY env var tanımlı değil.");
    if (!DRIVE_FOLDERS[key]) throw new Error(`Geçersiz SYNC_FOLDER_KEY: "${key}"`);
    return key;
}

// FORCE_SYNC=true ise jitter atlanır — elle tetiklemede kullanılır
export function isForceSync(): boolean {
    return process.env.FORCE_SYNC === "true";
}
