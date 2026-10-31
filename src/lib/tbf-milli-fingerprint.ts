// TBF/Milli E-Tablo sekmeleri için "içerik değişti mi?" parmak izi.
// Drive .xlsx dosyalarında md5 var, Google E-Tablolarında yok — bu yüzden sekmenin ham
// satırlarından kendimiz bir hash üretiyoruz. Bilerek SAF tutuldu: sadece crypto ve
// SheetTabRaw TİPİNİ alıyor, db/google import etmiyor (test hafif kalsın diye).

import { createHash } from "crypto";
import type { SheetTabRaw } from "./sheets-source";

// Parse veya atama mantığı değiştiğinde bu sürümü artır: parmak izleri değişir ve
// bütün sekmeler bir kez baştan işlenir (içerik aynı olsa bile eski sonuç geçersiz sayılır).
export const TBF_MILLI_FINGERPRINT_VERSION = "v1";

// Sekmenin parmak izi. Sezon anahtarı ve sezon kesim tarihi de girdiye dahil: sezon
// ayarı değişirse içerik aynı kalsa bile hangi maçların yazılacağı değişir, o yüzden
// sekme yeniden işlenmeli.
export function computeTabFingerprint(
    tab: SheetTabRaw,
    ctx: { seasonKey: string; cutoffIso: string }
): string {
    const payload = JSON.stringify([
        TBF_MILLI_FINGERPRINT_VERSION,
        ctx.seasonKey,
        ctx.cutoffIso,
        tab.spreadsheetTitle,
        tab.tabTitle,
        tab.rows,
    ]);
    return createHash("sha256").update(payload).digest("hex");
}

// Sekme atlanabilir mi? Sadece zorlama yoksa ve eski/yeni parmak izi ikisi de varsa
// ve birebir aynıysa. Şüphe durumunda (boş değer, zorlama) her zaman işlenir.
export function shouldSkipTab(
    prev: string | null | undefined,
    next: string | null | undefined,
    force: boolean
): boolean {
    return !force && !!prev && !!next && prev === next;
}
