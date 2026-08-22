export interface FolderConfig {
    id: string;
    resourceKey?: string;
    maxDepth: number;
}

// Ana arşiv klasörü — içinde "2025-2026", "2026-2027" gibi sezon adlı alt klasörler barındırır.
// Geçmiş sezonlara elle erişmek için sync-archives-once.yml workflow'u kullanılır.
export const ARCHIVE_ROOT_ID = "1wW7_ITBS2JWRHQqpBH1xq926070U2WQP";

export const DRIVE_FOLDERS: Record<string, FolderConfig> = {
    current: {
        id: "0ByPao_qBUjN-YXJZSG5Fancybmc",
        resourceKey: "0-MKTgAd4XnpTp7S5flJBKuA",
        maxDepth: 0,
    },
};

// findLatestSeasonFolder() ile tespit edilen güncel sezonu DRIVE_FOLDERS'a kaydeder,
// böylece geri kalan kod (getFolderConfig, lock, sync log) folderKey'i normal bir
// statik anahtarmış gibi kullanmaya devam edebilir.
export function registerFolder(key: string, cfg: FolderConfig): void {
    DRIVE_FOLDERS[key] = cfg;
}

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

// Sezon geçişi Ağustos'ta oluyor: Ağustos ve sonrasında "bu yıl - gelecek yıl",
// öncesinde "geçen yıl - bu yıl" sezonundayız sayılır (örn. 2026-08-23 -> "2026-2027").
const SEASON_START_MONTH = 8; // Ağustos (1-12)

export function getCurrentSeasonKey(date: Date = new Date()): string {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const startYear = month >= SEASON_START_MONTH ? year : year - 1;
    return `${startYear}-${startYear + 1}`;
}

// SYNC_FOLDER_KEY virgülle ayrılmış birden fazla anahtar içerebilir (örn. "current,2025-2026").
// "current" DRIVE_FOLDERS'ta statik olarak tanımlı; sezon adı (örn. "2025-2026") verilirse
// ARCHIVE_ROOT_ID altında o isimde bir klasör aranıp bulunursa DRIVE_FOLDERS'a kaydedilir.
// Bu sayede federasyonun sezon geçişinde güncel maçları arşive de eklemesi durumu karşılanır
// ve elle sync-archives-once.yml çalıştırıldığında geçmiş sezonlara da erişilebilir.
export async function resolveSyncFolderKeys(): Promise<string[]> {
    const raw = process.env.SYNC_FOLDER_KEY;
    if (!raw) throw new Error("SYNC_FOLDER_KEY env var tanımlı değil.");
    const keys = raw.split(",").map(k => k.trim()).filter(Boolean);

    const { listSeasonFolders } = await import("./lib/google-drive");
    let seasonCache: { key: string; id: string; year: number }[] | null = null;

    for (const key of keys) {
        if (DRIVE_FOLDERS[key]) continue;
        if (key === "latest-season") {
            seasonCache ??= await listSeasonFolders(ARCHIVE_ROOT_ID);
            if (seasonCache.length === 0) throw new Error(`Arşiv kökünde (${ARCHIVE_ROOT_ID}) sezon klasörü bulunamadı.`);

            // Önce tarihe göre hesaplanan sezonu ara (örn. bugün Ağustos 2026 ise "2026-2027").
            // Klasör henüz oluşturulmamışsa (federasyon geç açtıysa) Drive'daki en güncel yıla düş.
            const expectedKey = getCurrentSeasonKey();
            const exact = seasonCache.find(s => s.key === expectedKey);
            const chosen = exact ?? seasonCache.reduce((a, b) => (b.year > a.year ? b : a));

            registerFolder("latest-season", { id: chosen.id, maxDepth: 2 });
            continue;
        }
        seasonCache ??= await listSeasonFolders(ARCHIVE_ROOT_ID);
        const found = seasonCache.find(s => s.key === key);
        if (!found) throw new Error(`Geçersiz SYNC_FOLDER_KEY: "${key}" (arşiv kökünde böyle bir sezon klasörü yok)`);
        registerFolder(key, { id: found.id, maxDepth: 2 });
    }

    return keys;
}

// FORCE_SYNC=true ise jitter atlanır — elle tetiklemede kullanılır
export function isForceSync(): boolean {
    return process.env.FORCE_SYNC === "true";
}
