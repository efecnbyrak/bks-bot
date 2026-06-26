import { findAllSpreadsheets } from "./lib/google-drive";
import { parseWorkbook } from "./lib/match-parser";
import { detectChanges } from "./change-detector";
import {
    upsertDriveFile,
    upsertParsedMatches,
    writeSyncLog,
    acquireLock,
    releaseLock,
    detectAndMarkCancelledMatches,
    createCancellationAnnouncements,
} from "./db-writer";
import { buildUserAssignments } from "./user-matcher";
import { sendCancellationPush } from "./lib/push-sender";
import { getFolderConfig, getFolderIdString, getSyncMode, isForceSync } from "./config";
import { logger } from "./logger";
import { db } from "./db";

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            const isTransient =
                err?.code === 429 ||
                (typeof err?.code === "number" && err.code >= 500) ||
                err?.message?.includes("quota") ||
                err?.message?.includes("ECONNRESET");

            if (attempt === maxAttempts || !isTransient) throw err;

            const delayMs = 2000 * Math.pow(2, attempt - 1);
            logger.warn(`Deneme ${attempt} başarısız, ${delayMs}ms sonra tekrar`, { error: err.message });
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw new Error("Unreachable");
}

export async function runSync(folderKey: string): Promise<void> {
    // Verify DB is reachable before doing anything — throws on connection failure
    try {
        await db.$queryRaw`SELECT 1`;
    } catch (err: any) {
        const msg: string = err?.message ?? "";
        logger.warn("DB bağlantısı kurulamadı — sync atlandı", { error: msg });
        throw err; // index.ts'deki isDbConnError handler'ı yakalar
    }

    const startedAt = new Date();
    const startMs = Date.now();
    const errors: string[] = [];

    // Jitter: son başarılı sync'ten beri [12,18) dk geçmediyse atla.
    // FORCE_SYNC=true ise (elle tetikleme) jitter bypass edilir.
    const syncState = await db.workerSyncState.findUnique({ where: { folderKey } });
    if (syncState?.lastSuccessAt && !isForceSync()) {
        const elapsedMin = (Date.now() - syncState.lastSuccessAt.getTime()) / 60000;
        const requiredMin = 12 + Math.random() * 6; // [12, 18)
        if (elapsedMin < requiredMin) {
            logger.info("Jitter: henüz erken — sync atlandı", {
                folderKey,
                elapsedMin: Math.round(elapsedMin * 10) / 10,
                requiredMin: Math.round(requiredMin * 10) / 10,
            });
            return;
        }
    }

    const locked = await acquireLock(folderKey);
    if (!locked) {
        logger.warn("Sync atlandı — klasör kilitli", { folderKey });
        return;
    }

    let filesChecked = 0;
    let filesChanged = 0;
    let matchesUpserted = 0;
    let assignmentsBuilt = 0;
    let success = false;

    try {
        const cfg = getFolderConfig(folderKey);
        const folderIdStr = getFolderIdString(folderKey);
        const forceAll = getSyncMode() === "archive-full";

        logger.info("Sync başlıyor", { folderKey, maxDepth: cfg.maxDepth, forceAll });

        // 1. Drive'dan dosya listesini al
        const { files, errors: driveErrors } = await withRetry(() =>
            findAllSpreadsheets([folderIdStr], cfg.maxDepth)
        );

        errors.push(...driveErrors);
        filesChecked = files.length;

        logger.info("Drive tarama tamamlandı", { folderKey, filesFound: files.length, driveErrors: driveErrors.length });

        if (files.length === 0) {
            logger.warn("Hiç dosya bulunamadı", { folderKey });
            success = true;
            return;
        }

        // 2. Değişen dosyaları tespit et
        const { toProcess } = await detectChanges(files, forceAll);
        filesChanged = toProcess.length;

        if (toProcess.length === 0) {
            logger.info("Değişen dosya yok — tamamlandı", { folderKey });
            success = true;
            return;
        }

        // 3. Değişen dosyaları indir, parse et, DB'ye yaz
        // Lazy-load ExcelJS only when there are files to process
        const { default: ExcelJSRuntime } = await import("exceljs");

        for (const file of toProcess) {
            try {
                logger.info("Dosya işleniyor", { fileName: file.name, fileId: file.id });

                const buffer = await withRetry(() =>
                    import("./lib/google-drive").then(m => m.downloadAsXlsx(file.id, file.mimeType, file.resourceKey))
                );

                const workbook = new ExcelJSRuntime.Workbook();
                await workbook.xlsx.load(new Uint8Array(buffer) as any);

                const matches = parseWorkbook(workbook as any, file.name);

                logger.info("Parse tamamlandı", { fileName: file.name, matchCount: matches.length });

                // DB'ye dosya kaydını yaz/güncelle
                const driveFileDbId = await upsertDriveFile(file, folderKey, matches.length);

                if (matches.length === 0) continue;

                // Maçları yaz
                const matchIds = await upsertParsedMatches(matches, driveFileDbId, folderKey);
                matchesUpserted += matchIds.length;

                // Kullanıcı atamalarını oluştur
                const assigned = await buildUserAssignments(matches, matchIds);
                assignmentsBuilt += assigned;

                // İptal tespiti: bu dosyadaki atamalar kontrol edilir;
                // arşive taşıma değil, hakem listesinden isim silinmesi iade sayılır
                const cancelled = await detectAndMarkCancelledMatches(driveFileDbId, matches);
                if (cancelled.length > 0) {
                    // Şimdilik iade bildirimleri kapatıldı — açmak için aşağıdaki yorumları kaldır
                    // await createCancellationAnnouncements(cancelled);
                    // for (const c of cancelled) {
                    //     if (c.affectedUserIds.length > 0) {
                    //         await sendCancellationPush(c.affectedUserIds, c.macAdi, c.tarih);
                    //     }
                    // }
                    logger.info("İptal tespit edildi (bildirim kapalı)", {
                        cancelledCount: cancelled.length,
                        affectedUsers: [...new Set(cancelled.flatMap(c => c.affectedUserIds))].length,
                    });
                }

            } catch (err: any) {
                const errMsg = err?.message || "Bilinmeyen hata";
                logger.error("Dosya işleme hatası", { fileName: file.name, error: errMsg });
                errors.push(`${file.name}: ${errMsg}`);

                // Hatalı dosyanın kaydını parseError ile güncelle
                try {
                    await upsertDriveFile(file, folderKey, 0, errMsg);
                } catch { /* ignore secondary error */ }
            }
        }

        success = true;
        logger.info("Sync başarıyla tamamlandı", {
            folderKey, filesChecked, filesChanged, matchesUpserted, assignmentsBuilt,
            durationMs: Date.now() - startMs,
        });

    } catch (err: any) {
        const errMsg = err?.message || "Bilinmeyen hata";
        logger.error("Sync kritik hata", { folderKey, error: errMsg });
        errors.push(`Kritik hata: ${errMsg}`);
        success = false;
    } finally {
        await releaseLock(folderKey, success);

        await writeSyncLog({
            syncType: getSyncMode() === "archive-full" ? "archive-full" : folderKey === "current" ? "current" : "archive",
            folderKey,
            filesChecked,
            filesChanged,
            matchesUpserted,
            assignmentsBuilt,
            durationMs: Date.now() - startMs,
            errors,
            startedAt,
        });
    }
}
