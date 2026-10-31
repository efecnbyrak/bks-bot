import { MatchData } from "./match-parser";

// Maç bildirimlerinin başlık ve metinleri tek yerden üretilir (2026-10-31, kullanıcı
// seçimi). Başlıkta takım adı yok; ilk satır kısa (bildirim kapalıyken görünen kısım),
// altında maçın tüm bilgisi alt alta durur — kullanıcı bildirimi büyütünce görür.
// Saf fonksiyonlar: DB/ağ yok, testlerle kilitli (test/notification-text.test.ts).

const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
const WEEKDAYS = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];

// "01.11.2026" → "1 Kasım Pazar". Tarih okunamazsa Excel'deki hâli aynen döner.
export function formatDayTR(tarih: string): string {
    const m = (tarih ?? "").match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?!\d)/);
    if (!m) return (tarih ?? "").trim();
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return tarih.trim();
    const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
    return `${day} ${MONTHS[month - 1]} ${weekday}`;
}

// "12.00" / "9:5" gibi yazımları "12:00" biçimine çevirir; saat yoksa boş döner.
export function formatTime(saat?: string | null): string {
    const m = (saat ?? "").match(/(\d{1,2})[:.](\d{2})/);
    if (!m) return (saat ?? "").trim();
    return `${m[1].padStart(2, "0")}:${m[2]}`;
}

// Bir isim hücresinde gerçek bir kişi var mı? Federasyon atanmamış yere "*" / "-"
// yazabiliyor (web `assigned-filter.ts` → isRealPersonName ile aynı fikir).
function isRealName(name: string): boolean {
    return /\p{L}/u.test(name ?? "");
}

// Rol grupları ve sıraya göre koltuk adları. Masa sırası web
// `lib/matches/official-roles.ts` → seatLabels ("Sayı", "Saat", "Şut Saati") ile aynı —
// SYNC: biri değişirse diğeri de gözden geçirilmeli.
export const ROLE_GROUPS: { key: keyof MatchData; seats: string[]; fallback: string }[] = [
    { key: "hakemler", seats: ["Baş Hakem", "Yardımcı Hakem"], fallback: "Hakem" },
    { key: "masa_gorevlileri", seats: ["Sayı Görevlisi", "Saat Görevlisi", "Şut Saati Görevlisi"], fallback: "Masa Görevlisi" },
    { key: "istatistikciler", seats: ["İstatistikçi 1", "İstatistikçi 2"], fallback: "İstatistikçi" },
    { key: "gozlemciler", seats: [], fallback: "Gözlemci" },
    { key: "saglikcilar", seats: [], fallback: "Sağlıkçı" },
    { key: "sahaKomiserleri", seats: [], fallback: "Saha Komiseri" },
];

export function seatLabel(group: (typeof ROLE_GROUPS)[number], index: number): string {
    return group.seats[index] ?? group.fallback;
}

// Gruptaki gerçek isimler (yer tutucular ayıklanmış), Excel'deki sırasıyla.
export function namesOf(m: MatchData, key: keyof MatchData): string[] {
    return ((m[key] as string[]) ?? []).map(n => n.trim()).filter(isRealName);
}

// "📅 1 Kasım Pazar · ⏰ 14:00" — saat yoksa sadece gün.
function whenText(m: MatchData): string {
    const time = formatTime(m.saat);
    return time ? `📅 ${formatDayTR(m.tarih)} · ⏰ ${time}` : `📅 ${formatDayTR(m.tarih)}`;
}

// Maçın tüm bilgisi, alt alta. withStaff=false iptal bildiriminde kullanılır
// (kişi artık o maçta değil, kadro listesinin anlamı yok).
export function matchDetailLines(m: MatchData, withStaff = true): string[] {
    const lines: string[] = [`🏀 ${m.mac_adi.trim()}`];

    const category = [m.ligTuru, m.kategori, m.altKategori]
        .map(v => (v ?? "").trim())
        .filter(v => v.length > 0)
        .join(" · ");
    if (category) lines.push(`🏷️ ${category}`);

    lines.push(whenText(m));
    if (m.salon?.trim()) lines.push(`🏟️ ${m.salon.trim()}`);

    if (withStaff) {
        const staff: string[] = [];
        for (const group of ROLE_GROUPS) {
            namesOf(m, group.key).forEach((name, i) => staff.push(`• ${seatLabel(group, i)}: ${name}`));
        }
        if (staff.length > 0) lines.push("", "👥 Görevliler", ...staff);
    }
    return lines;
}

export interface NotificationText {
    title: string;
    body: string;
}

export function assignedText(m: MatchData): NotificationText {
    return {
        title: "🔔 Maç Atamanız Geldi!",
        body: [`${whenText(m)} — Detaylar için dokunun 👉`, "", ...matchDetailLines(m)].join("\n"),
    };
}

export function changedText(oldMatch: MatchData, newMatch: MatchData): NotificationText {
    const time = formatTime(newMatch.saat);
    const when = time ? `📅 ${formatDayTR(newMatch.tarih)} ⏰ ${time}` : `📅 ${formatDayTR(newMatch.tarih)}`;
    return {
        title: "🔄 Atamanızda Değişiklik Var",
        body: [
            `Eski maçınız kaldırıldı, yeni maçınız: ${when} 🏀`,
            "",
            ...matchDetailLines(newMatch),
            "",
            `❌ Eski maç: ${oldMatch.mac_adi.trim()} · ${whenText(oldMatch)}`,
        ].join("\n"),
    };
}

export function cancelledText(m: MatchData): NotificationText {
    return {
        title: "❌ Maç Atamanız İptal Edildi",
        body: [`${whenText(m)} maçındaki göreviniz kaldırıldı.`, "", ...matchDetailLines(m, false)].join("\n"),
    };
}

// changeLines: squad-change.ts → diffMatch çıktısı (boşsa bildirim hiç üretilmemeli).
export function updatedText(newMatch: MatchData, changeLines: string[]): NotificationText {
    return {
        title: "📝 Maçınız Güncellendi",
        body: [...changeLines, "", ...matchDetailLines(newMatch)].join("\n"),
    };
}
