import crypto from "crypto";
import { db } from "./db";
import { MatchData } from "./lib/match-parser";
import { DriveSpreadsheet } from "./lib/google-drive";
import { logger } from "./logger";

function computeMatchKey(match: MatchData): string {
    const hakemlerSorted = [...match.hakemler].sort().join("|");
    const masaSorted = [...match.masa_gorevlileri].sort().join("|");
    const raw = `${match.mac_adi}|${match.tarih}|${match.saat ?? ""}|${match.salon ?? ""}|${hakemlerSorted}|${masaSorted}`;
    return crypto.createHash("sha256").update(raw).digest("hex").substring(0, 32);
}

function parseTarihDate(tarih: string): Date | null {
    if (!tarih) return null;
    const match = tarih.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
    if (!match) return null;
    const [, day, month, year] = match;
    const d = new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00.000Z`);
    return isNaN(d.getTime()) ? null : d;
}

export async function upsertDriveFile(
    file: DriveSpreadsheet,
    folderKey: string,
    rowCount: number,
    parseError?: string
): Promise<number> {
    const record = await db.driveFile.upsert({
        where: { driveFileId: file.id },
        create: {
            driveFileId: file.id,
            driveFolderKey: folderKey,
            fileName: file.name,
            mimeType: file.mimeType,
            resourceKey: file.resourceKey,
            md5Checksum: file.md5Checksum,
            modifiedTime: file.modifiedTime ? new Date(file.modifiedTime) : null,
            lastProcessedAt: new Date(),
            lastProcessedMd5: file.md5Checksum ?? null,
            rowCount,
            parseError: parseError ?? null,
            isActive: true,
        },
        update: {
            fileName: file.name,
            md5Checksum: file.md5Checksum,
            modifiedTime: file.modifiedTime ? new Date(file.modifiedTime) : null,
            lastProcessedAt: new Date(),
            lastProcessedMd5: file.md5Checksum ?? null,
            rowCount,
            parseError: parseError ?? null,
            isActive: true,
        },
    });
    return record.id;
}

export async function upsertParsedMatches(
    matches: MatchData[],
    driveFileDbId: number,
    sezon: string
): Promise<number[]> {
    const ids: number[] = [];

    for (const match of matches) {
        const matchKey = computeMatchKey(match);
        const tarihDate = parseTarihDate(match.tarih);

        const record = await db.parsedMatch.upsert({
            where: { matchKey },
            create: {
                matchKey,
                macAdi: match.mac_adi,
                tarih: match.tarih,
                tarihDate,
                saat: match.saat ?? null,
                salon: match.salon ?? null,
                kategori: match.kategori,
                hafta: match.hafta ?? null,
                sezon,
                ligTuru: match.ligTuru,
                hakemler: match.hakemler,
                masaGorevlileri: match.masa_gorevlileri,
                saglikcilar: match.saglikcilar,
                istatistikciler: match.istatistikciler,
                gozlemciler: match.gozlemciler,
                sahaKomiserleri: match.sahaKomiserleri,
                kaynakDosya: match.kaynak_dosya,
                driveFileId: driveFileDbId,
            },
            update: {
                macAdi: match.mac_adi,
                tarih: match.tarih,
                tarihDate,
                saat: match.saat ?? null,
                salon: match.salon ?? null,
                kategori: match.kategori,
                hafta: match.hafta ?? null,
                sezon,
                ligTuru: match.ligTuru,
                hakemler: match.hakemler,
                masaGorevlileri: match.masa_gorevlileri,
                saglikcilar: match.saglikcilar,
                istatistikciler: match.istatistikciler,
                gozlemciler: match.gozlemciler,
                sahaKomiserleri: match.sahaKomiserleri,
                kaynakDosya: match.kaynak_dosya,
                driveFileId: driveFileDbId,
            },
        });

        ids.push(record.id);
    }

    logger.info("ParsedMatch upsert tamamlandı", { count: ids.length });
    return ids;
}

export async function upsertUserMatchAssignment(
    userId: number,
    matchId: number,
    role: string,
    nameInSpreadsheet: string
): Promise<void> {
    await db.userMatchAssignment.upsert({
        where: { userId_matchId: { userId, matchId } },
        create: { userId, matchId, role, nameInSpreadsheet },
        update: { role, nameInSpreadsheet },
    });
}

export async function writeSyncLog(params: {
    syncType: string;
    folderKey: string;
    filesChecked: number;
    filesChanged: number;
    matchesUpserted: number;
    assignmentsBuilt: number;
    durationMs: number;
    errors: string[];
    startedAt: Date;
}): Promise<void> {
    await db.workerSyncLog.create({
        data: {
            ...params,
            completedAt: new Date(),
        },
    });
}

export async function acquireLock(folderKey: string): Promise<boolean> {
    const now = new Date();
    const lockExpiry = new Date(now.getTime() + 10 * 60 * 1000); // 10 dakika

    const existing = await db.workerSyncState.findUnique({ where: { folderKey } });

    if (existing?.isLocked && existing.lockExpiresAt && existing.lockExpiresAt > now) {
        logger.warn("Klasör kilitli, atlanıyor", { folderKey, expiresAt: existing.lockExpiresAt });
        return false;
    }

    await db.workerSyncState.upsert({
        where: { folderKey },
        create: { folderKey, isLocked: true, lockExpiresAt: lockExpiry, lastSyncAt: now },
        update: { isLocked: true, lockExpiresAt: lockExpiry, lastSyncAt: now },
    });

    return true;
}

export async function releaseLock(folderKey: string, success: boolean): Promise<void> {
    await db.workerSyncState.update({
        where: { folderKey },
        data: {
            isLocked: false,
            lockExpiresAt: null,
            lastSuccessAt: success ? new Date() : undefined,
            consecutiveErrors: success
                ? 0
                : { increment: 1 },
        },
    });
}
