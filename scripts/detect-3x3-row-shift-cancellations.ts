import { db } from "../src/db";

/**
 * TESPİT (salt okuma) — 3x3 maçlarında "satır numarası kayması" kaynaklı sahte iptaller.
 *
 * ARKA PLAN (2026-11-10): `db-writer.ts` → `contentKeyRaw`, 3x3 maçları (mac_adi ===
 * "3x3 - 3x3") için contentKey'e Excel'deki FİZİKSEL SATIR NUMARASINI (`kaynak_satir`,
 * `match-parser.ts` → `ws.eachRow`'dan taze okunan `row.number`) ekliyor. Federasyon 3x3
 * sayfasını düzenledikçe (satır eklenir/silinir/sıralanır) bu numara kayıyor; her kayışta
 * YENİ bir contentKey/matchKey üretiliyor, eski satır "Kadro güncellendi" ile iptal ediliyor
 * ama kadrosundaki atama yeni satıra hiçbir zaman gerçekten taşınmıyor çünkü ROW_SHIFTED
 * mantığı (`decideAssignmentOutcomes`) AYNI contentKey altında kademeli doldurmayı
 * varsayıyor — contentKey tamamen değiştiğinde bu mantık devreye giremiyor.
 *
 * Bu, A1 (`repair-false-cancellations.ts`, aynı contentKey + farklı matchKey) ve A2
 * (`detect-key-mismatch-duplicates.ts`, placeholder isim/tarih değişimi) script'lerinin
 * KAPSAMADIĞI üçüncü bir sınıf: contentKey + matchKey HER İKİSİ de değişiyor, ama
 * mac_adi + tarih + saat + salon aynı kalıyor (sadece Excel satır sırası değişti).
 *
 * KULLANIM: npx ts-node scripts/detect-3x3-row-shift-cancellations.ts
 * SADECE RAPOR ÜRETİR, DB'ye hiçbir şey YAZMAZ.
 */

function norm(s: string | null | undefined): string {
    return (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function main() {
    const rows = await db.parsedMatch.findMany({
        where: { macAdi: "3x3 - 3x3" },
        select: {
            id: true, macAdi: true, tarih: true, saat: true, salon: true, kategori: true,
            cancelledAt: true, cancelReason: true, createdAt: true, updatedAt: true,
            hakemler: true, masaGorevlileri: true, saglikcilar: true, istatistikciler: true,
            gozlemciler: true, sahaKomiserleri: true,
        },
    });

    // mac_adi + tarih + saat + salon bazlı grupla (contentKey'den FARKLI — fiziksel satır
    // numarası hariç tutulmuş "gerçek" eşleşme anahtarı).
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
        const key = `${norm(r.macAdi)}|${norm(r.tarih)}|${norm(r.saat)}|${norm(r.salon)}`;
        const list = groups.get(key) ?? [];
        list.push(r);
        groups.set(key, list);
    }

    let affectedGroups = 0;
    let affectedRows = 0;
    const lostAssignmentNames = new Set<string>();

    for (const [key, list] of groups) {
        if (list.length < 2) continue; // Tek satır varsa kayma şüphesi yok.
        const active = list.filter(r => r.cancelledAt === null);
        const cancelled = list.filter(r => r.cancelledAt !== null);
        if (cancelled.length < 2) continue; // En az 2 iptal olmalı ("kayma zinciri" belirtisi).
        const rowShiftCancelled = cancelled.filter(r => r.cancelReason === "Kadro güncellendi");
        if (rowShiftCancelled.length === 0) continue;

        affectedGroups++;
        affectedRows += list.length;

        const allRoleNames = (r: typeof list[number]) => [
            ...r.hakemler, ...r.masaGorevlileri, ...r.saglikcilar,
            ...r.istatistikciler, ...r.gozlemciler, ...r.sahaKomiserleri,
        ];
        const activeNames = new Set(active.flatMap(allRoleNames));

        console.log(`\n[GRUP] ${key}`);
        console.log(`   Toplam satır: ${list.length} (aktif: ${active.length}, iptal: ${cancelled.length})`);
        for (const r of list) {
            const names = allRoleNames(r);
            const lostNames = r.cancelledAt ? names.filter(n => !activeNames.has(n)) : [];
            for (const n of lostNames) lostAssignmentNames.add(n);
            console.log(`   #${r.id} ${r.cancelledAt ? `[İPTAL: ${r.cancelReason}]` : "[AKTİF]"} kadro: ${names.join(", ") || "(boş)"}${lostNames.length ? ` ⚠ KAYIP: ${lostNames.join(", ")}` : ""}`);
        }
        if (active.length === 0) {
            console.log("   ⚠⚠ HİÇBİR AKTİF SATIR YOK — bu maç tamamen 'kaybolmuş' durumda.");
        }
    }

    console.log(`\n[ÖZET] Etkilenen grup (maç): ${affectedGroups}, toplam satır: ${affectedRows}`);
    console.log(`[ÖZET] Aktif satıra hiç taşınamamış, kaybolmuş görünen isimler: ${lostAssignmentNames.size}`);
    for (const n of lostAssignmentNames) console.log(`   - ${n}`);
    console.log("\n[BİLGİ] Bu script hiçbir şey YAZMADI — yalnızca rapor üretti.");
}

main()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => db.$disconnect());
