// TEŞHİS/DRY-RUN scripti (SALT OKUMA). İki TBF/Milli E-Tablosunu okur, mevcut
// parseWorkbook ile ayrıştırır ve sonucu konsola basar. Veritabanına HİÇBİR ŞEY YAZMAZ.
//
// Çalıştırma (önce .env'e GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN +
// TBF_MILLI_CURRENT_SHEET_ID/TBF_MILLI_ARCHIVE_SHEET_ID eklenmeli):
//   node --env-file=.env ./node_modules/.bin/ts-node scripts/dry-run-tbf-milli.ts

import { readTbfMilliSheets } from "../src/lib/sheets-source";
import { parseWorkbook } from "../src/lib/match-parser";

async function buildWorkbook(tabTitle: string, rows: string[][]) {
    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(tabTitle);
    ws.addRows(rows);
    return wb;
}

function line(c = "─", n = 90) { console.log(c.repeat(n)); }

async function main() {
    line("═");
    console.log("TBF/MİLLİ SHEET DRY-RUN (salt okuma, DB'ye yazılmaz)");
    line("═");

    const { current, archive } = await readTbfMilliSheets();

    for (const [label, tab, sheetId] of [
        ["GÜNCEL", current, process.env.TBF_MILLI_CURRENT_SHEET_ID],
        ["ARŞİV", archive, process.env.TBF_MILLI_ARCHIVE_SHEET_ID],
    ] as const) {
        line();
        console.log(`${label} — "${tab.spreadsheetTitle}" / sekme "${tab.tabTitle}" (${tab.rows.length - 1} veri satırı)`);
        line();

        const wb = await buildWorkbook(tab.tabTitle, tab.rows);
        const matches = parseWorkbook(wb as any, tab.spreadsheetTitle);
        console.log(`parseWorkbook → ${matches.length} maç ayrıştırıldı (beklenen: ${tab.rows.length - 1})\n`);

        for (const m of matches.slice(0, 10)) {
            console.log(
                `  ${m.tarih} ${m.saat ?? "—"} | ${m.mac_adi} | kategori=${m.kategori} | ligTuru=${m.ligTuru} | ` +
                `masaGorevlileri=${m.masa_gorevlileri.length} | gozlemciler=${m.gozlemciler.length}`
            );
        }
        if (matches.length > 10) console.log(`  ... ve ${matches.length - 10} tane daha`);

        if (matches.length !== tab.rows.length - 1) {
            console.log(`\n  ⚠️  Satır sayısı uyuşmuyor — bazı satırlar ayrıştırılamadı, sheets-source.ts/match-parser.ts ile ham veriyi karşılaştır.`);
        }

        const kategoriDagilimi: Record<string, number> = {};
        for (const m of matches) kategoriDagilimi[m.kategori] = (kategoriDagilimi[m.kategori] ?? 0) + 1;
        console.log(`\n  Kategori dağılımı: ${JSON.stringify(kategoriDagilimi)}`);
    }

    line("═");
    console.log("DRY-RUN BİTTİ — hiçbir şey yazılmadı.");
    line("═");
}

main().catch(err => {
    console.error("DRY-RUN HATASI:", err?.message ?? err);
    process.exit(1);
});
