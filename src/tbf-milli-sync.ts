// TBF/FIBA/Milli maçlarının senkronu (TBL, EuroLeague, BGL, BSL, KBSL, FIBA BCL/EuroCup vb.).
// Kaynak iki Google E-Tablo (src/lib/sheets-source.ts) — Drive .xlsx değil, bu yüzden
// orchestrator.ts'teki Drive-dosya akışına (findAllSpreadsheets/detectChanges/download)
// girmiyor, kendi küçük döngüsü var. Sütun eşleme/satır ayrıştırma mantığı TEKRAR
// YAZILMADI: ham sheet satırları bellekte bir ExcelJS Workbook'a yüklenip mevcut
// `parseWorkbook` (match-parser.ts) çağrılıyor — böylece "KATEGORİ" sütunu, çok-sütunlu
// görevli alanları, maç adı çıkarma gibi tüm kurallar iki kaynak arasında birebir aynı
// kalıyor (CLAUDE.md: aynı mantık iki yerde ayrı kod olarak yaşamasın).
//
// ligTuru sınıflandırması EKSTRA KOD GEREKTİRMİYOR: parseFileMetadata (match-parser.ts)
// dosya adında "TBF"/"FIBA"/"MİLLİ" geçince zaten ligTuru="TBF / MİLLİ" veriyor —
// sheet başlıkları ("TBF-FIBA-MİLLİ MAÇLAR ...") doğal olarak bu dalı tetikliyor.
//
// kategori alanı sheet'teki KATEGORİ sütunundan (BGL/BSL/TBL/EUROLEAGUE/FIBA BCL/...) HAM
// olarak geliyor — kullanıcı talebi: "orda yazan kategori neyse sisteme onu alacaksın".
// Web tarafında bu zaten mevcut dinamik `kategoriler[]` ödeme akışına (lib/matches/fee.ts)
// otomatik düşüyor, ek bir alan/kart GEREKMEDİ (2026-10-20'de doğrulandı).

import type ExcelJS from "exceljs";
import { readTbfMilliSheets, SheetTabRaw } from "./lib/sheets-source";
import { parseWorkbook, MatchData } from "./lib/match-parser";
import {
    upsertDriveFile,
    upsertParsedMatches,
    writeSyncLog,
    acquireLock,
    releaseLock,
    detectAndMarkCancelledMatches,
    CancelledMatchInfo,
    ShiftedAssignmentInfo,
    parseTarihDate,
    getDriveFileFingerprint,
    markDriveFileFingerprint,
} from "./db-writer";
import { buildUserAssignments, NewAssignmentInfo } from "./user-matcher";
import { getSeasonCutoffDate, resolveCurrentSeasonKey, getSyncMode, isForceSync } from "./config";
import { computeTabFingerprint, shouldSkipTab } from "./lib/tbf-milli-fingerprint";
import { logger } from "./logger";
import { DriveSpreadsheet } from "./lib/google-drive";

export const TBF_MILLI_FOLDER_KEY = "tbf-milli-sheets";

export interface TbfMilliSyncResult {
    newAssignments: NewAssignmentInfo[];
    cancellations: CancelledMatchInfo[];
    shifted: ShiftedAssignmentInfo[];
}

// Sheet verisini, bir Drive .xlsx dosyasıymış gibi parseWorkbook'a yedirmek için
// bellekte tek-sayfalı bir workbook kurar. Tarih/saat hücreleri sheets-source.ts'te
// zaten "DD.MM.YYYY"/"HH:MM" string'ine çevrildi, burada sadece worksheet'e yazılıyor.
async function buildInMemoryWorkbook(tab: SheetTabRaw): Promise<ExcelJS.Workbook> {
    const { default: ExcelJSRuntime } = await import("exceljs");
    const workbook = new ExcelJSRuntime.Workbook();
    const ws = workbook.addWorksheet(tab.tabTitle);
    ws.addRows(tab.rows);
    return workbook as unknown as ExcelJS.Workbook;
}

async function processTab(
    tab: SheetTabRaw,
    spreadsheetId: string,
    result: TbfMilliSyncResult
): Promise<{ matchesUpserted: number; assignmentsBuilt: number; skipped: boolean }> {
    if (tab.rows.length < 2) {
        logger.info("TBF/Milli sheet sekmesi boş, atlandı", { spreadsheetId, tab: tab.tabTitle });
        return { matchesUpserted: 0, assignmentsBuilt: 0, skipped: false };
    }

    // Sezon anahtarı ve kesim tarihi hem parmak izine hem aşağıdaki yazma adımlarına
    // lazım — bir kez okuyup ikisinde de kullanıyoruz.
    const seasonKey = await resolveCurrentSeasonKey();
    const seasonCutoff = await getSeasonCutoffDate();
    const pseudoFileId = `sheet:${spreadsheetId}`;

    // İçerik değişmediyse sekmeyi baştan işlemeyi (parse + ~500 atama + iptal taraması)
    // atlıyoruz. Parmak izi okuma/hesaplama hata verirse eski davranışa (tam işleme) düşer.
    let fingerprint: string | null = null;
    let prevFingerprint: string | null = null;
    try {
        fingerprint = computeTabFingerprint(tab, {
            seasonKey,
            cutoffIso: seasonCutoff.toISOString(),
        });
        prevFingerprint = await getDriveFileFingerprint(pseudoFileId);
    } catch (err: any) {
        logger.warn("TBF/Milli parmak izi okunamadı, sekme tam işlenecek", {
            spreadsheetId, tab: tab.tabTitle, error: err?.message,
        });
        prevFingerprint = null;
    }

    // Drive dosyalarındaki zorlama kuralıyla aynı (orchestrator.ts)
    const force = getSyncMode() === "archive-full" || isForceSync();
    if (shouldSkipTab(prevFingerprint, fingerprint, force)) {
        logger.info("TBF/Milli sheet değişmedi, atlandı", { spreadsheetId, tab: tab.tabTitle });
        return { matchesUpserted: 0, assignmentsBuilt: 0, skipped: true };
    }

    const workbook = await buildInMemoryWorkbook(tab);
    const fileName = tab.spreadsheetTitle;
    let matches: MatchData[] = parseWorkbook(workbook, fileName);

    logger.info("TBF/Milli sheet parse edildi", {
        spreadsheetId, tab: tab.tabTitle, matchCount: matches.length,
    });

    // Sheet'in kendisini sözde bir "Drive dosyası" gibi kaydediyoruz — ParsedMatch.driveFileId
    // ilişkisi ve detectAndMarkCancelledMatches aynı mekanizmayı bu sahte dosya kimliğiyle kullanabilsin diye.
    // Gerçek bir Drive dosyası olmadığı için md5Checksum/modifiedTime yok; içerik değişikliğini
    // sekme parmak iziyle (lastProcessedMd5 kolonu) yakalıyoruz: değişmeyen sekme atlanır,
    // değişen sekme baştan okunup yeniden yazılır.
    const pseudoFile: DriveSpreadsheet = {
        id: pseudoFileId,
        name: `${fileName} (${tab.tabTitle})`,
        mimeType: "application/vnd.google-apps.spreadsheet",
    };
    // DİKKAT (sıralama bilinçli): upsertDriveFile lastProcessedMd5'i null'a çeker. Parmak izini
    // ancak işlemin EN SONUNDA yazıyoruz; arada bir hata fırlarsa kolon null kalır ve bir
    // sonraki çalışma sekmeyi tam işler — yarım kalan işlem asla "güncel" sayılmaz.
    const driveFileDbId = await upsertDriveFile(pseudoFile, TBF_MILLI_FOLDER_KEY, matches.length);

    if (matches.length === 0) {
        if (fingerprint) await markDriveFileFingerprint(driveFileDbId, fingerprint);
        return { matchesUpserted: 0, assignmentsBuilt: 0, skipped: false };
    }

    // Sezon kesimi — web'in sildiği eski sezon verisi burada da geri gelmesin
    // (orchestrator.ts'teki aynı kural, bkz. CLAUDE.md Prisma Kuralları).
    matches = matches.filter(m => {
        const d = parseTarihDate(m.tarih);
        return !(d && d < seasonCutoff);
    });
    if (matches.length === 0) {
        if (fingerprint) await markDriveFileFingerprint(driveFileDbId, fingerprint);
        return { matchesUpserted: 0, assignmentsBuilt: 0, skipped: false };
    }

    const matchIds = await upsertParsedMatches(matches, driveFileDbId, seasonKey);

    const { assignmentCount, newAssignments } = await buildUserAssignments(matches, matchIds);
    result.newAssignments.push(...newAssignments);

    const scan = await detectAndMarkCancelledMatches(driveFileDbId, matches);
    result.cancellations.push(...scan.cancelled);
    result.shifted.push(...scan.shifted);

    // Her şey hatasız bittiyse parmak izini kaydet (bkz. yukarıdaki sıralama notu).
    if (fingerprint) await markDriveFileFingerprint(driveFileDbId, fingerprint);

    return { matchesUpserted: matchIds.length, assignmentsBuilt: assignmentCount, skipped: false };
}

export async function runTbfMilliSync(): Promise<TbfMilliSyncResult> {
    const result: TbfMilliSyncResult = { newAssignments: [], cancellations: [], shifted: [] };

    const currentId = process.env.TBF_MILLI_CURRENT_SHEET_ID;
    const archiveId = process.env.TBF_MILLI_ARCHIVE_SHEET_ID;
    if (!currentId || !archiveId) {
        logger.warn("TBF_MILLI_CURRENT_SHEET_ID / TBF_MILLI_ARCHIVE_SHEET_ID ayarlanmamış — TBF/Milli sync atlandı");
        return result;
    }

    const locked = await acquireLock(TBF_MILLI_FOLDER_KEY);
    if (!locked) {
        logger.warn("TBF/Milli sync atlandı — kilitli");
        return result;
    }

    const startedAt = new Date();
    const startMs = Date.now();
    const errors: string[] = [];
    let matchesUpserted = 0;
    let assignmentsBuilt = 0;
    let filesChanged = 0;
    let success = false;

    try {
        const { current, archive } = await readTbfMilliSheets();

        const currentStats = await processTab(current, currentId, result);
        matchesUpserted += currentStats.matchesUpserted;
        assignmentsBuilt += currentStats.assignmentsBuilt;
        if (!currentStats.skipped) filesChanged++;

        const archiveStats = await processTab(archive, archiveId, result);
        matchesUpserted += archiveStats.matchesUpserted;
        assignmentsBuilt += archiveStats.assignmentsBuilt;
        if (!archiveStats.skipped) filesChanged++;

        success = true;
        logger.info("TBF/Milli sync tamamlandı", {
            matchesUpserted, assignmentsBuilt, filesChanged, skippedTabs: 2 - filesChanged,
            durationMs: Date.now() - startMs,
        });
    } catch (err: any) {
        const errMsg = err?.message || "Bilinmeyen hata";
        logger.error("TBF/Milli sync hatası", { error: errMsg });
        errors.push(`Kritik hata: ${errMsg}`);
        success = false;
    } finally {
        await releaseLock(TBF_MILLI_FOLDER_KEY, success);
        await writeSyncLog({
            syncType: TBF_MILLI_FOLDER_KEY,
            folderKey: TBF_MILLI_FOLDER_KEY,
            filesChecked: 2,
            filesChanged,
            matchesUpserted,
            assignmentsBuilt,
            durationMs: Date.now() - startMs,
            errors,
            startedAt,
        });
    }

    return result;
}
