import { MatchData } from "./match-parser";
import { ROLE_GROUPS, formatDayTR, formatTime, namesOf, seatLabel } from "./notification-text";

// İki maç hâli (eski / yeni) arasındaki farkı "Maçınız Güncellendi" bildiriminin
// satırlarına çevirir (2026-10-31, kullanıcı kararı):
//  - Aynı rol grubunda biri çıkıp biri girdiyse   → "🔁 Baş Hakem: A yerine B geldi"
//  - Sadece ekleme (boş yere birinin yazılması)    → satır YOK (ilk dolum, değişiklik sayılmaz)
//  - Sadece çıkarma (yerine kimse yazılmadı)       → satır YOK (çıkarılan kişiye zaten İptal gider)
//  - Hakemler arasında yer değişimi                → "🔁 Baş Hakem artık B"
//  - Tarih / saat / salon değişimi                 → "📅 Tarih: X → Y" vb. (boş alanın dolması hariç)
// Boş dizi = bildirilecek bir değişiklik yok, "Güncellendi" bildirimi GİTMEZ.

function norm(s: string): string {
    return (s ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase("tr");
}

export function diffMatch(oldMatch: MatchData | null, newMatch: MatchData | null): string[] {
    if (!oldMatch || !newMatch) return [];
    const lines: string[] = [];

    // Tarih / saat / salon — eski değer boşsa (federasyon sonradan doldurdu) değişiklik sayılmaz.
    if (oldMatch.tarih?.trim() && norm(oldMatch.tarih) !== norm(newMatch.tarih)) {
        lines.push(`📅 Tarih: ${formatDayTR(oldMatch.tarih)} → ${formatDayTR(newMatch.tarih)}`);
    }
    const oldTime = formatTime(oldMatch.saat);
    const newTime = formatTime(newMatch.saat);
    if (oldTime && newTime && oldTime !== newTime) {
        lines.push(`⏰ Saat: ${oldTime} → ${newTime}`);
    }
    if (oldMatch.salon?.trim() && newMatch.salon?.trim() && norm(oldMatch.salon) !== norm(newMatch.salon)) {
        lines.push(`🏟️ Salon: ${oldMatch.salon.trim()} → ${newMatch.salon.trim()}`);
    }

    for (const group of ROLE_GROUPS) {
        const oldNames = namesOf(oldMatch, group.key);
        const newNames = namesOf(newMatch, group.key);
        const oldSet = new Set(oldNames.map(norm));
        const newSet = new Set(newNames.map(norm));

        const removed = oldNames.filter(n => !newSet.has(norm(n)));
        const addedIdx = newNames.map((n, i) => ({ n, i })).filter(x => !oldSet.has(norm(x.n)));

        // Çıkan ile gireni sırayla eşle: "A yerine B". Eşi olmayan ekleme/çıkarma bildirilmez.
        const pairs = Math.min(removed.length, addedIdx.length);
        for (let k = 0; k < pairs; k++) {
            lines.push(`🔁 ${seatLabel(group, addedIdx[k].i)}: ${removed[k]} yerine ${addedIdx[k].n} geldi`);
        }

        // Hakemlerde koltuk değişimi (ör. Yardımcı Hakem Baş Hakem oldu) — sadece iki
        // listede de bulunan isimler için; yeni gelen biri zaten yukarıda yazıldı.
        if (group.key === "hakemler") {
            newNames.forEach((name, i) => {
                const oldIndex = oldNames.findIndex(o => norm(o) === norm(name));
                if (oldIndex >= 0 && oldIndex !== i && group.seats[i]) {
                    lines.push(`🔁 ${seatLabel(group, i)} artık ${name}`);
                }
            });
        }
    }

    return lines;
}
