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

const BATCH_SIZE = 500;

export async function upsertParsedMatches(
    matches: MatchData[],
    driveFileDbId: number,
    sezon: string
): Promise<number[]> {
    const rows = matches.map(match => ({
        matchKey: computeMatchKey(match),
        macAdi: match.mac_adi,
        tarih: match.tarih,
        tarihDate: parseTarihDate(match.tarih),
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
    }));

    // Batch insert: skip duplicates on matchKey, then update changed rows
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        await db.parsedMatch.createMany({ data: batch, skipDuplicates: true });

        // Update existing rows in this batch (createMany skips them, we need to sync changes)
        const keys = batch.map(r => r.matchKey);
        const existing = await db.parsedMatch.findMany({
            where: { matchKey: { in: keys } },
            select: { id: true, matchKey: true },
        });
        const existingKeys = new Set(existing.map((e: { matchKey: string }) => e.matchKey));
        const toUpdate = batch.filter(r => existingKeys.has(r.matchKey));

        if (toUpdate.length > 0) {
            await Promise.all(
                toUpdate.map(r =>
                    db.parsedMatch.update({
                        where: { matchKey: r.matchKey },
                        data: {
                            macAdi: r.macAdi,
                            tarih: r.tarih,
                            tarihDate: r.tarihDate,
                            saat: r.saat,
                            salon: r.salon,
                            kategori: r.kategori,
                            hafta: r.hafta,
                            sezon: r.sezon,
                            ligTuru: r.ligTuru,
                            hakemler: r.hakemler,
                            masaGorevlileri: r.masaGorevlileri,
                            saglikcilar: r.saglikcilar,
                            istatistikciler: r.istatistikciler,
                            gozlemciler: r.gozlemciler,
                            sahaKomiserleri: r.sahaKomiserleri,
                            kaynakDosya: r.kaynakDosya,
                            driveFileId: r.driveFileId,
                        },
                    })
                )
            );
        }
    }

    // Fetch all IDs in order
    const allKeys = rows.map(r => r.matchKey);
    const saved = await db.parsedMatch.findMany({
        where: { matchKey: { in: allKeys } },
        select: { id: true, matchKey: true },
    });
    const keyToId = new Map(saved.map((r: { matchKey: string; id: number }) => [r.matchKey, r.id]));
    const ids = rows.map(r => keyToId.get(r.matchKey)).filter((id): id is number => id !== undefined);

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
    const lockExpiry = new Date(now.getTime() + 360 * 60 * 1000); // 6 saat

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
