import { db } from "../src/db";
import { MATCH_DATA_SELECT, parsedRowToMatchData } from "../src/db-writer";
import { buildUserAssignments } from "../src/user-matcher";

/**
 * ONARIM (adım 2/2) — `repair-3x3-row-shift-cancellations.ts` ile aktif edilen
 * ParsedMatch satırlarının kadrosundaki isimleri `UserMatchAssignment`'a yazar.
 *
 * ARKA PLAN: Adım 1 sadece `ParsedMatch.cancelledAt`'i null yaptı — bu satırların
 * `UserMatchAssignment` karşılığı hiçbir zaman oluşmamıştı (satırlar iptaldeyken
 * BOT hiç atama yazmamıştı). `buildUserAssignments` normal senkron akışında
 * kullanılan AYNI fonksiyon — isim eşleştirmesini ve contentKey bazlı "yeni atama
 * mı" kararını (sahte "yeni maça atandınız" bildirimi göndermemek için) olduğu
 * gibi uygular.
 *
 * KULLANIM: npx ts-node scripts/repair-3x3-row-shift-assignments.ts
 * DİKKAT: bu adım 1'in TERSİ değil — SADECE ekler/upsert eder, DB'den satır silmez.
 */

const REACTIVATED_MATCH_IDS = [291919, 485633, 377273, 290570, 291920, 290567, 290097, 291193];

async function main() {
    const rows = await db.parsedMatch.findMany({
        where: { id: { in: REACTIVATED_MATCH_IDS }, cancelledAt: null },
        select: MATCH_DATA_SELECT,
    });
    console.log(`[ONARIM 2/2] Aktif satır bulundu: ${rows.length}/${REACTIVATED_MATCH_IDS.length}`);

    const matches = rows.map(parsedRowToMatchData);
    const matchIds = rows.map(r => r.id);

    const { assignmentCount, newAssignments } = await buildUserAssignments(matches, matchIds);
    console.log(`[ONARIM 2/2] Yazılan/güncellenen atama: ${assignmentCount}`);
    console.log(`[ONARIM 2/2] "Yeni atama" sayılıp bildirim tetikleyebilecek: ${newAssignments.length}`);
    if (newAssignments.length > 0) {
        console.log("[ONARIM 2/2] ⚠ Bu script bildirim GÖNDERMEZ (sadece DB yazar) — aşağıdakiler normal senkronda 'yeni atama' sayılabilirdi, beklenmedik olmamalı:");
        for (const n of newAssignments) console.log("   ", JSON.stringify(n));
    }

    const finalCount = await db.userMatchAssignment.count({ where: { matchId: { in: REACTIVATED_MATCH_IDS } } });
    console.log(`[ONARIM 2/2] Doğrulama — bu 8 maçta toplam UserMatchAssignment: ${finalCount}`);
}

main()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => db.$disconnect());
