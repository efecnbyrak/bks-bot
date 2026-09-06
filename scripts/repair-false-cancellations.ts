import { db } from "../src/db";

/**
 * FAZ 4 — Geçmişteki sahte iptal / mükerrer maç kayıtlarını tespit eder ve (yaz modunda) düzeltir.
 *
 * ARKA PLAN: FAZ 2 öncesinde `matchKey` personeli içerdiği için federasyon kadroyu kademeli
 * doldurunca her adımda yeni bir ParsedMatch satırı açılıyor, eski satır "sahte iptal" ediliyordu.
 * Sonuç: bir kullanıcının maçı, aktif bir satırda hâlâ dururken, iptal edilmiş bir satıra bağlı
 * kalıyordu → web'de "Maçlarım" listesinden düşüyordu.
 *
 * KULLANIM:
 *   npx ts-node scripts/repair-false-cancellations.ts report   -> SADECE OKUMA, ne yapılacağını listeler
 *   npx ts-node scripts/repair-false-cancellations.ts apply     -> düzeltmeyi uygular (geri alma logu basar)
 *
 * GÜVENLİK: Bu script SADECE `user_match_assignments` ve `parsed_matches` tablolarına dokunur.
 * Uygunluk formu / kullanıcı profili / duyuru tablolarına HİÇ dokunmaz.
 */

const REASON = "Hakem listesinden çıkarıldı";

interface RepairCandidate {
    cancelledMatchId: number;
    macAdi: string;
    tarih: string;
    contentKey: string;
    activeSiblingId: number;
    // Bu iptal satırındaki atamalardan, aktif kardeş satırın kadrosunda ismi GEÇEN kullanıcılar
    movableAssignments: { assignmentId: number; userId: number; nameInSpreadsheet: string; role: string }[];
    // İsmi aktif kardeşte de geçmeyenler (bunlar gerçekten iade — dokunulmaz)
    genuinelyGone: { userId: number; nameInSpreadsheet: string }[];
}

function norm(s: string): string {
    return s.trim().toLowerCase();
}

async function analyze(): Promise<RepairCandidate[]> {
    // 1) Sahte iptal adayları: cancelledAt dolu + reason "Hakem listesinden çıkarıldı" +
    //    aynı contentKey'e sahip AKTİF bir satır var
    const cancelledRows = await db.parsedMatch.findMany({
        where: { cancelledAt: { not: null }, cancelReason: REASON, contentKey: { not: null } },
        select: {
            id: true, macAdi: true, tarih: true, contentKey: true,
        },
    });

    const candidates: RepairCandidate[] = [];

    for (const cr of cancelledRows) {
        if (!cr.contentKey) continue;

        // Aynı contentKey'e sahip aktif satırlar
        const siblings = await db.parsedMatch.findMany({
            where: { contentKey: cr.contentKey, cancelledAt: null },
            select: {
                id: true,
                hakemler: true, masaGorevlileri: true, saglikcilar: true,
                istatistikciler: true, gozlemciler: true, sahaKomiserleri: true,
            },
        });
        if (siblings.length === 0) continue; // gerçekten iptal — dokunma

        // Kanonik kardeş = kadrosu en dolu olan
        const personCount = (s: typeof siblings[number]) =>
            s.hakemler.length + s.masaGorevlileri.length + s.saglikcilar.length +
            s.istatistikciler.length + s.gozlemciler.length + s.sahaKomiserleri.length;
        const canonical = siblings.reduce((best, s) => personCount(s) > personCount(best) ? s : best);
        const canonicalNames = new Set([
            ...canonical.hakemler, ...canonical.masaGorevlileri, ...canonical.saglikcilar,
            ...canonical.istatistikciler, ...canonical.gozlemciler, ...canonical.sahaKomiserleri,
        ].map(norm));

        // Bu iptal satırına bağlı atamalar
        const asgs = await db.userMatchAssignment.findMany({
            where: { matchId: cr.id },
            select: { id: true, userId: true, nameInSpreadsheet: true, role: true },
        });
        if (asgs.length === 0) continue;

        const movable: RepairCandidate["movableAssignments"] = [];
        const gone: RepairCandidate["genuinelyGone"] = [];
        for (const a of asgs) {
            if (canonicalNames.has(norm(a.nameInSpreadsheet))) {
                movable.push({ assignmentId: a.id, userId: a.userId, nameInSpreadsheet: a.nameInSpreadsheet, role: a.role });
            } else {
                gone.push({ userId: a.userId, nameInSpreadsheet: a.nameInSpreadsheet });
            }
        }

        if (movable.length > 0) {
            candidates.push({
                cancelledMatchId: cr.id, macAdi: cr.macAdi, tarih: cr.tarih, contentKey: cr.contentKey,
                activeSiblingId: canonical.id, movableAssignments: movable, genuinelyGone: gone,
            });
        }
    }

    return candidates;
}

async function report() {
    const candidates = await analyze();
    let totalMovable = 0;
    for (const c of candidates) {
        totalMovable += c.movableAssignments.length;
        console.log(`\n[iptal satır ${c.cancelledMatchId}] ${c.macAdi} (${c.tarih})`);
        console.log(`  → aktif kanonik satır: ${c.activeSiblingId}`);
        console.log(`  → taşınacak atama: ${c.movableAssignments.length} (${c.movableAssignments.map(m => m.nameInSpreadsheet).join(", ")})`);
        if (c.genuinelyGone.length > 0) {
            console.log(`  → gerçekten iade (dokunulmaz): ${c.genuinelyGone.map(g => g.nameInSpreadsheet).join(", ")}`);
        }
    }
    console.log(`\n=== ÖZET ===`);
    console.log(`Düzeltilecek sahte-iptal satırı: ${candidates.length}`);
    console.log(`Aktif kardeşe taşınacak atama: ${totalMovable}`);
    console.log(`\n(apply modunda: bu atamaların matchId'si kanonik satıra güncellenecek,`);
    console.log(` hedefte çakışan atama varsa eski silinecek. Geri alma logu basılacak.)`);
}

async function apply() {
    const candidates = await analyze();
    const undoLog: { assignmentId: number; oldMatchId: number; newMatchId: number; action: string }[] = [];

    for (const c of candidates) {
        for (const m of c.movableAssignments) {
            // Hedefte bu kullanıcının zaten ataması var mı?
            const dupe = await db.userMatchAssignment.findUnique({
                where: { userId_matchId: { userId: m.userId, matchId: c.activeSiblingId } },
                select: { id: true },
            });
            if (dupe) {
                await db.userMatchAssignment.delete({ where: { id: m.assignmentId } });
                undoLog.push({ assignmentId: m.assignmentId, oldMatchId: c.cancelledMatchId, newMatchId: c.activeSiblingId, action: "DELETED (dupe)" });
            } else {
                await db.userMatchAssignment.update({
                    where: { id: m.assignmentId },
                    data: { matchId: c.activeSiblingId },
                });
                undoLog.push({ assignmentId: m.assignmentId, oldMatchId: c.cancelledMatchId, newMatchId: c.activeSiblingId, action: "MOVED" });
            }
        }
    }

    console.log("=== GERİ ALMA LOGU (sakla!) ===");
    console.log(JSON.stringify(undoLog, null, 2));
    console.log(`\n${undoLog.length} atama işlendi. ${candidates.length} sahte-iptal satırı düzeltildi.`);
    console.log("İptal satırlarının cancelledAt değeri KORUNDU (tarihsel kayıt).");
}

async function main() {
    const cmd = process.argv[2];
    if (cmd === "report") {
        await report();
    } else if (cmd === "apply") {
        await apply();
    } else {
        console.error("Kullanım: npx ts-node scripts/repair-false-cancellations.ts <report|apply>");
        process.exit(1);
    }
    await db.$disconnect();
}

main().catch(async (e) => {
    console.error("HATA:", e);
    await db.$disconnect();
    process.exit(1);
});
