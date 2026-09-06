import crypto from "crypto";
import { db } from "./db";
import { MatchData, nameMatches } from "./lib/match-parser";
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

export function parseTarihDate(tarih: string): Date | null {
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
    // GitHub Actions job timeout'u 10 dk (.github/workflows/sync-current.yml); force-kill
    // durumunda releaseLock çalışmadan process ölebilir. TTL bu sürenin üzerinde tampon
    // bırakacak şekilde 15 dk seçildi (eskiden 1 saatti — kilitli kalma penceresi çok uzundu).
    const lockExpiry = new Date(now.getTime() + 15 * 60 * 1000); // 15 dk

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
    // FAZ 2 — reconcileAndNotify'ın "aynı maça mı yeniden atandı (güncelleme),
    // yoksa başka maça mı taşındı (değişiklik)" ayrımını yapabilmesi için.
    contentKey: string | null;
}

// FAZ 2 — Kadrosu değiştiği için başka bir aktif satıra taşınan atama.
// Kullanıcı maçtan çıkmadı; sadece federasyon kadroyu kademeli doldururken yeni bir
// ParsedMatch satırı oluştu ve atama oraya taşındı. "Maçınız Güncellendi" bildirimi gider.
export interface ShiftedAssignmentInfo {
    userId: number;
    macAdi: string;
    tarih: string;
    contentKey: string | null;
    oldMatchData: MatchData | null;
    newMatchData: MatchData | null;
}

// FAZ 1 — Kitlesel sahte iptal sigortası.
// Bir Excel dosyasında başlık satırı bozulur / kolon eşlemesi kayar / salon hücreleri
// toplu boşalırsa, contentKey hesabı topluca değişir ve o dosyadaki neredeyse HERKES
// yanlışlıkla "iptal" adayı olur. Bu fonksiyon böyle anormal bir durumu yakalar:
// tek bir sync'te bir dosyada iade adayı hem mutlak olarak çok (≥25) hem de dosyanın
// aktif atamalarının büyük kısmıysa (>%40), bu bir veri bozulması sayılır → iptal
// YAZILMAZ, bildirim GİTMEZ, log'a uyarı düşer. Federasyonun normal günlük iade hacmi
// (5-24 atama) bu eşiğin çok altında kaldığı için gerçek iptaller etkilenmez.
export function evaluateCancellationSafety(
    candidateAssignmentCount: number,
    totalActiveAssignmentsInFile: number
): { safe: boolean; reason?: string } {
    const MIN_ABSOLUTE = 25;
    const MAX_RATIO = 0.4;

    if (candidateAssignmentCount < MIN_ABSOLUTE) {
        return { safe: true };
    }

    // Dosyada hiç aktif atama görünmüyorsa oran hesaplanamaz — mutlak sayı yüksekse
    // yine de şüpheli kabul edilir.
    const ratio = totalActiveAssignmentsInFile > 0
        ? candidateAssignmentCount / totalActiveAssignmentsInFile
        : 1;

    if (ratio > MAX_RATIO) {
        return {
            safe: false,
            reason: `Anormal toplu iptal: ${candidateAssignmentCount} atama / ${totalActiveAssignmentsInFile} aktif (%${Math.round(ratio * 100)}). Veri bozulması şüphesi — iptal atlandı.`,
        };
    }

    return { safe: true };
}

// ============================================================
// FAZ 2 — Kullanıcı bazlı iptal kararı (saf fonksiyon, DB'siz, test edilebilir)
// ============================================================

// Bir kullanıcının, bir sync sonrası maçındaki durumu:
//  - KEPT        : ismi hâlâ atandığı satırın kadrosunda → hiçbir şey yapma
//  - ROW_SHIFTED : ismi aynı maçın (aynı contentKey) BAŞKA bir aktif satırında →
//                  federasyon kadroyu kademeli doldurmuş, kullanıcı maçta ama satırı değişmiş.
//                  Atama yeni satıra taşınır, eski satır (kimse kalmazsa) iptal edilir.
//  - CANCELLED   : ismi bu maçın HİÇBİR aktif satırında yok → gerçek iade
//  - MOVED       : maç (contentKey) bu dosyada yok ama başka aktif dosyada var → arşive taşınma, sessiz
export type AssignmentOutcomeKind = "KEPT" | "ROW_SHIFTED" | "CANCELLED" | "MOVED";

export interface AssignmentDecisionInput {
    // İptal kontrolü yapılacak mevcut atamalar (DB'den gelir)
    assignments: {
        userId: number;
        nameInSpreadsheet: string;
        // Atama sahibinin profil adı-soyadı (nameMatches simetrisi için).
        // Bilinmiyorsa boş bırakılır, o zaman sadece ham eşitliğe düşülür.
        firstName?: string;
        lastName?: string;
        match: { id: number; contentKey: string | null; macAdi: string; tarih: string };
    }[];
    // contentKey → o maça ait TÜM aktif ParsedMatch satırları (id + parse edilmiş MatchData).
    // Aynı contentKey'den birden fazla satır olabilir (kademeli doldurma / dosya revizyonu) — hepsi burada.
    activeRowsByContentKey: Map<string, { id: number; data: MatchData }[]>;
    // Şu an İŞLENEN dosyada bulunan contentKey'ler. Bir atamanın contentKey'i burada yoksa,
    // maç bu dosyadan çıkmış demektir — ya iade edilmiş ya da başka dosyaya taşınmış.
    currentFileContentKeys: Set<string>;
    // Bu dosyada bulunmayan ama başka aktif dosyada bulunan contentKey'ler (arşive/revizyona taşınma).
    movedContentKeys: Set<string>;
}

export interface AssignmentDecision {
    userId: number;
    kind: AssignmentOutcomeKind;
    fromMatchId: number;          // kullanıcının şu anki atandığı satır
    toMatchId?: number;           // ROW_SHIFTED ise taşınacağı hedef satır
    macAdi: string;
    tarih: string;
    contentKey: string | null;
}

// Bir ismin, verilen bir MatchData'nın 6 personel listesinden herhangi birinde olup olmadığı.
// Önce ham (trim+lowerCase) eşitlik denenir; tutmazsa fuzzy nameMatches() (atama tarafıyla simetri).
function personIsInMatch(
    nameInSpreadsheet: string,
    firstName: string | undefined,
    lastName: string | undefined,
    m: MatchData
): boolean {
    const everyone = [
        ...m.hakemler,
        ...m.masa_gorevlileri,
        ...m.saglikcilar,
        ...m.istatistikciler,
        ...m.gozlemciler,
        ...m.sahaKomiserleri,
    ];
    const target = nameInSpreadsheet.trim().toLowerCase();
    for (const n of everyone) {
        if (n.trim().toLowerCase() === target) return true;
    }
    // Ham eşitlik tutmadı — atama fuzzy kurulmuş olabilir (isim sırası / tek harf hatası).
    if (firstName && lastName) {
        for (const n of everyone) {
            if (nameMatches(n, firstName, lastName)) return true;
        }
    }
    return false;
}

// NOTIFY_DRY_RUN=1 → hiçbir DB yazması ve hiçbir push yapılmaz; kararlar sadece loglanır.
// Canlıya almadan önce bir sync turunun ne yapacağını güvenle görmek için.
const DRY_RUN = process.env.NOTIFY_DRY_RUN === "1";

export function decideAssignmentOutcomes(input: AssignmentDecisionInput): AssignmentDecision[] {
    const decisions: AssignmentDecision[] = [];

    for (const a of input.assignments) {
        const contentKey = a.match.contentKey;
        const base = {
            userId: a.userId,
            fromMatchId: a.match.id,
            macAdi: a.match.macAdi,
            tarih: a.match.tarih,
            contentKey,
        };

        // Geçiş dönemi kaydı — contentKey yoksa dokunma (eski davranış)
        if (!contentKey) {
            decisions.push({ ...base, kind: "KEPT" });
            continue;
        }

        // Maç, ŞU AN işlenen dosyada artık yok mu? (kadro kademeli dolduruluyorsa yeni satır
        // yine bu dosyada olur — o durumda buraya girmez.)
        if (!input.currentFileContentKeys.has(contentKey)) {
            if (input.movedContentKeys.has(contentKey)) {
                // Başka aktif dosyada var → arşive / revizyon dosyasına taşınmış, sessiz
                decisions.push({ ...base, kind: "MOVED" });
            } else {
                // Hiçbir aktif dosyada yok → gerçek iade
                decisions.push({ ...base, kind: "CANCELLED" });
            }
            continue;
        }

        const activeRows = input.activeRowsByContentKey.get(contentKey) ?? [];

        if (activeRows.length === 0) {
            // Bu dosyada contentKey görünüyor ama aktif ParsedMatch satırı yok — teorik
            // olarak olmamalı; güvenli tarafta iptal sayma, dokunma.
            decisions.push({ ...base, kind: "KEPT" });
            continue;
        }

        // Federasyonun son hâli = o maçın kadrosu EN DOLU aktif satırı (kanonik satır).
        const personCount = (d: MatchData) =>
            d.hakemler.length + d.masa_gorevlileri.length + d.saglikcilar.length +
            d.istatistikciler.length + d.gozlemciler.length + d.sahaKomiserleri.length;
        const canonical = activeRows.reduce((best, r) =>
            personCount(r.data) > personCount(best.data) ? r : best
        );
        const inCanonical = personIsInMatch(a.nameInSpreadsheet, a.firstName, a.lastName, canonical.data);

        if (inCanonical) {
            // Kullanıcı kanonik (son) kadroda var.
            if (a.match.id === canonical.id) {
                decisions.push({ ...base, kind: "KEPT" });
            } else {
                // Eski / yanlış satırda kayıtlı → kanonik satıra taşı (kademeli doldurma / mükerrer)
                decisions.push({ ...base, kind: "ROW_SHIFTED", toMatchId: canonical.id });
            }
            continue;
        }

        // Kullanıcı kanonik (son) kadroda YOK → federasyon çıkarmış / hiç eklememiş → gerçek iade.
        // (Eski/eksik bir satırda ismi hâlâ görünüyor olabilir ama son kadro esas alınır.)
        decisions.push({ ...base, kind: "CANCELLED" });
    }

    return decisions;
}

export interface CancellationScanResult {
    cancelled: CancelledMatchInfo[];
    shifted: ShiftedAssignmentInfo[];
}

export async function detectAndMarkCancelledMatches(
    driveFileDbId: number,
    currentMatches: MatchData[]
): Promise<CancellationScanResult> {
    // Bu dosyadaki maçların contentKey'leri (arşive taşınma kontrolü için)
    const currentContentKeys = new Set<string>();
    for (const m of currentMatches) {
        currentContentKeys.add(computeContentKey(m));
    }

    // Bu dosyaya atanmış, henüz iptal edilmemiş kullanıcı atamalarını al —
    // atama sahibinin profil adı-soyadı da çekilir (nameMatches simetrisi, KN-3).
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
            user: {
                select: {
                    referee: { select: { firstName: true, lastName: true } },
                    official: { select: { firstName: true, lastName: true } },
                },
            },
        },
    });

    if (existingAssignments.length === 0) {
        return { cancelled: [], shifted: [] };
    }

    // Bu atamaların dokunduğu tüm contentKey'ler için, o maça ait TÜM aktif ParsedMatch
    // satırlarını çek (kademeli doldurma sonucu bir maç birden fazla satır olabilir).
    const touchedContentKeys = [
        ...new Set(existingAssignments.map(a => a.match.contentKey).filter((ck): ck is string => !!ck)),
    ];

    const activeRowsRaw = touchedContentKeys.length > 0
        ? await db.parsedMatch.findMany({
              where: { contentKey: { in: touchedContentKeys }, cancelledAt: null },
              select: {
                  id: true, contentKey: true, driveFileId: true,
                  macAdi: true, tarih: true, saat: true, salon: true, kategori: true,
                  hafta: true, sezon: true, ligTuru: true, kaynakDosya: true,
                  hakemler: true, masaGorevlileri: true, saglikcilar: true,
                  istatistikciler: true, gozlemciler: true, sahaKomiserleri: true,
              },
          })
        : [];

    // ParsedMatch satırını MatchData şekline çevir (personIsInMatch bunu bekliyor)
    const rowToMatchData = (r: typeof activeRowsRaw[number]): MatchData => ({
        mac_adi: r.macAdi, tarih: r.tarih, saat: r.saat ?? undefined, salon: r.salon ?? undefined,
        kategori: r.kategori, hafta: r.hafta ?? undefined, sezon: r.sezon ?? undefined, ligTuru: r.ligTuru,
        hakemler: r.hakemler, masa_gorevlileri: r.masaGorevlileri, saglikcilar: r.saglikcilar,
        istatistikciler: r.istatistikciler, gozlemciler: r.gozlemciler, sahaKomiserleri: r.sahaKomiserleri,
        kaynak_dosya: r.kaynakDosya,
    });

    // contentKey → o maça ait tüm aktif satırlar { id, data }
    const activeRowsByContentKey = new Map<string, { id: number; data: MatchData }[]>();
    for (const r of activeRowsRaw) {
        if (!r.contentKey) continue;
        const arr = activeRowsByContentKey.get(r.contentKey) ?? [];
        arr.push({ id: r.id, data: rowToMatchData(r) });
        activeRowsByContentKey.set(r.contentKey, arr);
    }
    const activeRowDataById = new Map<number, MatchData>(activeRowsRaw.map(r => [r.id, rowToMatchData(r)]));

    // Bu dosyada bulunamayan maçlar başka aktif dosyaya (arşive) taşınmış mı?
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
    const movedContentKeys = new Set(
        movedElsewhere.map((m: { contentKey: string | null }) => m.contentKey).filter((c): c is string => !!c)
    );

    // --- SAF KARAR ---
    const decisions = decideAssignmentOutcomes({
        assignments: existingAssignments.map(a => ({
            userId: a.userId,
            nameInSpreadsheet: a.nameInSpreadsheet,
            firstName: a.user?.referee?.firstName ?? a.user?.official?.firstName,
            lastName: a.user?.referee?.lastName ?? a.user?.official?.lastName,
            match: a.match,
        })),
        activeRowsByContentKey,
        currentFileContentKeys: currentContentKeys,
        movedContentKeys,
    });

    // --- UYGULAMA ---

    // 1) Gerçek iptaller — matchId bazında grupla
    const cancelledMap = new Map<number, CancelledMatchInfo>();
    const matchMetaById = new Map(existingAssignments.map(a => [a.match.id, a.match]));

    for (const d of decisions) {
        if (d.kind !== "CANCELLED") continue;
        const meta = matchMetaById.get(d.fromMatchId)!;
        if (!cancelledMap.has(d.fromMatchId)) {
            cancelledMap.set(d.fromMatchId, {
                matchId: meta.id, matchKey: meta.matchKey, macAdi: meta.macAdi,
                tarih: meta.tarih, affectedUserIds: [], contentKey: meta.contentKey,
            });
        }
        cancelledMap.get(d.fromMatchId)!.affectedUserIds.push(d.userId);
    }
    const cancelled = [...cancelledMap.values()];

    // FAZ 1 sigortası — anormal toplu iptalde hiçbir şey yazma
    const candidateCount = cancelled.reduce((s, c) => s + c.affectedUserIds.length, 0);
    const safety = evaluateCancellationSafety(candidateCount, existingAssignments.length);
    if (!safety.safe) {
        logger.error("Toplu iptal engellendi (FAZ 1 sigortası)", {
            driveFileDbId, candidateCount,
            totalActiveAssignmentsInFile: existingAssignments.length,
            affectedMatchCount: cancelled.length, reason: safety.reason,
        });
        return { cancelled: [], shifted: [] };
    }

    // 2) Kademeli doldurma → atamaları hedef satıra taşı
    const shifted: ShiftedAssignmentInfo[] = [];
    const shiftDecisions = decisions.filter(d => d.kind === "ROW_SHIFTED" && d.toMatchId);
    for (const d of shiftDecisions) {
        try {
            if (!DRY_RUN) {
                // Hedef satırda bu kullanıcının zaten bir ataması varsa (çift atama) —
                // eskisini sil, yenisini bırak. Yoksa eskiyi hedefe taşı.
                const dupe = await db.userMatchAssignment.findUnique({
                    where: { userId_matchId: { userId: d.userId, matchId: d.toMatchId! } },
                    select: { id: true },
                });
                if (dupe) {
                    await db.userMatchAssignment.delete({
                        where: { userId_matchId: { userId: d.userId, matchId: d.fromMatchId } },
                    });
                } else {
                    await db.userMatchAssignment.update({
                        where: { userId_matchId: { userId: d.userId, matchId: d.fromMatchId } },
                        data: { matchId: d.toMatchId! },
                    });
                }
            }
            shifted.push({
                userId: d.userId, macAdi: d.macAdi, tarih: d.tarih, contentKey: d.contentKey,
                oldMatchData: activeRowDataById.get(d.fromMatchId) ?? null,
                newMatchData: activeRowDataById.get(d.toMatchId!) ?? null,
            });
        } catch (err: any) {
            logger.error("Atama taşıma hatası (ROW_SHIFTED)", {
                userId: d.userId, fromMatchId: d.fromMatchId, toMatchId: d.toMatchId, error: err?.message,
            });
        }
    }

    // 3) İptal edilecek satırları işaretle. Bir satır ancak ÜZERİNDE HİÇ aktif atama
    // kalmadıysa iptal edilir — böylece maçta kalan kişiler maçını kaybetmez.
    // (a) Gerçek iade satırları
    // (b) Kademeli doldurmada boşalan eski satırlar
    const candidateRowIds = new Set<number>([
        ...cancelled.map(c => c.matchId),
        ...shiftDecisions.map(d => d.fromMatchId),
    ]);

    const rowsToCancel: { id: number; reason: string }[] = [];
    for (const rowId of candidateRowIds) {
        // DRY_RUN'da taşıma yapılmadığı için count gerçekçi olmaz — kararı decisions'tan türet.
        const stillHasAssignments = DRY_RUN
            ? decisions.some(d =>
                (d.kind === "KEPT" && d.fromMatchId === rowId) ||
                (d.kind === "ROW_SHIFTED" && d.toMatchId === rowId))
            : (await db.userMatchAssignment.count({ where: { matchId: rowId } })) > 0;

        if (!stillHasAssignments) {
            const isRealCancellation = cancelledMap.has(rowId) &&
                !shiftDecisions.some(d => d.fromMatchId === rowId);
            rowsToCancel.push({
                id: rowId,
                reason: isRealCancellation ? "Hakem listesinden çıkarıldı" : "Kadro güncellendi",
            });
        }
    }

    if (!DRY_RUN) {
        for (const r of rowsToCancel) {
            await db.parsedMatch.update({
                where: { id: r.id },
                data: { cancelledAt: new Date(), cancelReason: r.reason },
            });
        }
    }

    if (rowsToCancel.length > 0 || shifted.length > 0) {
        logger.info(DRY_RUN ? "İptal taraması (DRY_RUN — DB'ye yazılmadı)" : "İptal taraması tamamlandı", {
            gercekIptalMac: cancelled.length,
            iptalIsaretlenenSatir: rowsToCancel.length,
            tasinanAtama: shifted.length,
        });
    }

    // Gerçek iptallerden, satırı fiilen iptal edilmiş olanları döndür (bildirim bunlar için gider).
    // Satırında hâlâ atama kalanları (başka kullanıcılar duruyor) bildirim listesinden çıkar —
    // ama o kullanıcı için yine de "iade" bilgisi gerekli, o yüzden affectedUserIds korunur.
    return { cancelled, shifted };
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
