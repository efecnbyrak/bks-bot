import { db } from "../src/db";
import {
    loadConsolidationPlans,
    consolidateActiveContentKeyDuplicates,
    CANCEL_REASON,
    CANCEL_REASON_REMOVAL,
} from "../src/lib/contentkey-consolidator";

/**
 * KONSOLİDASYON CLI — "aynı maç, birden fazla AKTİF ParsedMatch satırı" (aynı contentKey).
 *
 * Asıl mantık `src/lib/contentkey-consolidator.ts`'te (B6 çözümüyle birlikte bot her sync
 * sonunda otomatik çalıştırıyor). Bu dosya sadece elle çalıştırma / rapor + bir kerelik
 * "gerçek çıkarılma" temizliği (apply-with-removals) için ince bir sarmalayıcı.
 *
 * KULLANIM:
 *   npx ts-node scripts/consolidate-active-contentkey-duplicates.ts report              -> SADECE OKUMA
 *   npx ts-node scripts/consolidate-active-contentkey-duplicates.ts apply               -> mükerrerleri birleştirir
 *   npx ts-node scripts/consolidate-active-contentkey-duplicates.ts apply-with-removals -> + belirsiz (gerçek çıkarılma) temizliği
 *
 * apply ve otomatik akış BELİRSİZ ("gerçek çıkarılma") atamalara DOKUNMAZ. Yalnızca
 * apply-with-removals bunları siler + boşalan stale satırı ayrı cancelReason ile iptal eder.
 */

async function report() {
    const plans = await loadConsolidationPlans();
    let moveCount = 0, dupeCount = 0, siblingCount = 0, ambCount = 0;
    for (const p of plans) {
        const m = p.moves.filter(x => x.action === "MOVE");
        const d = p.moves.filter(x => x.action === "DELETE_DUPE");
        const s = p.moves.filter(x => x.action === "DELETE_ON_SIBLING");
        moveCount += m.length; dupeCount += d.length; siblingCount += s.length; ambCount += p.ambiguous.length;
        console.log(`\n[${p.tarih} ${p.saat ?? "-"} — ${p.salon ?? "-"}] "${p.macAdi}" (ck ${p.contentKey.slice(0, 8)})`);
        console.log(`  satırlar: ${p.rowIds.join(", ")}  → kanonik: ${p.canonicalRowId}`);
        if (m.length) console.log(`  → taşınacak (kanonik kadroda): ${m.map(x => x.nameInSpreadsheet).join(", ")}`);
        if (d.length) console.log(`  → silinecek (kanonikte zaten var): ${d.map(x => x.nameInSpreadsheet).join(", ")}`);
        if (s.length) console.log(`  → silinecek (başka aktif kardeşte var): ${s.map(x => x.nameInSpreadsheet).join(", ")}`);
        if (p.ambiguous.length) console.log(`  → BELİRSİZ (DOKUNULMAZ, elle incele): ${p.ambiguous.map(x => `${x.nameInSpreadsheet} (satır ${x.fromRowId})`).join(", ")}`);
    }
    console.log(`\n=== ÖZET ===`);
    console.log(`Etkilenen contentKey grubu: ${plans.length}`);
    console.log(`Kanoniğe taşınacak atama:      ${moveCount}`);
    console.log(`Silinecek (kanonikte dupe):    ${dupeCount}`);
    console.log(`Silinecek (kardeşte duruyor):  ${siblingCount}`);
    console.log(`BELİRSİZ = gerçek çıkarılma (apply DOKUNMAZ, apply-with-removals SİLER): ${ambCount}`);
    console.log(`\n(apply: kanonik-dışı satırlardan boşalanlar cancelReason="${CANCEL_REASON}" ile`);
    console.log(` iptal işaretlenir. Kanonik satıra HİÇ dokunulmaz.)`);
    console.log(`(apply-with-removals: yukarıdakilere EK olarak belirsiz atamaları siler +`);
    console.log(` boşalan stale satırı cancelReason="${CANCEL_REASON_REMOVAL}" ile iptal eder.)`);
}

async function apply(withRemovals: boolean) {
    // Elle çalıştırmada NOTIFY_DRY_RUN sarkıntısı olmasın diye dryRun'ı açıkça false veriyoruz.
    const res = await consolidateActiveContentKeyDuplicates({ withRemovals, dryRun: false, log: false });
    console.log("=== GERİ ALMA LOGU (sakla!) ===");
    console.log(JSON.stringify(res.undoLog, null, 2));
    console.log(`\n${res.undoLog.length} atama işlendi (grup: ${res.groups}).`);
    console.log(`  taşınan: ${res.moved}  silinen(dupe): ${res.deletedDupe}  silinen(kardeş): ${res.deletedSibling}` +
        (withRemovals ? `  silinen(çıkarılma): ${res.deletedRemoval}` : ""));
    console.log(`${res.rowsCancelledMerge} satır "${CANCEL_REASON}" ile iptal edildi.`);
    if (withRemovals) console.log(`${res.rowsCancelledRemoval} satır "${CANCEL_REASON_REMOVAL}" ile iptal edildi.`);
    console.log("Kanonik satırlara HİÇ dokunulmadı." + (withRemovals ? "" : " Belirsiz atamalara dokunulmadı."));
}

async function main() {
    const cmd = process.argv[2];
    if (cmd === "report") {
        await report();
    } else if (cmd === "apply") {
        await apply(false);
    } else if (cmd === "apply-with-removals") {
        await apply(true);
    } else {
        console.error("Kullanım: npx ts-node scripts/consolidate-active-contentkey-duplicates.ts <report|apply|apply-with-removals>");
        process.exit(1);
    }
    await db.$disconnect();
}

main().catch(async (e) => {
    console.error("HATA:", e);
    await db.$disconnect();
    process.exit(1);
});
