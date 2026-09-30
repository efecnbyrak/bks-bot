import type ExcelJS from "exceljs";

export interface MatchData {
    mac_adi: string;
    tarih: string;
    saat?: string;
    salon?: string;
    kategori: string;
    // Yerel Lig dosyalarındaki "GRUP" sütunu (ör. "A GRUBU") — kategoriden ayrı.
    // ParsedMatch'te karşılığı yok; web tarafı Atamalar sayfasında kullanıyor.
    grup?: string;
    hafta?: number;
    sezon?: string;
    ligTuru: string;
    hakemler: string[];
    masa_gorevlileri: string[];
    saglikcilar: string[];
    istatistikciler: string[];
    gozlemciler: string[];
    sahaKomiserleri: string[];
    kaynak_dosya: string;
}

export interface UserMatchSummary {
    toplam_mac: number;
    kategoriler: Record<string, number>;
    maclar: MatchData[];
}

// ============================================================
// Turkish Name Matching — STRICT mode (kademe 1, hızlı yol)
// Aşağıdaki fuzzy fallback (kademe 2) bu STRICT eşleşme başarısız olduğunda devreye girer.
// ============================================================

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

/**
 * Fuzzy name matching for Turkish names (~99% accuracy).
 *
 * Rules:
 * 1. Last name must match (exact or Levenshtein ≤ 1 for names ≥ 5 chars)
 * 2. First name parts must match (exact or Levenshtein ≤ 1 for parts ≥ 3 chars)
 * 3. Name order doesn't matter: "Bayrak Efe Can" = "Efe Can Bayrak"
 * 4. Case insensitive with Turkish char normalization
 */
export function nameMatches(cellName: string, firstName: string, lastName: string): boolean {
    if (!cellName || cellName.length < 3) return false;
    if (!firstName || !lastName) return false;

    const cellNorm = normalizeTR(cellName);
    const fNorm = normalizeTR(firstName);
    const lNorm = normalizeTR(lastName);

    const cellWords = cellNorm.split(/[\s,.;\-/()]+/).filter(w => w.length > 0);
    const firstNameParts = fNorm.split(/\s+/).filter(w => w.length > 0);
    const lastNameParts = lNorm.split(/\s+/).filter(w => w.length > 0);

    const fuzzyMatch = (a: string, b: string, minLen: number): boolean => {
        if (a === b) return true;
        if (a.length < minLen || b.length < minLen) return false;
        if (Math.abs(a.length - b.length) > 1) return false;
        return levenshteinSimple(a, b) <= 1;
    };

    const lastNameMatchedWords: string[] = [];
    for (const lnPart of lastNameParts) {
        const matched = cellWords.find(cw => fuzzyMatch(cw, lnPart, 5));
        if (!matched) return false;
        lastNameMatchedWords.push(matched);
    }

    const remainingWords = cellWords.filter(w => !lastNameMatchedWords.includes(w));

    for (const fnPart of firstNameParts) {
        const found = remainingWords.some(rw => fuzzyMatch(rw, fnPart, 3));
        if (!found) return false;
    }

    return true;
}

// ============================================================
// Turkish Name Matching — FUZZY fallback (kademe 2)
// ============================================================
// nameMatches() (yukarıdaki hızlı/kelime bazlı yol) eşleşmediğinde devreye girer.
// Sorun: Excel'de "GENÇOSMAN KOCAEREN" (birleşik) yazılmış ama BKS profilinde
// "GENÇ OSMAN KOCAEREN" (boşluklu) kayıtlı — kelime sayısı farklı olduğu için
// yukarıdaki fuzzyMatch bunu yakalayamıyor. Burada tüm boşlukları söküp tek bir
// harf dizisi üzerinden benzerlik oranına bakıyoruz, kelime bölünmesi artık sorun olmuyor.

/** Türkçe karakterleri ASCII'ye katlar (ç→c, ş→s vb.) — normalizeTR'nin aksine diakritik farkını da yok eder. */
function foldTR(name: string): string {
    if (!name) return "";
    return name
        .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
        .replace(/Ğ/g, "g").replace(/ğ/g, "g")
        .replace(/Ü/g, "u").replace(/ü/g, "u")
        .replace(/Ş/g, "s").replace(/ş/g, "s")
        .replace(/Ö/g, "o").replace(/ö/g, "o")
        .replace(/Ç/g, "c").replace(/ç/g, "c")
        .replace(/Â/g, "a").replace(/â/g, "a")
        .replace(/i̇/g, "i")
        .toLowerCase()
        .replace(/[^a-z\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** foldTR sonucundaki TÜM boşlukları siler — kelime birleşme/ayrılma/sıra farkı böylece anlamsızlaşır. */
function squash(name: string): string {
    return foldTR(name).replace(/\s+/g, "");
}

/** 1 - levenshtein(a,b) / max(len(a),len(b)) — 1.0 tam eşleşme, 0.0 tamamen farklı. */
function similarityRatio(a: string, b: string): number {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - levenshteinSimple(a, b) / maxLen;
}

/** Genel kullanım için eşik — 584 kayıtlı profilin ikili karşılaştırmasıyla test edilip kararlaştırıldı (docs/bot/YAPILACAKLAR.md madde 5). */
const FUZZY_SIMILARITY_THRESHOLD = 0.90;
/** Çok kısa isimlerde (katlanmış hâli bu değerden az harf) yanlış-pozitif riski arttığından eşik yükseltilir. */
const FUZZY_SHORT_NAME_MIN_LEN = 8;
const FUZZY_SHORT_NAME_THRESHOLD = 0.95;

/**
 * nameMatches() başarısız olduğunda çağrılan ikinci kademe — squash edilmiş tam ad
 * karşılaştırmasıyla benzerlik oranına bakar. Ambiguity kararı (birden fazla aday,
 * skorlar birbirine çok yakın) burada değil, çağıran tarafta (user-matcher.ts) verilir
 * çünkü bu fonksiyon tek bir aday çiftini karşılaştırır.
 */
export function fuzzyNameMatch(cellName: string, firstName: string, lastName: string): boolean {
    return fuzzyNameSimilarity(cellName, firstName, lastName) >= fuzzyThresholdFor(firstName, lastName);
}

/** Ambiguity kontrolü için ham benzerlik skorunu döner (0..1). */
export function fuzzyNameSimilarity(cellName: string, firstName: string, lastName: string): number {
    if (!cellName || !firstName || !lastName) return 0;
    const a = squash(cellName);
    const b = squash(`${firstName} ${lastName}`);
    if (!a || !b) return 0;
    return similarityRatio(a, b);
}

function fuzzyThresholdFor(firstName: string, lastName: string): number {
    const folded = squash(`${firstName} ${lastName}`);
    return folded.length < FUZZY_SHORT_NAME_MIN_LEN ? FUZZY_SHORT_NAME_THRESHOLD : FUZZY_SIMILARITY_THRESHOLD;
}

function levenshteinSimple(a: string, b: string): number {
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

// ============================================================
// Excel Parsing
// ============================================================

function cellToString(cell: any): string {
    if (cell === null || cell === undefined) return "";
    if (typeof cell === "object") {
        if (cell.richText) return cell.richText.map((r: any) => r.text || "").join("");
        if (cell.text) return String(cell.text).trim();
        if (cell.result !== undefined) return String(cell.result).trim();
        if (cell.hyperlink) return String(cell.text || cell.hyperlink).trim();
        if (cell instanceof Date) {
            const d = cell as Date;
            // DİKKAT — burada UTC getter'ları kullanmak ZORUNLU, yerel olanlar DEĞİL.
            // ExcelJS saat/tarih hücrelerini UTC olarak saklıyor (ör. 18:00 →
            // 1899-12-30T18:00:00Z). `getHours()` yerel saat dilimini uyguluyor ve
            // 1899 için İstanbul farkı +01:56:56 olduğundan saat KAYIYORDU:
            // saklanan 18:00 → "19:56". Gerçek sonuç: yanlış maç saatleri ve aynı
            // maçın iki farklı saatle iki kez yazılması (2026-10-01'de tespit edildi).
            // Excel saat-only değerlerini Aralık 1899 tarihleri olarak tutar.
            if (d.getUTCFullYear() < 1910) {
                const h = d.getUTCHours().toString().padStart(2, "0");
                const m = d.getUTCMinutes().toString().padStart(2, "0");
                if (h === "00" && m === "00") return "";
                return `${h}:${m}`;
            }
            return `${d.getUTCDate().toString().padStart(2, "0")}.${(d.getUTCMonth() + 1).toString().padStart(2, "0")}.${d.getUTCFullYear()}`;
        }
        return String(cell).trim();
    }
    if (typeof cell === "number" && cell > 0 && cell < 1) {
        const totalMinutes = Math.floor(cell * 24 * 60);
        const h = Math.floor(totalMinutes / 60).toString().padStart(2, "0");
        const m = (totalMinutes % 60).toString().padStart(2, "0");
        return `${h}:${m}`;
    }
    return String(cell).trim();
}

function cleanSaat(saat: string): string {
    if (!saat) return "";
    if (/^\d{1,2}:\d{2}$/.test(saat)) return saat;
    if (saat.includes("1899") || saat.includes("1900")) return "";
    return saat;
}

function cleanDatePrefix(text: string): string {
    if (!text) return "";
    return text.replace(/^\s*(?:\d{1,2}[./-]\d{1,2}[./-]\d{4}\s*(?:-\s*)?|-\s*)/, "").trim();
}

function parseFileMetadata(fileName: string): { hafta?: number; ligTuru: string } {
    const fn = fileName.toUpperCase();
    const haftaMatch = fileName.match(/(\d+)\.?\s*(?:hafta|HAFTA)/i);
    const hafta = haftaMatch ? parseInt(haftaMatch[1], 10) : undefined;

    if (fn.includes("OKUL") || fn.includes("İL VE İLÇE") || fn.includes("IL VE ILCE")) {
        return { hafta, ligTuru: "OKUL İL VE İLÇE" };
    }
    if (fn.includes("ÖZEL LİG") || fn.includes("ÜNİVERSİTE") || fn.includes("OZEL LIG") || fn.includes("UNIVERSITE")) {
        return { hafta, ligTuru: "ÖZEL LİG VE ÜNİVERSİTE" };
    }
    if (fn.includes("TBF") || fn.includes("MİLLİ") || fn.includes("FIBA") || fn.includes("AVRUPA")) {
        return { hafta, ligTuru: "TBF / MİLLİ" };
    }
    if (fn.includes("HÜKMEN")) return { hafta, ligTuru: "HÜKMEN" };
    if (fn.includes("CEZA")) return { hafta, ligTuru: "CEZA KARARLARI" };
    return { hafta, ligTuru: "Yerel Lig" };
}

function isGenericSheetName(name: string): boolean {
    return /^(sheet\s*\d*|sayfa\s*\d*|worksheet\s*\d*|çalışma\s*sayfası\s*\d*|data\s*\d*)$/i.test(name.trim());
}

export function parseWorkbook(workbook: ExcelJS.Workbook, fileName: string): MatchData[] {
    const allMatches: MatchData[] = [];
    // Hiç ayrıştırılamayan (maç adı çıkarılamayan) satır sayısı — sessizce yutulmasın diye
    // dosya sonunda loglanıyor. Bu sayı artıyorsa kaynak dosyanın başlıkları değişmiş olabilir.
    let skippedUnparsable = 0;
    const category = fileName.replace(/\.(xlsx|xls|csv)$/i, "").replace(/ARŞİV\s*/i, "").trim();
    const fileMeta = parseFileMetadata(fileName);

    for (const ws of workbook.worksheets) {
        const sheetCategory = ws.name && ws.name.trim().length > 0 && !isGenericSheetName(ws.name)
            ? ws.name.trim()
            : category;

        const rows: string[][] = [];
        ws.eachRow({ includeEmpty: false }, (row: any) => {
            const vals: string[] = [];
            row.eachCell({ includeEmpty: true }, (_cell: any, colNumber: number) => {
                while (vals.length < colNumber) vals.push("");
                vals[colNumber - 1] = cellToString(_cell.value);
            });
            rows.push(vals);
        });

        if (rows.length < 2) continue;

        let headerIdx = -1;
        let colMap: Record<string, number[]> = {};

        for (let i = 0; i < Math.min(rows.length, 20); i++) {
            const row = rows[i];
            if (!row || row.length < 3) continue;
            const lower = row.map(c => normalizeTR(c));

            const hasRole = lower.some(c =>
                c.includes("hakem") || c === "h1" || c === "h2" || c === "h3" ||
                c.includes("masa") || c.includes("yazıcı") || c.includes("skor") ||
                c.includes("24 sn") || c.includes("24sn") || c.includes("yardımcı") ||
                c.includes("sağlık") || c.includes("gözlemci") || c.includes("istatistik") || c.includes("stat")
            );
            if (!hasRole) continue;

            const hasContext = lower.some(c =>
                c.includes("tarih") || c === "gün" || c.includes("saat") || c.includes("salon") || c.includes("spor") ||
                c.includes("takım") || c.includes("maç") || c.includes("karşılaşma") || c.includes("ev sahibi")
            );
            if (!hasContext) continue;

            headerIdx = i;
            colMap = {};

            let lastColCategory = "";
            for (let j = 0; j < lower.length; j++) {
                const c = lower[j];
                if (!c) {
                    if (lastColCategory && colMap[lastColCategory]) {
                        colMap[lastColCategory].push(j);
                    }
                    continue;
                }
                lastColCategory = "";

                if (c.includes("tarih") || c === "gün") {
                    if (!colMap["tarih"]) colMap["tarih"] = []; colMap["tarih"].push(j);
                } else if ((c.includes("saat") && !c.includes("srm") && !c.includes("sorumlu") && !c.includes("görevli") && !c.includes("hakem")) || c === "saat") {
                    if (!colMap["saat"]) colMap["saat"] = []; colMap["saat"].push(j);
                } else if (c.includes("salon") || c.includes("spor")) {
                    if (!colMap["salon"]) colMap["salon"] = []; colMap["salon"].push(j);
                } else if (c.includes("organizasyon") || c === "org" || c.includes("kategori")) {
                    // Yerel Lig haftalık dosyalarında bu sütunun başlığı "KATEGORİ"
                    // (ör. "U16EA"), Özel Lig dosyalarında "ORGANİZASYON". Alias
                    // eklenmeden önce KATEGORİ tanınmıyordu ve `kategori` alanına sekme
                    // adı ("1 hafta") yazılıyordu — 808 maçın tamamı böyleydi (2026-09-30).
                    if (!colMap["organizasyon"]) colMap["organizasyon"] = []; colMap["organizasyon"].push(j);
                } else if (c.includes("grup")) {
                    // "GRUP" (ör. "A GRUBU") — kategoriden AYRI sütun, kategori yerine geçmez.
                    if (!colMap["grup"]) colMap["grup"] = []; colMap["grup"].push(j);
                } else if (c.includes("maç") || c.includes("karşılaşma") || c.includes("müsabaka") || c.includes("takım") || c.includes("ev sahibi")) {
                    if (!colMap["mac"]) colMap["mac"] = []; colMap["mac"].push(j);
                } else if (c.includes("istatistik") || c.includes("stat")) {
                    if (!colMap["istatistik"]) colMap["istatistik"] = []; colMap["istatistik"].push(j);
                    lastColCategory = "istatistik";
                } else if (c.includes("sağlık") || c.includes("doktor") || c.includes("sağlik")) {
                    if (!colMap["saglik"]) colMap["saglik"] = []; colMap["saglik"].push(j);
                    lastColCategory = "saglik";
                } else if (c.includes("gözlemci") || c.includes("gozlemci")) {
                    if (!colMap["gozlemci"]) colMap["gozlemci"] = []; colMap["gozlemci"].push(j);
                    lastColCategory = "gozlemci";
                } else if (c.includes("komiseri") || c.includes("komiser") || (c.includes("saha") && c.includes("kom"))) {
                    if (!colMap["sahaKomiseri"]) colMap["sahaKomiseri"] = []; colMap["sahaKomiseri"].push(j);
                    lastColCategory = "sahaKomiseri";
                } else if (
                    c.includes("masa") || c.includes("yazıcı") || c.includes("skor") || c.includes("24") ||
                    (c.includes("yardımcı") && !c.includes("hakem")) || c.includes("srm") || c.includes("sorumlu") ||
                    c.includes("opr") || c.includes("operatör") || c.includes("şut") || c.includes("sut") ||
                    c.includes("süre") || c.includes("sure") || c.includes("kronometre") ||
                    (c.includes("sayı") && !c.includes("istatistik")) ||
                    c.includes("saat görevlisi") || c.includes("saat gorevlisi")
                ) {
                    if (!colMap["masa"]) colMap["masa"] = []; colMap["masa"].push(j);
                    lastColCategory = "masa";
                } else if (c.includes("hakem") || c === "h1" || c === "h2" || c === "h3") {
                    if (!colMap["hakem"]) colMap["hakem"] = []; colMap["hakem"].push(j);
                    lastColCategory = "hakem";
                }
            }
            break;
        }

        if (headerIdx < 0) continue;

        const hakemCols = colMap["hakem"] || [];
        const masaCols = colMap["masa"] || [];
        const saglikCols = colMap["saglik"] || [];
        const istatistikCols = colMap["istatistik"] || [];
        const gozlemciCols = colMap["gozlemci"] || [];
        const sahaKomiseriCols = colMap["sahaKomiseri"] || [];
        const tarihCols = colMap["tarih"] || [];
        const saatCols = colMap["saat"] || [];
        const salonCols = colMap["salon"] || [];
        const macCols = colMap["mac"] || [];
        const organizasyonCols = colMap["organizasyon"] || [];
        const grupCols = colMap["grup"] || [];

        const usedColsSet = new Set([
            ...hakemCols, ...masaCols, ...saglikCols, ...istatistikCols,
            ...gozlemciCols, ...sahaKomiseriCols, ...tarihCols, ...saatCols, ...salonCols, ...macCols,
            ...organizasyonCols, ...grupCols,
        ]);

        let lastTarih = "";
        let lastSalon = "";

        for (let i = headerIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length < 3) continue;
            if (row.every(c => !c || c.trim() === "")) continue;

            let rowTarih = "";
            let rowSalon = "";

            if (tarihCols.length) {
                rowTarih = row[tarihCols[0]] || "";
                if (rowTarih && /\d/.test(rowTarih)) lastTarih = rowTarih.trim();
            }

            if (!rowTarih) {
                const possibleDate = row.find(c => c && /\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{4}/.test(c));
                if (possibleDate) {
                    lastTarih = possibleDate.trim();
                }
            }

            if (salonCols.length) {
                rowSalon = cleanDatePrefix(row[salonCols[0]] || "");
                if (rowSalon && rowSalon.length > 2) lastSalon = rowSalon.trim();
            }

            const hakemler = hakemCols.map(j => row[j] || "").filter(v => v.length > 2);
            const masaGorevlileri = masaCols.map(j => row[j] || "").filter(v => v.length > 2);
            const saglikcilar = saglikCols.map(j => row[j] || "").filter(v => v.length > 2);
            const istatistikciler = istatistikCols.map(j => row[j] || "").filter(v => v.length > 2);
            const gozlemciler = gozlemciCols.map(j => row[j] || "").filter(v => v.length > 2);
            const sahaKomiserleri = sahaKomiseriCols.map(j => row[j] || "").filter(v => v.length > 2);

            if (hakemler.length === 0 && masaGorevlileri.length === 0 &&
                saglikcilar.length === 0 && istatistikciler.length === 0 &&
                gozlemciler.length === 0 && sahaKomiserleri.length === 0) continue;

            let macAdi = "";
            if (macCols.length) {
                macAdi = macCols.map(j => row[j] || "").filter(v => v.length > 1).join(" - ");
            }
            if (!macAdi) {
                const extras = row.map((v, j) => ({ v, j })).filter(x => x.v.length > 2 && !usedColsSet.has(x.j)).map(x => x.v).slice(0, 3);
                if (extras.length > 0) macAdi = extras.join(" - ");
            }
            // Buraya kadar maç adı bulunamadıysa satır gerçekten ayrıştırılamıyor:
            // ne takım sütunu eşleşti ne de eşlenmemiş sütunlarda kullanılabilir metin var.
            // Eskiden son çare olarak `${category} — ${ws.name}` yazılıyordu; bu, maç adı
            // "ÖZEL LİG VE ÜNİVERSİTE (2026 - 2027) — GÜNCEL" gibi ÇÖP kayıtlar üretiyordu
            // (2026-10-01'de arşiv dosyasından gelen 61 kayıt böyleydi) ve bu çöp
            // Ödemeler sayfasına kategori olarak da sızıyordu. Artık satır atlanıyor.
            if (!macAdi) {
                skippedUnparsable += 1;
                continue;
            }

            macAdi = cleanDatePrefix(macAdi);

            let tarih = rowTarih || "";
            if (tarih && /\d/.test(tarih)) lastTarih = tarih;
            else if (!tarih && lastTarih) tarih = lastTarih;

            let saat = "";
            if (saatCols.length) saat = cleanSaat(row[saatCols[0]] || "");

            let salon = rowSalon || "";
            if (salon && salon.length > 2) lastSalon = salon;
            else if (!salon && lastSalon) salon = lastSalon;

            let rowKategori = sheetCategory;
            if (organizasyonCols.length) {
                const orgVal = (row[organizasyonCols[0]] || "").trim();
                if (orgVal.length > 1) rowKategori = orgVal;
            }

            let rowGrup = "";
            if (grupCols.length) rowGrup = (row[grupCols[0]] || "").trim();

            allMatches.push({
                mac_adi: macAdi, tarih, saat, salon,
                kategori: rowKategori, grup: rowGrup || undefined,
                hafta: fileMeta.hafta, ligTuru: fileMeta.ligTuru,
                hakemler, masa_gorevlileri: masaGorevlileri, saglikcilar, istatistikciler, gozlemciler,
                sahaKomiserleri,
                kaynak_dosya: `${fileName} → ${ws.name}`,
            });
        }
    }
    if (skippedUnparsable > 0) {
        console.warn(`[PARSER] ${fileName}: maç adı çıkarılamayan ${skippedUnparsable} satır atlandı (takım/maç sütunu eşleşmedi).`);
    }
    return allMatches;
}

export function getMatchesForUser(allMatches: MatchData[], firstName: string, lastName: string): UserMatchSummary {
    const nameCache = new Map<string, boolean>();
    const cachedNameMatches = (person: string): boolean => {
        let result = nameCache.get(person);
        if (result === undefined) {
            result = nameMatches(person, firstName, lastName);
            nameCache.set(person, result);
        }
        return result;
    };

    const userMatches = allMatches.filter(match => {
        const allPeople = [
            ...match.hakemler, ...match.masa_gorevlileri,
            ...match.saglikcilar, ...match.istatistikciler, ...match.gozlemciler,
            ...match.sahaKomiserleri,
        ];
        return allPeople.some(person => cachedNameMatches(person));
    });

    const kategoriler: Record<string, number> = {};
    for (const m of userMatches) kategoriler[m.kategori] = (kategoriler[m.kategori] || 0) + 1;

    return { toplam_mac: userMatches.length, kategoriler, maclar: userMatches };
}
