import { db } from "../src/db";

/**
 * ONARIM — 3x3 "satır numarası kayması" kaynaklı sahte iptallerin geçmişteki artığı.
 *
 * ARKA PLAN (2026-11-10): `match-parser.ts`/`db-writer.ts` düzeltildi (3x3 için
 * contentKey ayırt edicisi artık fiziksel Excel satır numarası değil, grup-içi
 * sıra) — ama bu, GEÇMİŞTE zaten "Kadro güncellendi" ile zincirleme iptal edilmiş
 * satırları onarmaz. `scripts/detect-3x3-row-shift-cancellations.ts` bu örüntüye
 * giren 14 maç grubu / 61 satır / 78 kişi tespit etti; bu gruplardan 9'unda hiçbir
 * AKTİF satır yok (A1 `repair-false-cancellations.ts` bu durumu KAPSAMAZ — o script
 * aynı contentKey'e sahip aktif bir kardeş arıyor, burada her satırın contentKey'i
 * FARKLI).
 *
 * YÖNTEM: Her grupta (mac_adi+tarih+saat+salon) EN SON güncellenen + EN DOLU
 * kadrolu iptal satırı "federasyonun gerçek son hâli" kabul edilip iptali geri
 * alınır (cancelledAt=null). Diğer kardeşler iptal bırakılır (yedekleri kalır).
 * "Ödendi" (paidAt) işaretli atamalar olan satırlara DOKUNULMAZ (ayrıca raporlanır).
 *
 * KULLANIM:
 *   npx ts-node scripts/repair-3x3-row-shift-cancellations.ts            # SADECE rapor
 *   npx ts-node scripts/repair-3x3-row-shift-cancellations.ts --apply    # YEDEK AL + uygula
 */

function norm(s: string | null | undefined): string {
    return (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

interface Row {
    id: number; macAdi: string; tarih: string; saat: string | null; salon: string | null;
    cancelledAt: Date | null; cancelReason: string | null; updatedAt: Date;
    hakemler: string[]; masaGorevlileri: string[]; saglikcilar: string[];
    istatistikciler: string[]; gozlemciler: string[]; sahaKomiserleri: string[];
}

function crewSize(r: Row): number {
    return r.hakemler.length + r.masaGorevlileri.length + r.saglikcilar.length +
        r.istatistikciler.length + r.gozlemciler.length + r.sahaKomiserleri.length;
}

async function main() {
    const apply = process.argv.includes("--apply");

    const rows = await db.parsedMatch.findMany({
        where: { macAdi: "3x3 - 3x3" },
        select: {
            id: true, macAdi: true, tarih: true, saat: true, salon: true,
            cancelledAt: true, cancelReason: true, updatedAt: true,
            hakemler: true, masaGorevlileri: true, saglikcilar: true,
            istatistikciler: true, gozlemciler: true, sahaKomiserleri: true,
        },
    });

    const groups = new Map<string, Row[]>();
    for (const r of rows) {
        const key = `${norm(r.macAdi)}|${norm(r.tarih)}|${norm(r.saat)}|${norm(r.salon)}`;
        const list = groups.get(key) ?? [];
        list.push(r);
        groups.set(key, list);
    }

    // Sadece "aktif satır hiç yok ama ≥2 iptal" grupları onarılır — aktif satırı
    // olan gruplar zaten federasyonun o anki kararını yansıtıyor, dokunulmaz.
    const toReactivate: { row: Row; groupKey: string; lostCrew: Row[] }[] = [];
    for (const [key, list] of groups) {
        const active = list.filter(r => r.cancelledAt === null);
        const cancelled = list.filter(r => r.cancelledAt !== null);
        if (active.length > 0 || cancelled.length < 2) continue;
        const rowShiftCancelled = cancelled.filter(r => r.cancelReason === "Kadro güncellendi");
        if (rowShiftCancelled.length === 0) continue;

        // En son güncellenen + en dolu kadrolu satır "gerçek son hâl".
        const best = cancelled.reduce((a, b) => {
            if (crewSize(b) !== crewSize(a)) return crewSize(b) > crewSize(a) ? b : a;
            return b.updatedAt > a.updatedAt ? b : a;
        });
        toReactivate.push({ row: best, groupKey: key, lostCrew: cancelled.filter(r => r.id !== best.id) });
    }

    console.log(`[ONARIM] Aktifsiz 3x3 grubu: ${toReactivate.length}`);
    for (const { row, groupKey, lostCrew } of toReactivate) {
        const names = [...row.hakemler, ...row.masaGorevlileri, ...row.saglikcilar, ...row.istatistikciler, ...row.gozlemciler, ...row.sahaKomiserleri];
        console.log(`\n[GRUP] ${groupKey}`);
        console.log(`   Aktif edilecek: #${row.id} (kadro: ${names.join(", ") || "(boş)"})`);
        console.log(`   İptal kalacak: ${lostCrew.map(r => `#${r.id}`).join(", ")}`);
    }

    if (!apply) {
        console.log("\n[ONARIM] Sadece rapor. Uygulamak için --apply.");
        return;
    }
    if (toReactivate.length === 0) {
        console.log("[ONARIM] Aktif edilecek satır yok.");
        return;
    }

    // Aktif edilecek satırların ÜZERİNDE "Ödendi" işaretli atama varsa dokunmuyoruz
    // (zaten bu satırlar iptaldeyken paidAt yazılmış olması normalde beklenmez ama
    // güvenlik için kontrol ediliyor).
    const { writeFileSync, mkdirSync } = await import("fs");
    const path = await import("path");
    const dir = path.join(process.cwd(), "backups");
    mkdirSync(dir, { recursive: true });
    const backupFile = path.join(dir, `3x3-row-shift-reactivate-${new Date().toISOString().slice(0, 10)}.json`);
    writeFileSync(backupFile, JSON.stringify(toReactivate, null, 2));
    console.log(`[ONARIM] Yedek: ${backupFile}`);

    let applied = 0;
    for (const { row } of toReactivate) {
        const paidAssignments = await db.userMatchAssignment.count({ where: { matchId: row.id, paidAt: { not: null } } });
        if (paidAssignments > 0) {
            console.log(`   #${row.id} ATLANDI — ödendi işaretli atama var, elle kontrol et.`);
            continue;
        }
        await db.parsedMatch.update({ where: { id: row.id }, data: { cancelledAt: null, cancelReason: null } });
        applied++;
    }
    console.log(`[ONARIM] Aktif edilen satır: ${applied}/${toReactivate.length}`);
}

main()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => db.$disconnect());
