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

// bks-web-system tarafında Süper Admin → Ayarlar'dan sezon başlangıç/bitiş
// tarihi elle girilebiliyor (SystemSetting: SEASON_START_DATE/SEASON_END_DATE,
// aynı DB'yi paylaşıyoruz). Girilmişse sezon anahtarı ("2026-2027" gibi) o
// tarihlerden hesaplanır — sezon takvimin dışında bir tarihte açılırsa (örn.
// 20 Kasım) admin panelden tek bir yerden değiştirilebilsin diye. Boş/geçersizse
// mevcut Ağustos-başlangıçlı takvim hesabına (getCurrentSeasonKey) fail-open
// düşülür.
async function getSeasonOverride(): Promise<{ startYear: number; endYear: number } | null> {
    try {
        const { db } = await import("./db");
        const rows = await db.systemSetting.findMany({
            where: { key: { in: ["SEASON_START_DATE", "SEASON_END_DATE"] } },
        });
        const startRaw = rows.find(r => r.key === "SEASON_START_DATE")?.value;
        const endRaw = rows.find(r => r.key === "SEASON_END_DATE")?.value;
        if (startRaw && endRaw) {
            const startDate = new Date(startRaw);
            const endDate = new Date(endRaw);
            if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
                return { startYear: startDate.getFullYear(), endYear: endDate.getFullYear() };
            }
        }
    } catch (e) {
        console.error("[CONFIG] SystemSetting okunamadı, takvim hesabına düşülüyor:", e);
    }
    return null;
}

export async function resolveCurrentSeasonKey(date: Date = new Date()): Promise<string> {
    const override = await getSeasonOverride();
    if (override) return `${override.startYear}-${override.endYear}`;
    return getCurrentSeasonKey(date);
}

// folderKey ("current", "latest-season" veya doğrudan sezon adı) ile o klasörün
// GERÇEK sezon adı ("2026-2027" gibi) arasındaki eşleşmeyi tutar. ParsedMatch.sezon
// alanına folderKey'in kendisi DEĞİL, buradan çözülen gerçek sezon adı yazılmalı —
// aksi halde bks-web-system tarafında "current"/"latest-season" ham string'leri
// alfabetik sıralamada yanlışlıkla "en güncel sezon" sanılıyor (2026-09-28'de
// tespit edilen hata, bkz. bks-web-system lib/matches/season.ts).
const FOLDER_SEASON_KEYS: Record<string, string> = {};

export function getSeasonKeyForFolder(folderKey: string): string {
    return FOLDER_SEASON_KEYS[folderKey] ?? folderKey;
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
        if (key === "current") {
            // DRIVE_FOLDERS["current"] statik tanımlı olduğu için aşağıdaki genel
            // "zaten kayıtlı" kontrolüyle atlanır — gerçek sezon adı burada ayrıca set edilir.
            FOLDER_SEASON_KEYS["current"] = await resolveCurrentSeasonKey();
        }
        if (DRIVE_FOLDERS[key]) continue;
        if (key === "latest-season") {
            seasonCache ??= await listSeasonFolders(ARCHIVE_ROOT_ID);
            if (seasonCache.length === 0) throw new Error(`Arşiv kökünde (${ARCHIVE_ROOT_ID}) sezon klasörü bulunamadı.`);

            // Önce tarihe göre hesaplanan sezonu ara (örn. bugün Ağustos 2026 ise "2026-2027").
            // Klasör henüz oluşturulmamışsa (federasyon geç açtıysa) Drive'daki en güncel yıla düş.
            const expectedKey = await resolveCurrentSeasonKey();
            const exact = seasonCache.find(s => s.key === expectedKey);
            const chosen = exact ?? seasonCache.reduce((a, b) => (b.year > a.year ? b : a));

            registerFolder("latest-season", { id: chosen.id, maxDepth: 2 });
            FOLDER_SEASON_KEYS["latest-season"] = chosen.key;
            continue;
        }
        seasonCache ??= await listSeasonFolders(ARCHIVE_ROOT_ID);
        const found = seasonCache.find(s => s.key === key);
        if (!found) throw new Error(`Geçersiz SYNC_FOLDER_KEY: "${key}" (arşiv kökünde böyle bir sezon klasörü yok)`);
        registerFolder(key, { id: found.id, maxDepth: 2 });
        FOLDER_SEASON_KEYS[key] = key;
    }

    return keys;
}

// FORCE_SYNC=true ise jitter atlanır — elle tetiklemede kullanılır
export function isForceSync(): boolean {
    return process.env.FORCE_SYNC === "true";
}
