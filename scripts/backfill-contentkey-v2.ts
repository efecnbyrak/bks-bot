import { db } from "../src/db";
import { computeContentKey } from "../src/db-writer";
import { MatchData } from "../src/lib/match-parser";

/**
 * TEK SEFERLİK BACKFILL — contentKey formülü v2 (2026-10-28).
 *
 * Formül iki noktada değişti (web `lib/matches/match-utils.ts` → `contentKey` ile ikiz):
 *   1) İç boşluklar tekleştiriliyor (eskiden sadece trim).
 *   2) 3x3 maçlarında (`3x3 - 3x3`) kaynak satır numarası anahtara ekleniyor — aynı
 *      ad/gün/saatteki birden çok 3x3 maçı artık ayrı maç.
 * Bot yeni satırları zaten yeni formülle yazıyor; bu script mevcut satırların hash'ini
 * yeniler ki eski ve yeni satırlar aynı maç için aynı anahtarı taşısın.
 *
 * Sadece `ParsedMatch.contentKey` sütununa yazar. Atama, iptal, ödeme kaydına DOKUNMAZ.
 *
 * KULLANIM:
 *   npx ts-node scripts/backfill-contentkey-v2.ts report   -> SADECE OKUMA (varsayılan)
 *   npx ts-node scripts/backfill-contentkey-v2.ts apply    -> contentKey'leri günceller
 */

const PAGE = 2000;

interface Row {
    id: number;
    macAdi: string;
    tarih: string;
    saat: string | null;
    kaynakSatir: number | null;
    contentKey: string | null;
    cancelledAt: Date | null;
}

// Belleği şişirmemek için satırlar sayfa sayfa okunur, sadece gereken alanlar seçilir.
async function loadAll(): Promise<Row[]> {
    const out: Row[] = [];
    let cursor = 0;
    for (;;) {
        const page = await db.parsedMatch.findMany({
            where: { id: { gt: cursor } },
            orderBy: { id: "asc" },
            take: PAGE,
            select: { id: true, macAdi: true, tarih: true, saat: true, kaynakSatir: true, contentKey: true, cancelledAt: true },
        });
        if (page.length === 0) break;
        out.push(...page);
        cursor = page[page.length - 1].id;
    }
    return out;
}

function newKey(r: Row): string {
    return computeContentKey({ mac_adi: r.macAdi, tarih: r.tarih, saat: r.saat ?? "", kaynak_satir: r.kaynakSatir ?? undefined } as MatchData);
}

// Aktif satırların eski ve yeni anahtarla kaç gruba düştüğünü karşılaştırır:
// bölünen grup = eski tek grup yeni birden çok grup; birleşen = tersi.
function groupDiff(rows: { r: Row; next: string }[]) {
    const oldToNew = new Map<string, Set<string>>();
    const newToOld = new Map<string, Set<string>>();
    for (const { r, next } of rows) {
        const old = r.contentKey ?? `null#${r.id}`;
        if (!oldToNew.has(old)) oldToNew.set(old, new Set());
        oldToNew.get(old)!.add(next);
        if (!newToOld.has(next)) newToOld.set(next, new Set());
        newToOld.get(next)!.add(old);
    }
    const split = [...oldToNew.entries()].filter(([, s]) => s.size > 1);
    const merged = [...newToOld.entries()].filter(([, s]) => s.size > 1);
    return { oldGroups: oldToNew.size, newGroups: newToOld.size, split, merged };
}

async function main() {
    const cmd = process.argv[2] ?? "report";
    if (cmd !== "report" && cmd !== "apply") {
        console.error("Kullanım: report | apply");
        process.exit(1);
    }

    const all = await loadAll();
    const withNext = all.map(r => ({ r, next: newKey(r) }));
    const changed = withNext.filter(x => x.r.contentKey !== x.next);
    const changed3x3 = changed.filter(x => x.r.macAdi.trim().toLowerCase() === "3x3 - 3x3");
    const active = withNext.filter(x => x.r.cancelledAt == null);
    const diff = groupDiff(active);

    console.log("== contentKey v2 raporu ==");
    console.log(`Toplam satır            : ${all.length}`);
    console.log(`Değişecek satır         : ${changed.length} (aktif ${changed.filter(x => !x.r.cancelledAt).length}, 3x3 ${changed3x3.length})`);
    console.log(`Aktif grup (eski → yeni): ${diff.oldGroups} → ${diff.newGroups}`);
    console.log(`Bölünen aktif grup      : ${diff.split.length}`);
    console.log(`Birleşen aktif grup     : ${diff.merged.length}`);

    // Örnekleri göster — bölünenler 3x3 olmalı, birleşenler iç boşluk farkı.
    for (const [old, news] of diff.split.slice(0, 10)) {
        const sample = active.filter(x => (x.r.contentKey ?? "") === old).map(x => `#${x.r.id} satır=${x.r.kaynakSatir}`);
        console.log(`  BÖLÜNEN ${old.slice(0, 8)} → ${news.size} grup: ${sample.join(", ")}`);
    }
    for (const [, olds] of diff.merged.slice(0, 10)) {
        const sample = active.filter(x => olds.has(x.r.contentKey ?? `null#${x.r.id}`)).map(x => `#${x.r.id} "${x.r.macAdi}"`);
        console.log(`  BİRLEŞEN ${olds.size} grup: ${sample.slice(0, 4).join(", ")}`);
    }

    if (cmd === "report") {
        console.log("\nSADECE OKUMA — DB'ye hiçbir şey yazılmadı. Uygulamak için: apply");
        await db.$disconnect();
        return;
    }

    // Küçük partiler halinde, her satırı kendi id'siyle güncelle.
    let done = 0;
    for (let i = 0; i < changed.length; i += 100) {
        const batch = changed.slice(i, i + 100);
        await db.$transaction(batch.map(x => db.parsedMatch.update({ where: { id: x.r.id }, data: { contentKey: x.next } })));
        done += batch.length;
    }
    console.log(`\nGüncellenen satır: ${done}`);
    await db.$disconnect();
}

main().catch(async (e) => { console.error("HATA:", e); await db.$disconnect(); process.exit(1); });
