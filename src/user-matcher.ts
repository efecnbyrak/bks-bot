import { db } from "./db";
import { nameMatches, MatchData } from "./lib/match-parser";
import { upsertUserMatchAssignment } from "./db-writer";
import { logger } from "./logger";

interface UserProfile {
    userId: number;
    firstName: string;
    lastName: string;
}

export interface NewAssignmentInfo {
    userId: number;
    matchId: number;
    macAdi: string;
    tarih: string;
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
 * For every parsed match, run nameMatches() for all active users
 * and write user_match_assignments rows.
 *
 * matchIdMap: matchKey → parsed_matches.id (from db-writer upsert results)
 */
export async function buildUserAssignments(
    matches: MatchData[],
    matchIds: number[]
): Promise<{ assignmentCount: number; newAssignments: NewAssignmentInfo[] }> {
    const users = await loadActiveUsers();
    logger.info("Kullanıcı yüklemesi tamamlandı", { count: users.length });

    // Bu maçlar için önceden var olan (iptal edilmiş dahil) atamaları tek seferde çek —
    // "insert mi update mi" ayrımını her satır için ayrı sorgu atmadan yapabilmek için.
    const validMatchIds = matchIds.filter((id): id is number => !!id);
    const existing = validMatchIds.length > 0
        ? await db.userMatchAssignment.findMany({
              where: { matchId: { in: validMatchIds } },
              select: { userId: true, matchId: true },
          })
        : [];
    const existingKeys = new Set(existing.map((e: { userId: number; matchId: number }) => `${e.userId}:${e.matchId}`));

    let assignmentCount = 0;
    let totalUnmatchedCount = 0;
    let matchesWithUnmatchedCount = 0;
    const pendingAssignments: { userId: number; matchId: number; role: string; nameInSpreadsheet: string; isNew: boolean }[] = [];
    const matchById = new Map<number, MatchData>();

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

        for (const user of users) {
            // Cache her kullanıcı için sıfırlanır — farklı kullanıcıların sonuçları karışmaz
            const nameCache = new Map<string, string | null>();
            let matchedPerson: string | null = null;

            for (const person of allPersonnel) {
                let cached = nameCache.get(person);
                if (cached === undefined) {
                    const matches_ = nameMatches(person, user.firstName, user.lastName);
                    cached = matches_ ? person : null;
                    nameCache.set(person, cached);
                }
                if (cached) {
                    matchedPerson = cached;
                    break;
                }
            }

            if (!matchedPerson) continue;

            matchedPersonnel.add(matchedPerson);

            const roleInfo = detectRole(match, matchedPerson);
            if (!roleInfo) continue;

            const isNew = !existingKeys.has(`${user.userId}:${matchId}`);
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

    // Pool limit (5) aşılmasın diye küçük batch — 200 paralel pool'u tüketiyordu
    const ASSIGN_BATCH = 5;
    for (let i = 0; i < pendingAssignments.length; i += ASSIGN_BATCH) {
        const batch = pendingAssignments.slice(i, i + ASSIGN_BATCH);
        await Promise.all(batch.map(a =>
            upsertUserMatchAssignment(a.userId, a.matchId, a.role, a.nameInSpreadsheet)
        ));
    }

    const newAssignments: NewAssignmentInfo[] = pendingAssignments
        .filter(a => a.isNew)
        .map(a => {
            const match = matchById.get(a.matchId)!;
            return { userId: a.userId, matchId: a.matchId, macAdi: match.mac_adi, tarih: match.tarih };
        });

    logger.info("Atama oluşturma tamamlandı", { assignmentCount, newAssignmentCount: newAssignments.length });
    return { assignmentCount, newAssignments };
}
