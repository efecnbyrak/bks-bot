import { createHash } from "crypto";
import { db } from "../db";
import { logger } from "../logger";

// Maç bildirimi E-POSTA YEDEĞİ (2026-11-15).
//
// Push'u kişiye ulaşmayan bildirimler (token yok, kalıcı FCM hatası, yeniden denemeler
// tükendi ya da telefonda bildirim izni kapalı) `notification_fallbacks` tablosuna yazılır.
// Bot sadece SATIR EKLER; e-postayı web cron'u (`api/cron/push-fallback-email`) gönderir —
// Resend anahtarı ve e-posta şablonu tek yerde (web) kalsın diye. Aynı bildirim iki kez
// yazılmasın diye `dedupeKey` benzersizdir.

export interface FallbackItem {
    userId: number;
    kind: string;
    title: string;
    body: string;
    // Maçın içerik anahtarı; yoksa maç adı + tarih.
    matchKey: string;
}

// Saf: aynı kişiye aynı maç için aynı metinli bildirim → aynı anahtar. Metin özeti
// anahtara girer: aynı maçta ikinci, farklı bir "Güncellendi" bildirimi de e-postayla gitsin.
export function fallbackDedupeKey(item: FallbackItem): string {
    const textHash = createHash("sha256").update(`${item.title}\n${item.body}`).digest("hex").slice(0, 16);
    return `${item.kind}|${item.matchKey}|${item.userId}|${textHash}`;
}

// Yedek kayıtlarını yazar. Hata bildirim akışını DURDURMAZ (push zaten denendi) ama loglanır.
export async function recordFallbacks(items: FallbackItem[]): Promise<number> {
    if (items.length === 0) return 0;
    try {
        const res = await db.notificationFallback.createMany({
            data: items.map(i => ({
                userId: i.userId,
                kind: i.kind,
                title: i.title.slice(0, 300),
                body: i.body.slice(0, 4000),
                dedupeKey: fallbackDedupeKey(i),
            })),
            skipDuplicates: true,
        });
        logger.info("E-posta yedeği kuyruğa yazıldı", { adet: res.count, kisiler: items.map(i => i.userId) });
        return res.count;
    } catch (err: any) {
        logger.error("E-posta yedeği yazılamadı", { error: err?.message, kisiler: items.map(i => i.userId) });
        return 0;
    }
}
