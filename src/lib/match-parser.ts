import type ExcelJS from "exceljs";

export interface MatchData {
    mac_adi: string;
    tarih: string;
    saat?: string;
    salon?: string;
    kategori: string;
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
// Turkish Name Matching — STRICT mode
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
            if (d.getFullYear() < 1910) {
                const h = d.getHours().toString().padStart(2, "0");
                const m = d.getMinutes().toString().padStart(2, "0");
                if (h === "00" && m === "00") return "";
                return `${h}:${m}`;
            }
            return `${d.getDate().toString().padStart(2, "0")}.${(d.getMonth() + 1).toString().padStart(2, "0")}.${d.getFullYear()}`;
        }
        return String(cell).trim();
    }
    if (typeof cell === "number" && cell > 0 && cell < 1) {
        const totalMinutes = Math.round(cell * 24 * 60);
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
                } else if (c.includes("organizasyon") || c === "org") {
                    if (!colMap["organizasyon"]) colMap["organizasyon"] = []; colMap["organizasyon"].push(j);
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

        const usedColsSet = new Set([
            ...hakemCols, ...masaCols, ...saglikCols, ...istatistikCols,
            ...gozlemciCols, ...sahaKomiseriCols, ...tarihCols, ...saatCols, ...salonCols, ...macCols,
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
            if (!macAdi) macAdi = `${category} — ${ws.name}`;

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

            allMatches.push({
                mac_adi: macAdi, tarih, saat, salon,
                kategori: rowKategori, hafta: fileMeta.hafta, ligTuru: fileMeta.ligTuru,
                hakemler, masa_gorevlileri: masaGorevlileri, saglikcilar, istatistikciler, gozlemciler,
                sahaKomiserleri,
                kaynak_dosya: `${fileName} → ${ws.name}`,
            });
        }
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
