import { db } from "./db";
import { nameMatches, MatchData } from "./lib/match-parser";
import { upsertUserMatchAssignment } from "./db-writer";
import { logger } from "./logger";

interface UserProfile {
    userId: number;
    firstName: string;
    lastName: string;
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

function detectRole(match: MatchData, personName: string): { role: string; nameInSpreadsheet: string } | null {
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
): Promise<number> {
    const users = await loadActiveUsers();
    logger.info("Kullanıcı yüklemesi tamamlandı", { count: users.length });

    let assignmentCount = 0;
    const pendingAssignments: { userId: number; matchId: number; role: string; nameInSpreadsheet: string }[] = [];

    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const matchId = matchIds[i];
        if (!matchId) continue;

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

            pendingAssignments.push({
                userId: user.userId,
                matchId,
                role: roleInfo.role,
                nameInSpreadsheet: roleInfo.nameInSpreadsheet,
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
        }
    }

    // Pool limit (5) aşılmasın diye küçük batch — 200 paralel pool'u tüketiyordu
    const ASSIGN_BATCH = 5;
    for (let i = 0; i < pendingAssignments.length; i += ASSIGN_BATCH) {
        const batch = pendingAssignments.slice(i, i + ASSIGN_BATCH);
        await Promise.all(batch.map(a =>
            upsertUserMatchAssignment(a.userId, a.matchId, a.role, a.nameInSpreadsheet)
        ));
    }

    logger.info("Atama oluşturma tamamlandı", { assignmentCount });
    return assignmentCount;
}
