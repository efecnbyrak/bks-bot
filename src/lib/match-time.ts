import { parseTarihDate } from "../db-writer";

// Türkiye 2016'dan beri yaz/kış saati uygulamıyor — İstanbul sabit UTC+3.
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;

// Maçın başlama anı (UTC). Tarih ve saat İstanbul yerel saati olarak okunur.
// Saat okunamıyorsa maçın günü BİTENE kadar (23:59 TRT) başlamamış sayılır —
// böylece saati boş bir maç gün içinde yanlışlıkla "geçmiş" damgası yemez.
// Tarih okunamıyorsa null döner.
export function matchStartUtc(tarih: string, saat?: string | null): Date | null {
    const day = parseTarihDate(tarih); // gün başı, 00:00 UTC
    if (!day) return null;
    const m = (saat ?? "").match(/(\d{1,2})[:.](\d{2})/);
    const minutes = m && Number(m[1]) < 24 && Number(m[2]) < 60
        ? Number(m[1]) * 60 + Number(m[2])
        : 23 * 60 + 59;
    return new Date(day.getTime() + minutes * 60_000 - ISTANBUL_OFFSET_MS);
}

// Maç başladı mı / oynandı mı? Bildirim kuralı (kullanıcı kararı, 2026-10-26):
// başlama saati gelmiş bir maç için "iptal / güncellendi / değişti / yeni atama"
// bildirimi GÖNDERİLMEZ — federasyon oynanan maçı arşive taşıyınca dosyadan
// kalkması iptal değildir. Tarih okunamıyorsa false (eski davranış korunur).
export function isMatchStarted(tarih: string, saat?: string | null, now: Date = new Date()): boolean {
    const start = matchStartUtc(tarih, saat);
    if (!start) return false;
    return start.getTime() <= now.getTime();
}
