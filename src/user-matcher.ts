import { db } from "./db";
import { fuzzyNameSimilarity, MatchData } from "./lib/match-parser";
import { resolveCellCandidates, CellResolution } from "./lib/name-match";
import { upsertUserMatchAssignment, computeContentKey } from "./db-writer";
import { logger } from "./logger";

// NOTIFY_DRY_RUN=1 → kullanıcı atama satırları DB'ye YAZILMAZ, sadece loglanır.
// db-writer.ts'teki aynı isimli sabitle aynı ortam değişkenini paylaşır.
const DRY_RUN = process.env.NOTIFY_DRY_RUN === "1";

/** Ambiguity eşiği: en iyi ve ikinci en iyi aday arasındaki fark bundan küçükse hiçbiri seçilmez. */
const FUZZY_AMBIGUITY_GAP = 0.05;
const FUZZY_THRESHOLD_DEFAULT = 0.90;

/**
 * Bir personel adı için tüm aktif kullanıcılar arasından en iyi fuzzy adayı bulur.
 * Belirsizlik durumunda (en iyi iki aday birbirine çok yakınsa) kimse döndürülmez —
 * yanlışlıkla iki farklı kişiyi birbirine karıştırmaktansa hiç atama yapmamak tercih edilir.
 * Saf fonksiyon (DB'ye dokunmaz) — test edilebilirlik için user-matcher.ts'ten ayrıldı.
 */
export function resolveFuzzyCandidate(
    person: string,
    users: UserProfile[]
): { userId: number; similarity: number } | null {
    const scored = users
        .map(u => ({ userId: u.userId, similarity: fuzzyNameSimilarity(person, u.firstName, u.lastName) }))
        .filter(s => s.similarity >= FUZZY_THRESHOLD_DEFAULT)
        .sort((a, b) => b.similarity - a.similarity);

    if (scored.length === 0) return null;
    if (scored.length > 1 && scored[0].similarity - scored[1].similarity < FUZZY_AMBIGUITY_GAP) {
        logger.info("Fuzzy eşleşme belirsiz — atama yapılmadı", {
            person,
            candidates: scored.slice(0, 3),
        });
        return null;
    }
    return scored[0];
}

export interface UserProfile {
    userId: number;
    firstName: string;
    lastName: string;
}

export interface NewAssignmentInfo {
    userId: number;
    matchId: number;
    macAdi: string;
    tarih: string;
    saat?: string | null;
    // FAZ 2 — reconcileAndNotify'ın iptalle eşleştirmede "aynı maç mı" ayrımı için.
    contentKey: string | null;
    // Kadro değişikliği özeti üretmek için (ROW_SHIFTED → "Maçınız Güncellendi").
    matchData: MatchData;
}

async function loadActiveUsers(): Promise<UserProfile[]> {
    const referees = await db.referee.findMany({
        where: { user: { isActive: true, isApproved: true } },
        select: { userId: true, firstName: true, lastName: true },
    });

    const officials = await db.generalOfficial.findMany({
        where: { user: { isActive: true, isApproved: true } },
        select: { userId: true, firstName: true, lastName: true },
    });

    type Row = { userId: number; firstName: string; lastName: string };
    return [
        ...referees.map((r: Row) => ({ userId: r.userId, firstName: r.firstName, lastName: r.lastName })),
        ...officials.map((o: Row) => ({ userId: o.userId, firstName: o.firstName, lastName: o.lastName })),
    ];
}

export function detectRole(match: MatchData, personName: string): { role: string; nameInSpreadsheet: string } | null {
    const check = (list: string[]): string | undefined => list.find(n => n === personName);

    let found = check(match.hakemler);
    if (found) return { role: "hakem", nameInSpreadsheet: found };

    found = check(match.masa_gorevlileri);
    if (found) return { role: "masa", nameInSpreadsheet: found };

    found = check(match.saglikcilar);
    if (found) return { role: "saglik", nameInSpreadsheet: found };

    found = check(match.istatistikciler);
    if (found) return { role: "istatistik", nameInSpreadsheet: found };

    found = check(match.gozlemciler);
    if (found) return { role: "gozlemci", nameInSpreadsheet: found };

    found = check(match.sahaKomiserleri);
    if (found) return { role: "sahaKomiseri", nameInSpreadsheet: found };

    return null;
}

/**
 * Her maçın her personel hücresini aktif kullanıcılara çözer (önce kesin kelime
 * kuralı, sonra bulanık kademe) ve user_match_assignments satırlarını yazar.
 *
 * matchIdMap: matchKey → parsed_matches.id (from db-writer upsert results)
 */
export async function buildUserAssignments(
    matches: MatchData[],
    matchIds: number[]
): Promise<{ assignmentCount: number; newAssignments: NewAssignmentInfo[] }> {
    const users = await loadActiveUsers();
    logger.info("Kullanıcı yüklemesi tamamlandı", { count: users.length });

    // Bu maçların contentKey'lerini çıkar — "yeni atama mı" kararı contentKey bazlı verilir.
    // Federasyon kadroyu kademeli doldurunca her adımda YENİ bir ParsedMatch satırı (yeni
    // matchId) oluşuyor. Eski mantık `userId:matchId` baktığı için maçta zaten olan herkese
    // "yeni maça atandınız" bildirimi gidiyordu. contentKey aynı kaldığı için `userId:contentKey`
    // bakınca bu sahte "yeni atama" ortadan kalkar.
    const validMatchIds = matchIds.filter((id): id is number => !!id);
    const contentKeyByMatchId = new Map<number, string>();
    for (let i = 0; i < matches.length; i++) {
        const mid = matchIds[i];
        if (mid) contentKeyByMatchId.set(mid, computeContentKey(matches[i]));
    }
    const touchedContentKeys = [...new Set(contentKeyByMatchId.values())];

    // Bu contentKey'lere ait HERHANGİ bir satırda (iptal edilmiş dahil) önceden atama var mı?
    const existing = touchedContentKeys.length > 0
        ? await db.userMatchAssignment.findMany({
              where: { match: { contentKey: { in: touchedContentKeys } } },
              select: { userId: true, match: { select: { contentKey: true } } },
          })
        : [];
    const existingKeys = new Set(
        existing
            .map((e: { userId: number; match: { contentKey: string | null } }) =>
                e.match.contentKey ? `${e.userId}:${e.match.contentKey}` : null)
            .filter((k): k is string => !!k)
    );

    let assignmentCount = 0;
    let totalUnmatchedCount = 0;
    let matchesWithUnmatchedCount = 0;
    const pendingAssignments: { userId: number; matchId: number; role: string; nameInSpreadsheet: string; isNew: boolean }[] = [];
    const matchById = new Map<number, MatchData>();
    // Aynı isim tüm dosyada defalarca geçer — hücre çözümü bir kez hesaplanır.
    const nameCandidates = users.map(u => ({ id: u.userId, firstName: u.firstName, lastName: u.lastName }));
    const resolutionCache = new Map<string, CellResolution>();

    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const matchId = matchIds[i];
        if (!matchId) continue;

        matchById.set(matchId, match);

        const allPersonnel = [
            ...match.hakemler,
            ...match.masa_gorevlileri,
            ...match.saglikcilar,
            ...match.istatistikciler,
            ...match.gozlemciler,
            ...match.sahaKomiserleri,
        ];

        if (allPersonnel.length === 0) continue;

        const matchedPersonnel = new Set<string>();
        const matchedUserIds = new Set<number>();

        // KADEME 1 — HÜCRE bazlı kesin eşleşme (2026-11-01). Eskiden döngü kullanıcı
        // bazlıydı ve her kullanıcı "adının kelimeleri geçen ilk hücreyi" alıyordu:
        // "AYHAN CEM AKAN" hücresi hem Ayhan Cem Akan'a hem Cem Akan'a yazılıyordu.
        // Artık her hücrenin sahibine `resolveCellCandidates` karar verir (tam eşleşen
        // öne geçer, çakışan adaylar atanmaz). Kişi bir maçta birden çok hücreye
        // uyuyorsa eskisi gibi listedeki ilk hücre (hakemler önce) geçerli.
        for (const person of allPersonnel) {
            let res = resolutionCache.get(person);
            if (!res) {
                res = resolveCellCandidates(person, nameCandidates);
                resolutionCache.set(person, res);
            }
            if (res.ids.length === 0 && res.ambiguous.length === 0) continue;

            // Belirsiz hücre "eşleşmiş" sayılır ki bulanık kademe onu birine vermesin.
            matchedPersonnel.add(person);
            if (res.ambiguous.length > 0) {
                logger.info("İsim belirsiz — bu adaylara atama yapılmadı", {
                    person,
                    userIds: res.ambiguous,
                    matchName: match.mac_adi,
                });
            }

            for (const userId of res.ids) {
                if (matchedUserIds.has(userId)) continue;
                matchedUserIds.add(userId);

                const roleInfo = detectRole(match, person);
                if (!roleInfo) continue;

                const ck = contentKeyByMatchId.get(matchId);
                const isNew = ck ? !existingKeys.has(`${userId}:${ck}`) : true;
                pendingAssignments.push({
                    userId,
                    matchId,
                    role: roleInfo.role,
                    nameInSpreadsheet: roleInfo.nameInSpreadsheet,
                    isNew,
                });
                assignmentCount++;
            }
        }

        // Kesin kural hiç kimseyle eşleşmeyen personel için ikinci kademe:
        // squash edilmiş benzerlik oranı (bkz. match-parser.ts fuzzyNameSimilarity).
        // Bu maçta zaten exact-match ile atanmış kullanıcılar aday havuzundan çıkarılır
        // (aynı kullanıcının aynı maçta iki isme birden atanmasını önlemek için).
        const fuzzyCandidatePool = users.filter(u => !matchedUserIds.has(u.userId));
        for (const person of allPersonnel) {
            if (matchedPersonnel.has(person)) continue;

            const candidate = resolveFuzzyCandidate(person, fuzzyCandidatePool);
            if (!candidate) continue;

            const user = fuzzyCandidatePool.find(u => u.userId === candidate.userId)!;
            matchedPersonnel.add(person);
            matchedUserIds.add(user.userId);

            const roleInfo = detectRole(match, person);
            if (!roleInfo) continue;

            logger.info("Fuzzy eşleşme ile atama yapıldı", {
                person,
                userId: user.userId,
                similarity: candidate.similarity,
                matchName: match.mac_adi,
            });

            const ck = contentKeyByMatchId.get(matchId);
            const isNew = ck ? !existingKeys.has(`${user.userId}:${ck}`) : true;
            pendingAssignments.push({
                userId: user.userId,
                matchId,
                role: roleInfo.role,
                nameInSpreadsheet: roleInfo.nameInSpreadsheet,
                isNew,
            });
            assignmentCount++;
        }

        // Personel listesinde olup hiçbir kullanıcıyla eşleşmeyen isimler — isim formatı
        // sorunlarını (Excel'deki yazım farklılıkları) tespit etmek için maç bazlı özet
        const unmatched = allPersonnel.filter(p => !matchedPersonnel.has(p));
        if (unmatched.length > 0) {
            logger.debug("Personel isimleri eşleşmedi", {
                matchName: match.mac_adi,
                unmatchedCount: unmatched.length,
                unmatchedNames: unmatched,
            });
            totalUnmatchedCount += unmatched.length;
            matchesWithUnmatchedCount++;
        }
    }

    // LOG_LEVEL=info olan üretim ortamında yukarıdaki debug logları görünmüyor;
    // isim eşleşmemesi sessizce kaybolan bildirimlere yol açabileceğinden
    // info seviyesinde görünür bir özet bırakılıyor (detaylar için LOG_LEVEL=debug gerekir).
    if (totalUnmatchedCount > 0) {
        logger.info("Eşleşmeyen personel özeti", {
            totalUnmatchedCount,
            matchesWithUnmatchedCount,
        });
    }

    if (!DRY_RUN) {
        // Pool limit (5) aşılmasın diye küçük batch — 200 paralel pool'u tüketiyordu
        const ASSIGN_BATCH = 5;
        for (let i = 0; i < pendingAssignments.length; i += ASSIGN_BATCH) {
            const batch = pendingAssignments.slice(i, i + ASSIGN_BATCH);
            await Promise.all(batch.map(a =>
                upsertUserMatchAssignment(a.userId, a.matchId, a.role, a.nameInSpreadsheet)
            ));
        }
    } else {
        logger.info("Atama oluşturma tamamlandı (DRY_RUN — DB'ye yazılmadı)", {
            toplam: pendingAssignments.length,
            yeniAtamaSayisi: pendingAssignments.filter(a => a.isNew).length,
        });
    }

    const newAssignments: NewAssignmentInfo[] = pendingAssignments
        .filter(a => a.isNew)
        .map(a => {
            const match = matchById.get(a.matchId)!;
            return {
                userId: a.userId,
                matchId: a.matchId,
                macAdi: match.mac_adi,
                tarih: match.tarih,
                saat: match.saat ?? null,
                contentKey: contentKeyByMatchId.get(a.matchId) ?? null,
                matchData: match,
            };
        });

    logger.info("Atama oluşturma tamamlandı", { assignmentCount, newAssignmentCount: newAssignments.length });
    return { assignmentCount, newAssignments };
}
