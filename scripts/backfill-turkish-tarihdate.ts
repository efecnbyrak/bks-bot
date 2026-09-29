import { db } from "../src/db";
import { parseTarihDate } from "../src/db-writer";

/**
 * Eski `parseTarihDate` regex'i sadece sayısal DD.MM.YYYY formatını tanıyordu; "20 Aralık 2025
 * Cumartesi" gibi uzun Türkçe tarihler NULL `tarihDate` bırakıyordu (568 satır, 2026-09-29'da
 * tespit edildi — OKUL İL VE İLÇE, ARŞİV TBF-FIBA-MİLLİ MAÇLAR, ARŞİV ÖZEL LİG VE ÜNİVERSİTE
 * kaynaklı). `db-writer.ts`'teki parser artık bu formatı da destekliyor — bu script yeni
 * parser'ı geçmişte yazılmış NULL satırlara uygulayıp sadece `tarihDate` alanını doldurur.
 *
 * KULLANIM:
 *   npx ts-node scripts/backfill-turkish-tarihdate.ts report   -> SADECE OKUMA, ne değişecek listeler
 *   npx ts-node scripts/backfill-turkish-tarihdate.ts apply     -> tarihDate'i doldurur (geri alma logu basar)
 *
 * GÜVENLİK: SADECE `parsed_matches.tarihDate` UPDATE edilir. Hiçbir satır silinmez, hiçbir
 * başka alana (sezon, matchKey, contentKey, cancelledAt...) dokunulmaz.
 */

async function main() {
    const mode = process.argv[2];
    if (mode !== "report" && mode !== "apply") {
        console.error("Kullanım: npx ts-node scripts/backfill-turkish-tarihdate.ts report|apply");
        process.exit(1);
    }

    const nullRows = await db.parsedMatch.findMany({
        where: { tarihDate: null },
        select: { id: true, macAdi: true, tarih: true, sezon: true, kaynakDosya: true },
    });

    const fixable: { id: number; macAdi: string; oldTarih: string; newTarihDate: Date }[] = [];
    const stillUnparseable: { id: number; macAdi: string; tarih: string }[] = [];

    for (const row of nullRows) {
        const parsed = parseTarihDate(row.tarih);
        if (parsed) {
            fixable.push({ id: row.id, macAdi: row.macAdi, oldTarih: row.tarih, newTarihDate: parsed });
        } else {
            stillUnparseable.push({ id: row.id, macAdi: row.macAdi, tarih: row.tarih });
        }
    }

    console.log(`Toplam NULL tarihDate satırı: ${nullRows.length}`);
    console.log(`Yeni parser ile düzeltilebilecek: ${fixable.length}`);
    console.log(`Hâlâ parse edilemeyen (dokunulmaz, elle incelenmeli): ${stillUnparseable.length}`);

    if (stillUnparseable.length > 0) {
        console.log("\n--- Hâlâ parse edilemeyenler (örnek 10) ---");
        for (const r of stillUnparseable.slice(0, 10)) {
            console.log(`  #${r.id} "${r.macAdi}" tarih="${r.tarih}"`);
        }
    }

    if (mode === "report") {
        console.log("\n--- Düzeltilecek örnekler (ilk 10) ---");
        for (const r of fixable.slice(0, 10)) {
            console.log(`  #${r.id} "${r.macAdi}" "${r.oldTarih}" -> ${r.newTarihDate.toISOString().slice(0, 10)}`);
        }
        console.log("\nUygulamak için: npx ts-node scripts/backfill-turkish-tarihdate.ts apply");
        return;
    }

    // apply
    const undoLog: { id: number; before: null; after: string }[] = [];
    for (const r of fixable) {
        await db.parsedMatch.update({
            where: { id: r.id },
            data: { tarihDate: r.newTarihDate },
        });
        undoLog.push({ id: r.id, before: null, after: r.newTarihDate.toISOString() });
    }

    const logPath = `/tmp/backfill-turkish-tarihdate-${Date.now()}.json`;
    await require("fs/promises").writeFile(logPath, JSON.stringify(undoLog, null, 2));
    console.log(`\n${fixable.length} satır güncellendi. Geri alma logu: ${logPath}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => db.$disconnect());
