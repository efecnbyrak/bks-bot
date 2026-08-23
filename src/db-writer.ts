import crypto from "crypto";
import { db } from "./db";
import { MatchData } from "./lib/match-parser";
import { DriveSpreadsheet } from "./lib/google-drive";
import { logger } from "./logger";

// İlk kurulum koruması: DB'de hiç parsedMatch yoksa bu, sistemin ilk çalışması demektir.
// Bu durumda tüm atamalar "yeni" sayılacağından, binlerce yanlış bildirim gitmemesi için
// çağıran taraf (index.ts) bildirim gönderimini tamamen atlamalı.
export async function isFirstEverSync(): Promise<boolean> {
    const count = await db.parsedMatch.count();
    return count === 0;
}

export function computeMatchKey(match: MatchData): string {
    const hakemlerSorted = [...match.hakemler].sort().join("|");
    const masaSorted = [...match.masa_gorevlileri].sort().join("|");
    const norm = (s: string) => (s ?? "").trim().toLowerCase();
    const raw = `${norm(match.mac_adi)}|${norm(match.tarih)}|${norm(match.saat ?? "")}|${norm(match.salon ?? "")}|${hakemlerSorted}|${masaSorted}`;
    return crypto.createHash("sha256").update(raw).digest("hex").substring(0, 32);
}

// Hakemler/masa dahil etmeden maç kimliğini hashler.
// Aynı maçın farklı dosyalara (arşiv dahil) taşınıp taşınmadığını tespit etmek için kullanılır.
export function computeContentKey(match: MatchData): string {
    const norm = (s: string) => (s ?? "").trim().toLowerCase();
    const raw = `${norm(match.mac_adi)}|${norm(match.tarih)}|${norm(match.saat ?? "")}|${norm(match.salon ?? "")}`;
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
        contentKey: computeContentKey(match),
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
            const UPDATE_BATCH = 5;
            for (let j = 0; j < toUpdate.length; j += UPDATE_BATCH) {
                const updateBatch = toUpdate.slice(j, j + UPDATE_BATCH);
                await Promise.all(updateBatch.map(r =>
                    db.parsedMatch.update({
                        where: { matchKey: r.matchKey },
                        data: {
                            contentKey: r.contentKey,
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
                ));
            }
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
    const lockExpiry = new Date(now.getTime() + 60 * 60 * 1000); // 1 saat

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

export interface CancelledMatchInfo {
    matchId: number;
    matchKey: string;
    macAdi: string;
    tarih: string;
    affectedUserIds: number[];
}

export async function detectAndMarkCancelledMatches(
    driveFileDbId: number,
    currentMatches: MatchData[]
): Promise<CancelledMatchInfo[]> {
    // currentContentKeys: bu dosyada şu an hangi maçlar var (hakemlerden bağımsız kimlik)
    // contentKey → hakemler listesi eşlemesi (kimin ismi var diye bakmak için)
    const currentContentKeys = new Set<string>();
    const currentMatchByContentKey = new Map<string, MatchData>();
    for (const m of currentMatches) {
        const contentKey = computeContentKey(m);
        currentContentKeys.add(contentKey);
        currentMatchByContentKey.set(contentKey, m);
    }

    // Bu dosyaya atanmış, henüz iptal edilmemiş kullanıcı atamalarını al
    const existingAssignments = await db.userMatchAssignment.findMany({
        where: {
            match: {
                driveFileId: driveFileDbId,
                cancelledAt: null,
            },
        },
        select: {
            userId: true,
            nameInSpreadsheet: true,
            match: {
                select: {
                    id: true,
                    matchKey: true,
                    contentKey: true,
                    macAdi: true,
                    tarih: true,
                },
            },
        },
    });

    // matchId → CancelledMatchInfo (birden fazla kullanıcı aynı maçta olabilir)
    const cancelledMap = new Map<number, CancelledMatchInfo>();

    // Bu dosyada bulunamayan maçları iptal saymadan önce, başka bir dosyaya
    // (örn. arşive) taşınıp taşınmadığını kontrol et — taşınmışsa gerçek iptal değildir.
    const missingContentKeys = [
        ...new Set(
            existingAssignments
                .map(a => a.match.contentKey)
                .filter((ck): ck is string => !!ck && !currentContentKeys.has(ck))
        ),
    ];

    const movedElsewhere = missingContentKeys.length > 0
        ? await db.parsedMatch.findMany({
              where: {
                  contentKey: { in: missingContentKeys },
                  cancelledAt: null,
                  driveFileId: { not: driveFileDbId },
              },
              select: { contentKey: true },
          })
        : [];
    const movedContentKeys = new Set(movedElsewhere.map((m: { contentKey: string | null }) => m.contentKey));

    for (const assignment of existingAssignments) {
        const match = assignment.match;
        const contentKey = match.contentKey;

        // contentKey yoksa eski kayıt — matchKey ile kontrol et (geçiş dönemi güvencesi)
        if (!contentKey) continue;

        if (movedContentKeys.has(contentKey)) {
            // Maç başka bir dosyaya (örn. arşive) taşınmış — iptal değil, atlanır
            continue;
        }

        if (!currentContentKeys.has(contentKey)) {
            // Maç bu dosyada artık yok ve başka hiçbir aktif dosyada da bulunamadı → gerçek iade
            if (!cancelledMap.has(match.id)) {
                cancelledMap.set(match.id, {
                    matchId: match.id,
                    matchKey: match.matchKey,
                    macAdi: match.macAdi,
                    tarih: match.tarih,
                    affectedUserIds: [],
                });
            }
            cancelledMap.get(match.id)!.affectedUserIds.push(assignment.userId);
        } else {
            // Maç hâlâ tabloda var — ama bu kullanıcının ismi hakem listesinden silindi mi?
            const currentMatch = currentMatchByContentKey.get(contentKey)!;
            const normName = (s: string) => s.trim().toLowerCase();
            const userNorm = normName(assignment.nameInSpreadsheet);
            const stillAssigned = [
                ...currentMatch.hakemler,
                ...currentMatch.masa_gorevlileri,
                ...currentMatch.saglikcilar,
                ...currentMatch.istatistikciler,
                ...currentMatch.gozlemciler,
                ...currentMatch.sahaKomiserleri,
            ].some(n => normName(n) === userNorm);

            if (!stillAssigned) {
                // İsim silindi → iade
                if (!cancelledMap.has(match.id)) {
                    cancelledMap.set(match.id, {
                        matchId: match.id,
                        matchKey: match.matchKey,
                        macAdi: match.macAdi,
                        tarih: match.tarih,
                        affectedUserIds: [],
                    });
                }
                cancelledMap.get(match.id)!.affectedUserIds.push(assignment.userId);
            }
        }
    }

    const cancelled = [...cancelledMap.values()];

    if (cancelled.length > 0) {
        await db.parsedMatch.updateMany({
            where: { id: { in: cancelled.map(c => c.matchId) } },
            data: { cancelledAt: new Date(), cancelReason: "Hakem listesinden çıkarıldı" },
        });
        logger.info("İptal edilen maçlar işaretlendi", { count: cancelled.length });
    }

    return cancelled;
}

export async function createCancellationAnnouncements(
    cancelledMatches: CancelledMatchInfo[]
): Promise<void> {
    for (const match of cancelledMatches) {
        if (match.affectedUserIds.length === 0) continue;

        const target = `SPECIFIC:${match.affectedUserIds.join(",")}`;
        const subject = `Maç İadesi: ${match.macAdi}`;
        const content = `<p>${match.tarih} tarihindeki <strong>${match.macAdi}</strong> maçı iptal edildi / iade edildi.</p><p>Bu bildirim BKS sistemi tarafından otomatik olarak oluşturulmuştur.</p>`;

        await db.announcement.create({
            data: {
                subject,
                content,
                target,
                senderId: null,
                sentCount: match.affectedUserIds.length,
            },
        });
    }

    if (cancelledMatches.length > 0) {
        logger.info("İptal duyuruları oluşturuldu", { count: cancelledMatches.length });
    }
}
