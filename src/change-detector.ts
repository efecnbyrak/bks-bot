import { db } from "./db";
import { DriveSpreadsheet } from "./lib/google-drive";
import { logger } from "./logger";

export interface ChangeResult {
    toProcess: DriveSpreadsheet[];
    unchanged: DriveSpreadsheet[];
}

/**
 * Detects which files have changed since last processing.
 *
 * Excel files: compared by md5Checksum.
 * Google Sheets (no md5): compared by modifiedTime.
 * New files (not in drive_files table): always processed.
 * archive-full mode: all files processed regardless of change.
 */
export async function detectChanges(
    files: DriveSpreadsheet[],
    forceAll: boolean = false
): Promise<ChangeResult> {
    if (forceAll) {
        logger.info("archive-full modunda — tüm dosyalar işlenecek", { count: files.length });
        return { toProcess: files, unchanged: [] };
    }

    const fileIds = files.map(f => f.id);
    const existing = await db.driveFile.findMany({
        where: { driveFileId: { in: fileIds } },
        select: {
            driveFileId: true,
            lastProcessedMd5: true,
            modifiedTime: true,
        },
    });

    type DriveFileRow = { driveFileId: string; lastProcessedMd5: string | null; modifiedTime: Date | null };
    const existingMap = new Map<string, DriveFileRow>(existing.map((e: DriveFileRow) => [e.driveFileId, e]));

    const toProcess: DriveSpreadsheet[] = [];
    const unchanged: DriveSpreadsheet[] = [];

    for (const file of files) {
        const record = existingMap.get(file.id);

        if (!record) {
            logger.info("Yeni dosya — işlenecek", { fileName: file.name, fileId: file.id });
            toProcess.push(file);
            continue;
        }

        const isGoogleSheet = file.mimeType === "application/vnd.google-apps.spreadsheet";

        if (isGoogleSheet) {
            // Google Sheets has no stable md5 — use modifiedTime
            if (!file.modifiedTime || !record.modifiedTime) {
                toProcess.push(file);
                continue;
            }
            const fileTime = new Date(file.modifiedTime).getTime();
            const recordTime = new Date(record.modifiedTime).getTime();
            if (fileTime > recordTime) {
                logger.info("Sheets değişti (modifiedTime) — işlenecek", { fileName: file.name });
                toProcess.push(file);
            } else {
                unchanged.push(file);
            }
        } else {
            // Excel file — use md5
            if (file.md5Checksum && file.md5Checksum !== record.lastProcessedMd5) {
                logger.info("Excel değişti (md5) — işlenecek", { fileName: file.name });
                toProcess.push(file);
            } else {
                unchanged.push(file);
            }
        }
    }

    logger.info("Değişiklik tespiti tamamlandı", {
        total: files.length,
        toProcess: toProcess.length,
        unchanged: unchanged.length,
    });

    return { toProcess, unchanged };
}
