import { MatchData } from "./match-parser";

// FAZ 3 — İki ParsedMatch satırı (eski kadro / yeni kadro) arasındaki farkı,
// kullanıcıya gösterilecek ÇOK KISA bir Türkçe cümleye çevirir.
// Saat/salon farkı bilinçli olarak ele alınmıyor (o metin sonraki tura bırakıldı) —
// sadece görevli kadrosundaki değişiklik özetlenir.

const ROLE_LABELS: { key: keyof MatchData; label: string }[] = [
    { key: "hakemler", label: "hakem" },
    { key: "masa_gorevlileri", label: "masa görevlisi" },
    { key: "saglikcilar", label: "sağlık görevlisi" },
    { key: "istatistikciler", label: "istatistikçi" },
    { key: "gozlemciler", label: "gözlemci" },
    { key: "sahaKomiserleri", label: "saha komiseri" },
];

function norm(s: string): string {
    return s.trim().toLowerCase();
}

export function summarizeSquadChange(oldMatch: MatchData | null, newMatch: MatchData | null): string {
    if (!oldMatch || !newMatch) return "Görevli kadrosu güncellendi";

    let added = 0;
    let removed = 0;
    const changedRoles: string[] = [];

    for (const { key, label } of ROLE_LABELS) {
        const oldList = (oldMatch[key] as string[]).map(norm);
        const newList = (newMatch[key] as string[]).map(norm);
        const oldSet = new Set(oldList);
        const newSet = new Set(newList);

        const roleAdded = newList.filter(n => !oldSet.has(n)).length;
        const roleRemoved = oldList.filter(n => !newSet.has(n)).length;

        if (roleAdded > 0 || roleRemoved > 0) {
            changedRoles.push(label);
            added += roleAdded;
            removed += roleRemoved;
        }
    }

    if (added === 0 && removed === 0) {
        return "Maç bilgileri güncellendi";
    }

    // Tek rol grubunda değişiklik → daha spesifik cümle
    if (changedRoles.length === 1) {
        const role = changedRoles[0];
        if (added > 0 && removed === 0) return `Kadroya ${added} ${role} eklendi`;
        if (removed > 0 && added === 0) return `Kadrodan ${removed} ${role} çıkarıldı`;
        return `${role.charAt(0).toLocaleUpperCase("tr")}${role.slice(1)} kadrosu değişti`;
    }

    // Birden fazla rol grubunda değişiklik → genel özet
    if (added > 0 && removed === 0) return `Görevli kadrosuna ${added} kişi eklendi`;
    if (removed > 0 && added === 0) return `Görevli kadrosundan ${removed} kişi çıkarıldı`;
    return "Görevli kadrosu güncellendi";
}
