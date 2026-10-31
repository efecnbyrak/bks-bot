// Maç hücresindeki isim ↔ kayıtlı profil eşleştirmesi — TEK KURAL.
//
// BU DOSYANIN İKİZİ: bks-web-system `lib/name-match.ts` (bot atamaları buna göre yazar,
// web telefon rehberi ve "bu hücre ben miyim" kontrolleri buna göre okur). Biri
// değişirse diğeri AYNI TURDA değişir; iki repoda `name-match.test.ts` aynı
// fixture'larla kilitler.
//
// Neden var (2026-11-01): eski `nameMatches` tek yönlüydü — profilin kelimeleri
// hücrede geçiyorsa eşleşiyor, hücredeki FAZLA kelimeye hiç bakmıyordu. Bu yüzden
// "Cem Akan" profili "AYHAN CEM AKAN" ve "ASLAN CEM AKAN" hücrelerini de alıyordu
// (canlıda 31 yanlış atama). Yeni kural:
//   - Hücrenin TÜM kelimeleri profille karşılanıyorsa → "exact" (tek harf yazım
//     hatası toleransı eskisi gibi).
//   - Hücrede profilin karşılamadığı kelimeler kalıyorsa → "partial" SADECE şu
//     durumda: profil kelimeleri harfi harfine tutuyor VE artan kısım en az iki
//     kelime (yani hücrede ikinci bir tam isim var: "RECEP DAĞDELEN- MERT KAYAALPLI").
//     Tek bir artan kelime ("AYHAN" + CEM AKAN) başka birinin adının parçasıdır.
//   - Bir hücreye birden çok kişi uyuyorsa `resolveCellCandidates` karar verir:
//     tam eşleşen tek kişi varsa yalnız o; aynı kelimeler üzerinde çakışan adaylar
//     belirsizdir ve hiçbiri atanmaz (yanlış kişiye maç yazmaktansa yazmamak).

export type CellMatchKind = "exact" | "partial";

export interface CellMatch {
    kind: CellMatchKind;
    // Profilin karşıladığı hücre kelimelerinin indeksleri (çakışma kontrolü için).
    covered: number[];
    // Eşleşmede tek harf yazım hatası toleransı kullanıldı mı.
    typo: boolean;
}

// Türkçe büyük/küçük harf farkını kaldırır, fazla boşlukları tekler.
function normalizeTR(name: string): string {
    if (!name) return "";
    return name
        .replace(/İ/g, "i").replace(/I/g, "ı")
        .replace(/Ğ/g, "ğ").replace(/Ü/g, "ü")
        .replace(/Ş/g, "ş").replace(/Ö/g, "ö")
        .replace(/Ç/g, "ç")
        .replace(/i̇/g, "i")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

// Hücreyi kelimelere böler; içinde hiç harf olmayan parçalar (Excel'den gelen
// görünmez nesne karakteri "￼" gibi) kelime sayılmaz.
export function cellWordsOf(cellName: string): string[] {
    return normalizeTR(cellName)
        .split(/[\s,.;\-/()]+/)
        .filter(w => /\p{L}/u.test(w));
}

// İki kısa kelime arasındaki düzenleme mesafesi (iki satırlık dizi ile).
function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    let prev = new Array<number>(b.length + 1);
    let curr = new Array<number>(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        const tmp = prev; prev = curr; curr = tmp;
    }
    return prev[b.length];
}

// Tek harf yazım hatası toleransı: yeterince uzun kelimelerde 1 harf fark kabul.
function isTypoOf(a: string, b: string, minLen: number): boolean {
    if (a.length < minLen || b.length < minLen) return false;
    if (Math.abs(a.length - b.length) > 1) return false;
    return levenshtein(a, b) <= 1;
}

/**
 * Bir hücre ismi verilen profile uyuyor mu, uyuyorsa nasıl? Uymuyorsa null.
 * Soyad parçaları önce (≥5 harfte 1 harf tolerans), sonra ad parçaları (≥3 harf)
 * aranır; her hücre kelimesi tek bir profil parçasına harcanır. Önce birebir
 * eşit kelime, yoksa yazım hatalı kelime denenir. Sıra önemsiz ("Bayrak Efe Can").
 */
export function matchCellName(cellName: string, firstName: string, lastName: string): CellMatch | null {
    if (!cellName || cellName.length < 3) return null;
    if (!firstName || !lastName) return null;

    const words = cellWordsOf(cellName);
    const lastParts = normalizeTR(lastName).split(/\s+/).filter(w => w.length > 0);
    const firstParts = normalizeTR(firstName).split(/\s+/).filter(w => w.length > 0);

    const used = new Set<number>();
    let typoUsed = false;

    // Bir profil parçası için boştaki hücre kelimesini bulur ve harcar.
    const take = (part: string, minLen: number): boolean => {
        let idx = words.findIndex((w, i) => !used.has(i) && w === part);
        if (idx === -1) {
            idx = words.findIndex((w, i) => !used.has(i) && isTypoOf(w, part, minLen));
            if (idx !== -1) typoUsed = true;
        }
        if (idx === -1) return false;
        used.add(idx);
        return true;
    };

    for (const part of lastParts) if (!take(part, 5)) return null;
    for (const part of firstParts) if (!take(part, 3)) return null;

    const covered = [...used].sort((a, b) => a - b);
    const leftover = words.length - used.size;
    if (leftover === 0) return { kind: "exact", covered, typo: typoUsed };

    // Artan kelime var: ancak harfi harfine tutan ve yanında ikinci bir tam isim
    // taşıyan (iki kişilik) hücrede kabul.
    if (typoUsed || leftover < 2) return null;
    return { kind: "partial", covered, typo: false };
}

/** Eski imza: hücre bu profile uyuyor mu (tek kişi bakışı). */
export function cellNameMatches(cellName: string, firstName: string, lastName: string): boolean {
    return matchCellName(cellName, firstName, lastName) !== null;
}

export interface NameCandidate {
    id: number;
    firstName: string;
    lastName: string;
}

export interface CellResolution {
    // Bu hücreye atanacak kişi id'leri (iki kişilik hücrede iki id olabilir).
    ids: number[];
    // Belirsizlik yüzünden atanmayan aday id'leri (loglamak için).
    ambiguous: number[];
}

/**
 * Bir hücreye uyan TÜM adayları toplayıp kime ait olduğuna karar verir.
 * Aynı id birden fazla profille (hakem + görevli) gelebilir — en iyi sonucu sayılır.
 *  1) Tam eşleşen tek kişi varsa hücre yalnız onundur (kısmi adaylar elenir).
 *     Birden çok kişi tam eşleşiyorsa harfi harfine tutanlar (yazım hatasız)
 *     seçilir ("AHMET ÇELİK" → Çelik, Çevik değil). Birebir aynı isimli birden çok
 *     hesap (canlıda "RIFAT BAYAR" iki hesap) eskisi gibi HEPSİ atanır — bu kural
 *     onları ayırt edemez, düşürmek mevcut atamaları iptal ettirirdi. Hepsi yazım
 *     hatalıysa kimse atanmaz.
 *  2) Tam eşleşen yoksa kısmi adaylardan kelimeleri başka bir adayla çakışanlar
 *     belirsizdir, atanmaz; çakışmayanlar (iki kişilik hücre) atanır.
 */
// Aynı kişinin iki profilinden hangisinin sonucu sayılır: exact > exact(yazım hatalı) > partial.
function rank(m: CellMatch): number {
    if (m.kind === "partial") return 0;
    return m.typo ? 1 : 2;
}

export function resolveCellCandidates(cellName: string, candidates: NameCandidate[]): CellResolution {
    const best = new Map<number, CellMatch>();
    for (const c of candidates) {
        const m = matchCellName(cellName, c.firstName, c.lastName);
        if (!m) continue;
        const prev = best.get(c.id);
        if (!prev || rank(m) > rank(prev)) best.set(c.id, m);
    }
    if (best.size === 0) return { ids: [], ambiguous: [] };

    const exact = [...best.entries()].filter(([, m]) => m.kind === "exact");
    if (exact.length === 1) return { ids: [exact[0][0]], ambiguous: [] };
    if (exact.length > 1) {
        const clean = exact.filter(([, m]) => !m.typo);
        if (clean.length > 0) {
            return { ids: clean.map(([id]) => id), ambiguous: exact.filter(([, m]) => m.typo).map(([id]) => id) };
        }
        return { ids: [], ambiguous: exact.map(([id]) => id) };
    }

    const partial = [...best.entries()];
    const ids: number[] = [];
    const ambiguous: number[] = [];
    for (const [id, m] of partial) {
        const clashes = partial.some(([otherId, o]) => otherId !== id && o.covered.some(i => m.covered.includes(i)));
        (clashes ? ambiguous : ids).push(id);
    }
    return { ids, ambiguous };
}
