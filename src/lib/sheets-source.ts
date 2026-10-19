// TBF/FIBA/Milli (TBL, EuroLeague, BGL, BSL, KBSL, FIBA BCL/EuroCup vb.) maçlarının
// kaynağı: federasyonun Drive'a xlsx atmadığı, doğrudan canlı tuttuğu iki Google E-Tablo.
// Bot'un normal kaynağı (Drive .xlsx) bu veriyi hiç göremiyordu — kullanıcı geri bildirimi
// ("TBL maçı Maçlarım'da yok") buradan geliyordu (2026-10-20).
//
// Kimlik: web reposunun (bks-web-system) OAuth hesabı yeniden kullanılıyor
// (lib/google-oauth.ts ile aynı CLIENT_ID/SECRET/REFRESH_TOKEN) — bu hesabın zaten
// "spreadsheets" scope'u var ve bu iki dosyayı okuyabildiği 2026-10-20'de canlı
// doğrulandı. Bot'un kendi Drive servis hesabı SADECE drive.readonly scope'una sahip,
// Sheets okuyamaz.
//
// `valueRenderOption: "UNFORMATTED_VALUE"` ZORUNLU (web'deki ödeme tarifesi/ceza sorgulama
// bug'larıyla aynı sebep) — aksi halde tarih/saat hücreleri TR biçimli string döner.
// TARİH serial number'ı burada DOĞRUDAN "DD.MM.YYYY" string'ine, SAAT kesri "HH:MM"
// string'ine çevriliyor — match-parser.ts'teki cellToString büyük sayıları (tarih serial'ı)
// tarih olarak TANIMIYOR (sadece 0 < x < 1 olan saat kesirlerini biliyor), bu yüzden
// ham sayı değil, hazır string geçiriyoruz.

import { google } from "googleapis";

let oauthClient: InstanceType<typeof google.auth.OAuth2> | null = null;

function getOAuthClient() {
    if (oauthClient) return oauthClient;

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error(
            "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN ayarlanmamış — TBF/Milli sheet kaynağı okunamaz."
        );
    }

    oauthClient = new google.auth.OAuth2(clientId, clientSecret);
    oauthClient.setCredentials({ refresh_token: refreshToken });
    return oauthClient;
}

// Google Sheets seri tarih epoch'u: 1899-12-30 (Excel/Sheets ortak epoch).
const SHEETS_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);

function serialToDateString(serial: number): string {
    const d = new Date(SHEETS_EPOCH_UTC_MS + Math.round(serial) * 86400000);
    const dd = d.getUTCDate().toString().padStart(2, "0");
    const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    return `${dd}.${mm}.${yyyy}`;
}

function serialToTimeString(fraction: number): string {
    const totalMinutes = Math.floor(fraction * 24 * 60);
    const h = Math.floor(totalMinutes / 60).toString().padStart(2, "0");
    const m = (totalMinutes % 60).toString().padStart(2, "0");
    return `${h}:${m}`;
}

// Ham hücreyi (sayı/string/boş) parseWorkbook'un beklediği string formuna çevirir.
// TARİH ve SAAT sütunlarında sayılar tarih-seri/saat-kesri olarak YORUMLANIR; diğer
// sütunlarda sayılar düz metne çevrilir.
function cellValueToString(v: unknown, kind: "tarih" | "saat" | "metin"): string {
    if (v === null || v === undefined || v === "") return "";
    if (typeof v === "number") {
        if (kind === "tarih") return serialToDateString(v);
        if (kind === "saat") return serialToTimeString(v);
        return String(v);
    }
    return String(v).trim();
}

export interface SheetTabRaw {
    spreadsheetTitle: string;
    tabTitle: string;
    /** Başlık satırı dahil, ham değerler (tarih/saat sütunları string'e çevrilmiş). */
    rows: string[][];
}

// Bu iki kaynağın her satırında aynı sabit başlık sırası var (federasyonun tek
// formatı): TARİH, SALON, SAAT, A TAKIMI, B TAKIMI, KATEGORİ, HAKEM, HAKEM,
// SAYI GÖREVLİSİ, SAAT GÖREVLİSİ, ŞUT SAATİ GÖREVLİSİ, YARDIMCI SAYI, FDS,
// GÖZLEMCİ/SAHA KOMİSERİ. Sütun index'leri başlık satırından okunur, sabit
// varsayılmaz — federasyon sütun sırasını değiştirirse `inspect` scripti ile
// yeniden kontrol edilmeli.
function kindForHeader(header: string): "tarih" | "saat" | "metin" {
    const h = header.trim().toLocaleLowerCase("tr");
    if (h === "tarih") return "tarih";
    if (h === "saat") return "saat";
    return "metin";
}

async function readTabRaw(spreadsheetId: string): Promise<SheetTabRaw> {
    const sheets = google.sheets({ version: "v4", auth: getOAuthClient() });

    const meta = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: "properties.title,sheets.properties.title",
    });
    const spreadsheetTitle = meta.data.properties?.title ?? spreadsheetId;
    const tabTitle = meta.data.sheets?.[0]?.properties?.title;
    if (!tabTitle) throw new Error(`E-Tablo ${spreadsheetId} içinde hiç sekme bulunamadı.`);

    const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tabTitle}'!A1:AF5000`,
        valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rawRows = (res.data.values || []) as unknown[][];
    if (rawRows.length === 0) return { spreadsheetTitle, tabTitle, rows: [] };

    const header = rawRows[0].map(h => String(h ?? ""));
    const kinds = header.map(kindForHeader);

    const rows: string[][] = [header];
    for (let i = 1; i < rawRows.length; i++) {
        const raw = rawRows[i];
        if (!raw || raw.length === 0) continue;
        const row = raw.map((v, j) => cellValueToString(v, kinds[j] ?? "metin"));
        if (row.every(c => !c)) continue;
        rows.push(row);
    }
    return { spreadsheetTitle, tabTitle, rows };
}

export async function readTbfMilliSheets(): Promise<{ current: SheetTabRaw; archive: SheetTabRaw }> {
    const currentId = process.env.TBF_MILLI_CURRENT_SHEET_ID;
    const archiveId = process.env.TBF_MILLI_ARCHIVE_SHEET_ID;
    if (!currentId || !archiveId) {
        throw new Error("TBF_MILLI_CURRENT_SHEET_ID / TBF_MILLI_ARCHIVE_SHEET_ID ayarlanmamış.");
    }

    const [current, archive] = await Promise.all([
        readTabRaw(currentId),
        readTabRaw(archiveId),
    ]);
    return { current, archive };
}
