import { db } from "../src/db";

/**
 * TEK SEFERLİK ONARIM — salon adı varyasyonu kaynaklı mükerrer maç.
 *
 * ARKA PLAN: `contentKey` salon adını içeriyor. Federasyon aynı fiziksel salonu bir dosyada
 * "METRO ENERJİ SPOR SALONU", sonra "FENERBAHÇE METRO ENERJİ SPOR SALONU" olarak yazınca
 * contentKey değişiyor → eski/yeni satır birbirini tanımıyor, ikisi de aktif kalıp kullanıcıya
 * iki maç olarak görünüyor. detect/repair-key-mismatch ve consolidate script'leri
 * `(tarih,saat,salon)` slotuna göre grupladığı için salon farkını yakalayamıyor.
 *
 * Canlı DB taramasında (2026-09-09) SADECE 2 çift bulundu — ikisi de "METRO ENERJİ SPOR
 * SALONU" ↔ "FENERBAHÇE METRO ENERJİ SPOR SALONU" (aynı salon, 09-09'da "FENERBAHÇE " öneki
 * eklendi). Genel bir script yerine bu iki çifti elle enumerate ediyoruz — yanlış pozitif
 * riski sıfır. Yeni bir çift çıkarsa buraya eklenip tekrar çalıştırılır.
 *
 * Her çiftte: KANONİK = daha yeni (createdAt) satır. Kanonik-dışı satırdaki atamalar:
 *   - kişi kanonikte de varsa            -> kanonik-dışı atama SİLİNİR (dupe)
 *   - kişi kanonik kadroda ismen varsa   -> atama kanoniğe TAŞINIR
 *   - kişi kanonik kadroda YOKSA         -> atama SİLİNİR (gerçek çıkarılma — yerine başkası)
 * Kanonik-dışı satır boşalırsa cancelReason ile iptal edilir. Kanonik satıra dokunulmaz.
 *
 * KULLANIM:
 *   npx ts-node scripts/repair-salon-rename-duplicates.ts report
 *   npx ts-node scripts/repair-salon-rename-duplicates.ts apply
 */

const CANCEL_REASON = "Salon adı varyasyonu — mükerrer stale kayıt temizliği";

// Elle doğrulanmış çiftler: [eski (stale) satır id, yeni (kanonik) satır id]
const PAIRS: { staleId: number; canonicalId: number; note: string }[] = [
    { staleId: 222732, canonicalId: 229139, note: "13.09 19:00 FENERBAHÇE TARFİN - BALKAN BOTEVGRAD (kadro birebir aynı)" },
    { staleId: 228837, canonicalId: 229142, note: "11.09 16:30 FENERBAHÇE - DARICA BASKETBOL FENERİ (ESER FIRIL → MERVE GÜLDAŞ değişti)" },
];

interface Row {
    id: number;
    macAdi: string;
    salon: string | null;
    cancelledAt: Date | null;
    hakemler: string[];
    masaGorevlileri: string[];
    saglikcilar: string[];
    istatistikciler: string[];
    gozlemciler: string[];
    sahaKomiserleri: string[];
}

function everyoneIn(r: Row): string[] {
    return [...r.hakemler, ...r.masaGorevlileri, ...r.saglikcilar,
        ...r.istatistikciler, ...r.gozlemciler, ...r.sahaKomiserleri];
}

async function plan() {
    const out: {
        staleId: number; canonicalId: number; note: string;
        moves: { assignmentId: number; userId: number; name: string }[];
        dupes: { assignmentId: number; userId: number; name: string }[];
        removals: { assignmentId: number; userId: number; name: string }[];
    }[] = [];

    for (const p of PAIRS) {
        const [stale, canonical] = await Promise.all([
            db.parsedMatch.findUnique({ where: { id: p.staleId }, select: rowSelect() }),
            db.parsedMatch.findUnique({ where: { id: p.canonicalId }, select: rowSelect() }),
        ]);
        if (!stale || !canonical) {
            console.warn(`[atla] çift ${p.staleId}/${p.canonicalId} — satır bulunamadı (belki zaten işlendi)`);
            continue;
        }
        if (stale.cancelledAt) {
            console.warn(`[atla] stale satır ${p.staleId} zaten iptal — bu çift işlenmiş`);
            continue;
        }

        const canonNames = new Set(everyoneIn(canonical as Row).map(n => n.trim().toLowerCase()));
        const canonAsgs = await db.userMatchAssignment.findMany({
            where: { matchId: p.canonicalId }, select: { userId: true },
        });
        const canonUserIds = new Set(canonAsgs.map(a => a.userId));

        const staleAsgs = await db.userMatchAssignment.findMany({
            where: { matchId: p.staleId },
            select: { id: true, userId: true, nameInSpreadsheet: true },
        });

        const moves: any[] = [], dupes: any[] = [], removals: any[] = [];
        for (const a of staleAsgs) {
            const rec = { assignmentId: a.id, userId: a.userId, name: a.nameInSpreadsheet };
            if (canonUserIds.has(a.userId)) dupes.push(rec);
            else if (canonNames.has(a.nameInSpreadsheet.trim().toLowerCase())) moves.push(rec);
            else removals.push(rec);
        }
        out.push({ staleId: p.staleId, canonicalId: p.canonicalId, note: p.note, moves, dupes, removals });
    }
    return out;
}

function rowSelect() {
    return {
        id: true, macAdi: true, salon: true, cancelledAt: true,
        hakemler: true, masaGorevlileri: true, saglikcilar: true,
        istatistikciler: true, gozlemciler: true, sahaKomiserleri: true,
    } as const;
}

async function report() {
    const plans = await plan();
    for (const pl of plans) {
        console.log(`\n[${pl.note}]  stale ${pl.staleId} → kanonik ${pl.canonicalId}`);
        if (pl.moves.length) console.log(`  → taşınacak: ${pl.moves.map(m => m.name).join(", ")}`);
        if (pl.dupes.length) console.log(`  → silinecek (kanonikte var): ${pl.dupes.map(m => m.name).join(", ")}`);
        if (pl.removals.length) console.log(`  → silinecek (gerçek çıkarılma): ${pl.removals.map(m => m.name).join(", ")}`);
    }
    const t = plans.reduce((s, p) => ({ m: s.m + p.moves.length, d: s.d + p.dupes.length, r: s.r + p.removals.length }), { m: 0, d: 0, r: 0 });
    console.log(`\n=== ÖZET === çift: ${plans.length}, taşıma: ${t.m}, dupe silme: ${t.d}, gerçek-çıkarılma silme: ${t.r}`);
}

async function apply() {
    const plans = await plan();
    const undoLog: any[] = [];
    let cancelledRows = 0;

    for (const pl of plans) {
        for (const m of pl.moves) {
            const dupe = await db.userMatchAssignment.findUnique({
                where: { userId_matchId: { userId: m.userId, matchId: pl.canonicalId } }, select: { id: true },
            });
            if (dupe && dupe.id !== m.assignmentId) {
                await db.userMatchAssignment.delete({ where: { id: m.assignmentId } });
                undoLog.push({ assignmentId: m.assignmentId, userId: m.userId, oldMatchId: pl.staleId, newMatchId: null, action: "DELETED (race dupe)" });
            } else {
                await db.userMatchAssignment.update({ where: { id: m.assignmentId }, data: { matchId: pl.canonicalId } });
                undoLog.push({ assignmentId: m.assignmentId, userId: m.userId, oldMatchId: pl.staleId, newMatchId: pl.canonicalId, action: "MOVED" });
            }
        }
        for (const d of [...pl.dupes, ...pl.removals]) {
            await db.userMatchAssignment.delete({ where: { id: d.assignmentId } });
            undoLog.push({ assignmentId: d.assignmentId, userId: d.userId, oldMatchId: pl.staleId, newMatchId: null, action: pl.removals.includes(d) ? "DELETED (genuine removal)" : "DELETED (dupe)" });
        }

        const remaining = await db.userMatchAssignment.count({ where: { matchId: pl.staleId } });
        if (remaining === 0) {
            await db.parsedMatch.update({ where: { id: pl.staleId }, data: { cancelledAt: new Date(), cancelReason: CANCEL_REASON } });
            cancelledRows++;
        }
    }

    console.log("=== GERİ ALMA LOGU (sakla!) ===");
    console.log(JSON.stringify(undoLog, null, 2));
    console.log(`\n${undoLog.length} atama işlendi. ${cancelledRows} stale satır iptal işaretlendi.`);
    console.log("Kanonik satırlara HİÇ dokunulmadı.");
}

async function main() {
    const cmd = process.argv[2];
    if (cmd === "report") await report();
    else if (cmd === "apply") await apply();
    else { console.error("Kullanım: npx ts-node scripts/repair-salon-rename-duplicates.ts <report|apply>"); process.exit(1); }
    await db.$disconnect();
}

main().catch(async (e) => { console.error("HATA:", e); await db.$disconnect(); process.exit(1); });
