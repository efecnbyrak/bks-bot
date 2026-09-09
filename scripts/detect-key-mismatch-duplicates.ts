import { db } from "../src/db";
import { nameMatches } from "../src/lib/match-parser";

/**
 * TESPİT (salt okuma) — "anahtar uyuşmazlığı" kaynaklı mükerrer maçlar.
 *
 * ARKA PLAN: `matchKey` VE `contentKey` ikisi de `mac_adi` (takım isimleri) ve `tarih`'i
 * hash'e dahil ediyor (bkz. src/db-writer.ts computeMatchKey/computeContentKey). Bu, A1'de
 * (repair-false-cancellations.ts) ele alınan "kadro kademeli doldurma" sorunundan FARKLI
 * iki senaryoda mükerrer maç yaratıyor:
 *
 *   Senaryo 1: Federasyon Excel'inde takım isimleri önce "Daha Sonra Belirlenecek" yazıyor,
 *   sonra gerçek isimlere güncelleniyor. mac_adi değiştiği için contentKey de değişiyor —
 *   eski placeholder'lı satır ile yeni gerçek-isimli satır birbirini hiç tanımıyor, ikisi de
 *   aktif kalıp kullanıcıya İKİ maç olarak görünüyor.
 *
 *   Senaryo 2: Bir maçın tarihi değişiyor (örn. Cuma → Perşembe). tarih contentKey'in bir
 *   parçası olduğu için aynı kör nokta oluşuyor — eski tarihteki satır aktif kalabiliyor.
 *
 * Bu script A1'İN KAPSAMADIĞI bu iki senaryoyu ayrı olarak tespit eder. A1 script'ine hiç
 * dokunmaz, DB'ye hiçbir şey YAZMAZ — sadece raporlar.
 *
 * KULLANIM: npx ts-node scripts/detect-key-mismatch-duplicates.ts
 */

// Not: düz /belirlenecek/i JS'de İ→i̇ (combining dot) dönüşümü yüzünden Türkçe
// büyük harfli "BELİRLENECEK" ile eşleşmiyordu — İ'yi elle normalize ediyoruz.
//
// "ÖN ELEMEDEN GELEN X..." de placeholder — turnuva eleme aşamasında rakip henüz
// netleşmemişken federasyonun kullandığı geçici isim (5 canlı örnek DB'de doğrulandı,
// hepsi elemeler netleşince gerçek isimli KARDEŞ bir satırla eşleşiyor).
function isPlaceholderName(macAdi: string): boolean {
    const norm = macAdi.replace(/İ/g, "i").toLowerCase();
    return norm.includes("belirlenecek") || norm.includes("ön elemeden gelen");
}

interface ActiveRow {
    id: number;
    matchKey: string;
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
    role: string;
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

interface GroupFinding {
    tarih: string;
    saat: string | null;
    salon: string | null;
    rows: ActiveRow[];
    // Her satırdaki atamalar
    assignmentsByRowId: Map<number, Assignment[]>;
    // Kanonik satır (en dolu kadro)
    canonicalRowId: number;
    // Atamaları başka bir satırda da (personel örtüşmesiyle) doğrulanan kullanıcılar
    movable: { assignment: Assignment; fromRowId: number; toRowId: number }[];
    // Örtüşme bulunamayan, belirsiz durumlar
    ambiguous: { assignment: Assignment; fromRowId: number }[];
    hasPlaceholder: boolean;
}

async function analyze(): Promise<GroupFinding[]> {
    const rows: ActiveRow[] = await db.parsedMatch.findMany({
        where: { cancelledAt: null },
        select: {
            id: true, matchKey: true, contentKey: true, macAdi: true, tarih: true,
            saat: true, salon: true, createdAt: true, hakemler: true, masaGorevlileri: true,
            saglikcilar: true, istatistikciler: true, gozlemciler: true, sahaKomiserleri: true,
        },
    });

    // (tarih, saat, salon) → satırlar
    const byTimeSlot = new Map<string, ActiveRow[]>();
    for (const r of rows) {
        // salon/saat boşsa grup anlamsızlaşır (yanlış pozitif riski) — atla.
        if (!r.saat || !r.salon) continue;
        const key = `${r.tarih}|${r.saat}|${r.salon.trim().toLowerCase()}`;
        const arr = byTimeSlot.get(key) ?? [];
        arr.push(r);
        byTimeSlot.set(key, arr);
    }

    const findings: GroupFinding[] = [];

    for (const [, rawGroupRows] of byTimeSlot) {
        if (rawGroupRows.length < 2) continue; // mükerrer aday yok

        // AYNI contentKey'li satırlar A1'in alanı (kadro kademeli doldurma) — bunlara
        // BURADA dokunulmaz. Canlı DB'de gözlemlendi (matchId 228505/228681, aynı
        // contentKey, A1 henüz çalıştırılmadığı için ikisi de hâlâ aktif): grup içinde
        // 3. bir satır farklı contentKey taşırsa, eski kod bu ikisini de yanlışlıkla
        // Senaryo-1 mantığına dahil ediyordu. Şimdi önce contentKey'e göre alt-kümelere
        // ayrılıyor, her alt-kümeden TEK bir temsilci (en dolu kadrolu, eşitlikte en yeni)
        // seçiliyor — geri kalan Senaryo-1 mantığı sadece bu temsilciler arasında çalışır.
        const byContentKey = new Map<string, ActiveRow[]>();
        for (const r of rawGroupRows) {
            const key = r.contentKey ?? `__null_${r.id}`; // contentKey yoksa kendi başına
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

        if (groupRows.length < 2) continue; // temsilciler tek contentKey'e indiyse (A1'in alanı) atla

        const rowIds = groupRows.map(r => r.id);
        const assignments: Assignment[] = await db.userMatchAssignment.findMany({
            where: { matchId: { in: rowIds } },
            select: {
                id: true, userId: true, matchId: true, nameInSpreadsheet: true, role: true,
                user: { select: { referee: { select: { firstName: true, lastName: true } }, official: { select: { firstName: true, lastName: true } } } },
            },
        }).then((rs: any[]) => rs.map(r => ({
            id: r.id, userId: r.userId, matchId: r.matchId, nameInSpreadsheet: r.nameInSpreadsheet, role: r.role,
            firstName: r.user?.referee?.firstName ?? r.user?.official?.firstName,
            lastName: r.user?.referee?.lastName ?? r.user?.official?.lastName,
        })));

        if (assignments.length === 0) continue; // hiç kimse etkilenmiyorsa raporlamaya değmez

        const assignmentsByRowId = new Map<number, Assignment[]>();
        for (const a of assignments) {
            const arr = assignmentsByRowId.get(a.matchId) ?? [];
            arr.push(a);
            assignmentsByRowId.set(a.matchId, arr);
        }

        // Kanonik satır = federasyonun SON hâli. Placeholder isimli satır kadrosu dolu
        // olsa bile asla kanonik olmamalı — o satır zaten "isim henüz netleşmedi"
        // döneminden kalma, gerçek isimli satır her zaman daha günceldir.
        //
        // Kadro sayısı EŞİTSE (canlı DB'de gözlemlendi: 228509 vs 229029, ikisi de 10
        // kişi) sadece personCount kanonik seçimi yanlış satırı seçebiliyordu — o yüzden
        // eşitlik durumunda satırın `createdAt`'i tie-breaker: daha SONRA oluşturulan
        // satır federasyonun güncellediği/netleştirdiği satırdır.
        const nonPlaceholderRows = groupRows.filter(r => !isPlaceholderName(r.macAdi));
        const canonicalPool = nonPlaceholderRows.length > 0 ? nonPlaceholderRows : groupRows;
        const canonical = canonicalPool.reduce((best, r) => {
            const bp = personCount(best), rp = personCount(r);
            if (rp !== bp) return rp > bp ? r : best;
            return r.createdAt > best.createdAt ? r : best;
        });

        const movable: GroupFinding["movable"] = [];
        const ambiguous: GroupFinding["ambiguous"] = [];

        for (const r of groupRows) {
            if (r.id === canonical.id) continue;
            const asgs = assignmentsByRowId.get(r.id) ?? [];
            for (const a of asgs) {
                // Kullanıcının kanonik satırda zaten ataması var mı? (gerçek çift atama)
                const alreadyOnCanonical = (assignmentsByRowId.get(canonical.id) ?? []).some(ca => ca.userId === a.userId);
                if (alreadyOnCanonical) {
                    movable.push({ assignment: a, fromRowId: r.id, toRowId: canonical.id });
                    continue;
                }
                if (personIsInRow(a, canonical)) {
                    movable.push({ assignment: a, fromRowId: r.id, toRowId: canonical.id });
                } else {
                    ambiguous.push({ assignment: a, fromRowId: r.id });
                }
            }
        }

        if (movable.length === 0 && ambiguous.length === 0) continue;

        findings.push({
            tarih: canonical.tarih, saat: canonical.saat, salon: canonical.salon,
            rows: groupRows, assignmentsByRowId, canonicalRowId: canonical.id,
            movable, ambiguous,
            hasPlaceholder: groupRows.some(r => isPlaceholderName(r.macAdi)),
        });
    }

    return findings;
}

async function main() {
    const findings = await analyze();

    let totalMovable = 0, totalAmbiguous = 0, placeholderCount = 0;

    for (const f of findings) {
        totalMovable += f.movable.length;
        totalAmbiguous += f.ambiguous.length;
        if (f.hasPlaceholder) placeholderCount++;

        console.log(`\n[${f.tarih} ${f.saat} — ${f.salon}]${f.hasPlaceholder ? " (PLACEHOLDER ISIM ICERIYOR)" : ""}`);
        for (const r of f.rows) {
            const tag = r.id === f.canonicalRowId ? "KANONIK" : "diger";
            console.log(`  satır ${r.id} [${tag}] "${r.macAdi}" (contentKey: ${r.contentKey?.slice(0, 8)}...)`);
        }
        if (f.movable.length > 0) {
            console.log(`  → taşınabilir (örtüşme doğrulandı): ${f.movable.map(m => `${m.assignment.nameInSpreadsheet} (satır ${m.fromRowId}→${m.toRowId})`).join(", ")}`);
        }
        if (f.ambiguous.length > 0) {
            console.log(`  → BELİRSİZ (elle incelenmeli): ${f.ambiguous.map(m => `${m.assignment.nameInSpreadsheet} (satır ${m.fromRowId})`).join(", ")}`);
        }
    }

    console.log(`\n=== ÖZET ===`);
    console.log(`Etkilenen zaman/salon grubu: ${findings.length}`);
    console.log(`  → placeholder isim içeren: ${placeholderCount}`);
    console.log(`Taşınabilir atama (örtüşme doğrulandı, apply ile düzeltilebilir): ${totalMovable}`);
    console.log(`Belirsiz atama (elle incelenmeli, apply DOKUNMAZ): ${totalAmbiguous}`);
    console.log(`\n(Bu script salt-okuma. Düzeltme için: repair-key-mismatch-duplicates.ts)`);
}

main()
    .catch((e) => { console.error("HATA:", e); process.exitCode = 1; })
    .finally(() => db.$disconnect());
