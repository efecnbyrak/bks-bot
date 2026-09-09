import { db } from "../src/db";
import { nameMatches } from "../src/lib/match-parser";

/**
 * ONARIM — "anahtar uyuşmazlığı" kaynaklı mükerrer maçlar (Senaryo 1: placeholder isim
 * → gerçek isim). A1'in (`repair-false-cancellations.ts`) KAPSAMADIĞI bir durum — orası
 * sadece AYNI contentKey'e sahip satırları (kadro kademeli doldurma) eşleştirir. Burada
 * eski/yeni satırların contentKey'i FARKLI (çünkü mac_adi değişti), o yüzden A1 bunları
 * hiç görmez.
 *
 * KAPSAM: Sadece aynı (tarih, saat, salon) üçlüsünde, farklı contentKey'e sahip, ve
 * personel örtüşmesi DOĞRULANMIŞ satırlar arasında atama taşır. Kanonik satır seçiminde
 * placeholder isimli satırlar ("Daha Sonra Belirlenecek" vb.) asla kanonik olamaz —
 * gerçek isimli satır her zaman daha güncel kabul edilir.
 *
 * A1'DEN FARKI: A1 `cancelledAt` dolu satırları kaynak alır (zaten iptal edilmiş sahte
 * iptaller). Burada kaynak satırlar HÂLÂ AKTİF (`cancelledAt: null`) — hiç iptal
 * edilmemiş, DB'de iki ayrı aktif satır olarak duruyorlar. Bu yüzden onarım hem
 * atamaları taşır HEM DE kaynak (eski/placeholder) satırı ayrı bir `cancelReason` ile
 * iptal işaretler — A1'in aradığı `cancelReason` metniyle KARIŞMAZ.
 *
 * GÜVENLİK: Sadece `user_match_assignments.matchId` ve `parsed_matches.cancelledAt`/
 * `cancelReason`'a dokunur. Uygunluk formu / kullanıcı profili / duyuru tablolarına HİÇ
 * dokunmaz. Belirsiz (örtüşme doğrulanamayan) atamalara DOKUNMAZ.
 *
 * KULLANIM:
 *   npx ts-node scripts/repair-key-mismatch-duplicates.ts report   -> SADECE OKUMA
 *   npx ts-node scripts/repair-key-mismatch-duplicates.ts apply     -> düzeltmeyi uygular
 */

const CANCEL_REASON = "Anahtar uyuşmazlığı (isim/tarih değişimi) — otomatik onarım";

// Not: düz /belirlenecek/i JS'de İ→i̇ (combining dot) dönüşümü yüzünden Türkçe büyük
// harfli "BELİRLENECEK" ile eşleşmiyor — İ'yi elle normalize ediyoruz.
//
// "ÖN ELEMEDEN GELEN X..." de placeholder — turnuva eleme aşamasında rakip henüz
// netleşmemişken federasyonun kullandığı geçici isim (canlı DB'de 5 örnekte doğrulandı).
function isPlaceholderName(macAdi: string): boolean {
    const norm = macAdi.replace(/İ/g, "i").toLowerCase();
    return norm.includes("belirlenecek") || norm.includes("ön elemeden gelen");
}

interface ActiveRow {
    id: number;
    contentKey: string | null;
    macAdi: string;
    tarih: string;
    saat: string | null;
    salon: string | null;
    createdAt: Date;
    hakemler: string[];
    masaGorevlileri: string[];
    saglikcilar: string[];
    istatistikciler: string[];
    gozlemciler: string[];
    sahaKomiserleri: string[];
}

interface Assignment {
    id: number;
    userId: number;
    matchId: number;
    nameInSpreadsheet: string;
    firstName?: string;
    lastName?: string;
}

function personCount(r: ActiveRow): number {
    return r.hakemler.length + r.masaGorevlileri.length + r.saglikcilar.length +
        r.istatistikciler.length + r.gozlemciler.length + r.sahaKomiserleri.length;
}

function everyoneIn(r: ActiveRow): string[] {
    return [...r.hakemler, ...r.masaGorevlileri, ...r.saglikcilar,
        ...r.istatistikciler, ...r.gozlemciler, ...r.sahaKomiserleri];
}

function personIsInRow(a: Assignment, r: ActiveRow): boolean {
    const target = a.nameInSpreadsheet.trim().toLowerCase();
    const everyone = everyoneIn(r);
    if (everyone.some(n => n.trim().toLowerCase() === target)) return true;
    if (a.firstName && a.lastName) {
        return everyone.some(n => nameMatches(n, a.firstName!, a.lastName!));
    }
    return false;
}

interface RepairCandidate {
    tarih: string; saat: string | null; salon: string | null;
    canonicalRowId: number; canonicalMacAdi: string;
    movable: { assignmentId: number; userId: number; nameInSpreadsheet: string; fromRowId: number }[];
    // Kaynak satırlar: taşındıktan sonra üzerinde hiç atama kalmayanlar iptal edilecek
    sourceRowIds: number[];
}

async function analyze(): Promise<RepairCandidate[]> {
    const rows: ActiveRow[] = await db.parsedMatch.findMany({
        where: { cancelledAt: null },
        select: {
            id: true, contentKey: true, macAdi: true, tarih: true, saat: true, salon: true, createdAt: true,
            hakemler: true, masaGorevlileri: true, saglikcilar: true,
            istatistikciler: true, gozlemciler: true, sahaKomiserleri: true,
        },
    });

    const byTimeSlot = new Map<string, ActiveRow[]>();
    for (const r of rows) {
        if (!r.saat || !r.salon) continue;
        const key = `${r.tarih}|${r.saat}|${r.salon.trim().toLowerCase()}`;
        const arr = byTimeSlot.get(key) ?? [];
        arr.push(r);
        byTimeSlot.set(key, arr);
    }

    const candidates: RepairCandidate[] = [];

    for (const [, rawGroupRows] of byTimeSlot) {
        if (rawGroupRows.length < 2) continue;

        // AYNI contentKey'li satırlar A1'in alanı (kadro kademeli doldurma) — bunlara
        // BURADA dokunulmaz. detect script'indeki gerekçenin aynısı: önce contentKey'e
        // göre alt-kümelere ayır, her alt-kümeden TEK temsilci seç, Senaryo-1 mantığı
        // sadece temsilciler arasında çalışsın.
        const byContentKey = new Map<string, ActiveRow[]>();
        for (const r of rawGroupRows) {
            const key = r.contentKey ?? `__null_${r.id}`;
            const arr = byContentKey.get(key) ?? [];
            arr.push(r);
            byContentKey.set(key, arr);
        }
        const groupRows: ActiveRow[] = [...byContentKey.values()].map(sameKeyRows =>
            sameKeyRows.reduce((best, r) => {
                const bp = personCount(best), rp = personCount(r);
                if (rp !== bp) return rp > bp ? r : best;
                return r.createdAt > best.createdAt ? r : best;
            })
        );
        if (groupRows.length < 2) continue;

        const rowIds = groupRows.map(r => r.id);
        const rawAssignments = await db.userMatchAssignment.findMany({
            where: { matchId: { in: rowIds } },
            select: {
                id: true, userId: true, matchId: true, nameInSpreadsheet: true,
                user: { select: { referee: { select: { firstName: true, lastName: true } }, official: { select: { firstName: true, lastName: true } } } },
            },
        });
        const assignments: Assignment[] = rawAssignments.map((r: any) => ({
            id: r.id, userId: r.userId, matchId: r.matchId, nameInSpreadsheet: r.nameInSpreadsheet,
            firstName: r.user?.referee?.firstName ?? r.user?.official?.firstName,
            lastName: r.user?.referee?.lastName ?? r.user?.official?.lastName,
        }));
        if (assignments.length === 0) continue;

        const assignmentsByRowId = new Map<number, Assignment[]>();
        for (const a of assignments) {
            const arr = assignmentsByRowId.get(a.matchId) ?? [];
            arr.push(a);
            assignmentsByRowId.set(a.matchId, arr);
        }

        // Kanonik satır: placeholder isimli satırlar havuzdan çıkarılır (kadrosu dolu
        // olsa bile asla kanonik olmaz), kalanların en dolu kadrolusu seçilir. Kadro
        // sayısı EŞİTSE (canlı DB'de gözlemlendi: matchId 228509 vs 229029, ikisi de
        // 10 kişi) `createdAt` tie-breaker — daha SONRA oluşturulan satır federasyonun
        // güncellediği/netleştirdiği satırdır.
        const nonPlaceholderRows = groupRows.filter(r => !isPlaceholderName(r.macAdi));
        const canonicalPool = nonPlaceholderRows.length > 0 ? nonPlaceholderRows : groupRows;
        const canonical = canonicalPool.reduce((best, r) => {
            const bp = personCount(best), rp = personCount(r);
            if (rp !== bp) return rp > bp ? r : best;
            return r.createdAt > best.createdAt ? r : best;
        });

        const movable: RepairCandidate["movable"] = [];
        const sourceRowIds = new Set<number>();

        for (const r of groupRows) {
            if (r.id === canonical.id) continue;
            const asgs = assignmentsByRowId.get(r.id) ?? [];
            for (const a of asgs) {
                const alreadyOnCanonical = (assignmentsByRowId.get(canonical.id) ?? []).some(ca => ca.userId === a.userId);
                if (alreadyOnCanonical || personIsInRow(a, canonical)) {
                    movable.push({ assignmentId: a.id, userId: a.userId, nameInSpreadsheet: a.nameInSpreadsheet, fromRowId: r.id });
                    sourceRowIds.add(r.id);
                }
                // Örtüşme doğrulanamayan atamalara BİLEREK dokunulmuyor (belirsiz —
                // detect script'inde "BELİRSİZ" olarak raporlanıyor).
            }
        }

        if (movable.length === 0) continue;

        candidates.push({
            tarih: canonical.tarih, saat: canonical.saat, salon: canonical.salon,
            canonicalRowId: canonical.id, canonicalMacAdi: canonical.macAdi,
            movable, sourceRowIds: [...sourceRowIds],
        });
    }

    return candidates;
}

async function report() {
    const candidates = await analyze();
    let totalMovable = 0;
    for (const c of candidates) {
        totalMovable += c.movable.length;
        console.log(`\n[${c.tarih} ${c.saat} — ${c.salon}]`);
        console.log(`  → kanonik satır: ${c.canonicalRowId} "${c.canonicalMacAdi}"`);
        console.log(`  → kaynak satır(lar): ${c.sourceRowIds.join(", ")}`);
        console.log(`  → taşınacak atama: ${c.movable.length} (${c.movable.map(m => m.nameInSpreadsheet).join(", ")})`);
    }
    console.log(`\n=== ÖZET ===`);
    console.log(`Düzeltilecek zaman/salon grubu: ${candidates.length}`);
    console.log(`Taşınacak atama: ${totalMovable}`);
    console.log(`\n(apply modunda: bu atamaların matchId'si kanonik satıra güncellenecek,`);
    console.log(` hedefte çakışan atama varsa eski silinecek, kaynak satır(lar) üzerinde`);
    console.log(` hiç atama kalmazsa cancelReason="${CANCEL_REASON}" ile iptal işaretlenecek.`);
    console.log(` A1'in aradığı cancelReason metniyle KARIŞMAZ. Geri alma logu basılacak.)`);
}

async function apply() {
    const candidates = await analyze();
    const undoLog: { assignmentId: number; userId: number; oldMatchId: number; newMatchId: number; action: string }[] = [];
    const touchedSourceRows = new Set<number>();

    for (const c of candidates) {
        for (const m of c.movable) {
            const dupe = await db.userMatchAssignment.findUnique({
                where: { userId_matchId: { userId: m.userId, matchId: c.canonicalRowId } },
                select: { id: true },
            });
            if (dupe && dupe.id !== m.assignmentId) {
                await db.userMatchAssignment.delete({ where: { id: m.assignmentId } });
                undoLog.push({ assignmentId: m.assignmentId, userId: m.userId, oldMatchId: m.fromRowId, newMatchId: c.canonicalRowId, action: "DELETED (dupe)" });
            } else {
                await db.userMatchAssignment.update({
                    where: { id: m.assignmentId },
                    data: { matchId: c.canonicalRowId },
                });
                undoLog.push({ assignmentId: m.assignmentId, userId: m.userId, oldMatchId: m.fromRowId, newMatchId: c.canonicalRowId, action: "MOVED" });
            }
            touchedSourceRows.add(m.fromRowId);
        }
    }

    // Kaynak satırlardan üzerinde artık hiç atama kalmayanları iptal işaretle.
    let cancelledRows = 0;
    for (const rowId of touchedSourceRows) {
        const remaining = await db.userMatchAssignment.count({ where: { matchId: rowId } });
        if (remaining === 0) {
            await db.parsedMatch.update({
                where: { id: rowId },
                data: { cancelledAt: new Date(), cancelReason: CANCEL_REASON },
            });
            cancelledRows++;
        }
    }

    console.log("=== GERİ ALMA LOGU (sakla!) ===");
    console.log(JSON.stringify(undoLog, null, 2));
    console.log(`\n${undoLog.length} atama işlendi. ${cancelledRows} kaynak satır iptal işaretlendi.`);
    console.log("Kanonik satırlara HİÇ dokunulmadı.");
}

async function main() {
    const cmd = process.argv[2];
    if (cmd === "report") {
        await report();
    } else if (cmd === "apply") {
        await apply();
    } else {
        console.error("Kullanım: npx ts-node scripts/repair-key-mismatch-duplicates.ts <report|apply>");
        process.exit(1);
    }
    await db.$disconnect();
}

main().catch(async (e) => {
    console.error("HATA:", e);
    await db.$disconnect();
    process.exit(1);
});
