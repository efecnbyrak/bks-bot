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

    return [
        ...referees.map(r => ({ userId: r.userId, firstName: r.firstName, lastName: r.lastName })),
        ...officials.map(o => ({ userId: o.userId, firstName: o.firstName, lastName: o.lastName })),
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

        // Memoize nameMatches for this match's personnel list
        const nameCache = new Map<string, string | null>(); // personName → matched user name | null

        for (const user of users) {
            // Find which personnel entry matches this user
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

            const roleInfo = detectRole(match, matchedPerson);
            if (!roleInfo) continue;

            await upsertUserMatchAssignment(
                user.userId,
                matchId,
                roleInfo.role,
                roleInfo.nameInSpreadsheet
            );

            assignmentCount++;
        }
    }

    logger.info("Atama oluşturma tamamlandı", { assignmentCount });
    return assignmentCount;
}
