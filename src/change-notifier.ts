import { NewAssignmentInfo } from "./user-matcher";
import { CancelledMatchInfo, ShiftedAssignmentInfo, parseTarihDate } from "./db-writer";
import { diffMatch } from "./lib/squad-change";
import { assignedText, cancelledText, changedText, updatedText } from "./lib/notification-text";
import { MatchData } from "./lib/match-parser";
import { isMatchStarted } from "./lib/match-time";

/**
 * Bir sync koşusunda (current + arşiv, tüm klasörler işlendikten sonra) toplanan
 * "yeni atama", "iptal" ve "kadro güncellemesi (taşınan atama)" olaylarını kullanıcı
 * bazında eşleştirip doğru bildirim tipini seçer:
 *
 *   1. Kullanıcı maçta kaldı, kadroda biri değişti (ROW_SHIFTED)              → "Maçınız Güncellendi"
 *   2. Kullanıcı çıkarıldı + AYNI maça (aynı takımlar) yeni tarih/saatle yazıldı → "Maçınız Güncellendi"
 *   3. Kullanıcı çıkarıldı + AYNI GÜN başka bir maça atandı                    → "Atamanızda Değişiklik Var"
 *   4. Kullanıcı sadece çıkarıldı                                              → "Maç Atamanız İptal Edildi"
 *   5. Kullanıcı sadece yeni bir maça atandı                                   → "Maç Atamanız Geldi"
 *
 * 2026-10-31'e kadar kullanıcı başına sadece İLK olay bildiriliyordu (aynı turda iki
 * maça atanan kişi tek bildirim alıyordu). Artık her maç için ayrı bildirim üretilir.
 * Bu dosya SAF: karar + metin. Gönderim, teyit kuyruğu ve reconcileAndNotify
 * src/notification-outbox.ts'te.
 */

export type NotificationKind = "UPDATED" | "CHANGED" | "CANCELLED" | "ASSIGNED";

export interface PlannedNotification {
    kind: NotificationKind;
    userId: number;
    // Bildirimin ait olduğu maç: ASSIGNED/UPDATED/CHANGED'de güncel (yeni) maç,
    // CANCELLED'de iptal edilen maç.
    contentKey: string | null;
    match: MatchData;
    // UPDATED / CHANGED: karşılaştırmanın tabanı (eski hâl) ve eski maçın anahtarı.
    oldMatch?: MatchData;
    oldContentKey?: string | null;
    // UPDATED: diffMatch satırları ("Baş Hakem: A yerine B geldi" vb.) — boşsa plana girmez.
    changeLines?: string[];
}

export interface PlanInput {
    newAssignments: NewAssignmentInfo[];
    cancellations: CancelledMatchInfo[];
    shifted: ShiftedAssignmentInfo[];
}

// Bildirim yalnızca HENÜZ BAŞLAMAMIŞ maçlar için gider (kullanıcı kararı, 2026-10-26):
// oynanmış bir maç için "iptal / güncellendi / değişti / yeni atama" anlamsızdır —
// federasyon oynanan maçı arşive taşıyınca dosyadan kalkması iptal DEĞİLDİR.
// Bu süzgeç olaylar plana girmeden önce uygulanır.
export function filterFutureEvents(input: PlanInput, now: Date = new Date()): PlanInput {
    const future = (tarih: string, saat?: string | null) => !isMatchStarted(tarih, saat, now);
    return {
        newAssignments: input.newAssignments.filter(a => future(a.tarih, a.saat)),
        cancellations: input.cancellations.filter(c => future(c.tarih, c.saat)),
        shifted: input.shifted.filter(s => future(s.tarih, s.saat)),
    };
}

// Eksik veri gelirse (eski kayıt, satır okunamadı) bildirim metni yine kurulabilsin diye
// eldeki alanlardan asgari bir MatchData üretir.
function fallbackMatch(macAdi: string, tarih: string, saat?: string | null): MatchData {
    return {
        mac_adi: macAdi, tarih, saat: saat ?? undefined, kategori: "", ligTuru: "",
        hakemler: [], masa_gorevlileri: [], saglikcilar: [], istatistikciler: [],
        gozlemciler: [], sahaKomiserleri: [], kaynak_dosya: "",
    };
}

// "Aynı maç mı?" — takımlar (maç adı) + lig türü aynıysa evet. Tarih/saat değişince
// contentKey değişiyor ama maç aynı kalıyor; bu durum "Değişiklik" değil "Güncellendi".
function sameFixture(a: MatchData, b: MatchData): boolean {
    const n = (s: string) => (s ?? "").replace(/\s+/g, " ").trim().toLocaleUpperCase("tr");
    return n(a.mac_adi) === n(b.mac_adi) && n(a.ligTuru) === n(b.ligTuru);
}

function sameDay(a: MatchData, b: MatchData): boolean {
    const da = parseTarihDate(a.tarih);
    const db_ = parseTarihDate(b.tarih);
    return !!da && !!db_ && da.getTime() === db_.getTime();
}

// Teyit kuyruğunda (notification-outbox.ts) henüz gönderilmemiş bir iptal. Bu turun
// olaylarıyla birlikte eşleştirilir: kişi aynı maça geri yazıldıysa iptal sessizce
// düşer (yarım düzenleme), başka maça yazıldıysa Değişiklik / Güncellendi'ye dönüşür.
export interface PendingCancel {
    id: number;
    userId: number;
    contentKey: string | null;
    match: MatchData;
}

export function planNotifications(rawInput: PlanInput, now: Date = new Date()): PlannedNotification[] {
    return planWithPending(rawInput, [], now).notifications;
}

// consumedPendingIds: bu turda bir olayla eşleşip artık gönderilmemesi gereken bekleyen iptaller.
export function planWithPending(
    rawInput: PlanInput,
    pendingCancels: PendingCancel[],
    now: Date = new Date()
): { notifications: PlannedNotification[]; consumedPendingIds: number[] } {
    const input = filterFutureEvents(rawInput, now);
    const consumedPendingIds: number[] = [];
    const out: PlannedNotification[] = [];
    // Aynı kişiye aynı maç için iki bildirim gitmesin (farklı klasörlerden aynı olay gelebilir).
    const seen = new Set<string>();
    const push = (n: PlannedNotification) => {
        const key = `${n.kind}|${n.userId}|${n.contentKey ?? n.match.mac_adi + n.match.tarih}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(n);
    };

    // Olayları kullanıcı bazında topla.
    interface Cancel { contentKey: string | null; match: MatchData; pendingId?: number }
    interface Assign { contentKey: string | null; match: MatchData }
    const cancelsByUser = new Map<number, Cancel[]>();
    for (const c of input.cancellations) {
        const match = c.matchData ?? fallbackMatch(c.macAdi, c.tarih, c.saat);
        for (const userId of c.affectedUserIds) {
            const list = cancelsByUser.get(userId) ?? [];
            list.push({ contentKey: c.contentKey, match });
            cancelsByUser.set(userId, list);
        }
    }
    // Bekleyen iptaller sadece bu turda aynı kişiye ait bir yeni atama varsa işe yarar;
    // eşleşmezlerse kuyrukta kalmaya devam ederler (tekrar plana girmezler).
    for (const p of pendingCancels) {
        const list = cancelsByUser.get(p.userId) ?? [];
        list.push({ contentKey: p.contentKey, match: p.match, pendingId: p.id });
        cancelsByUser.set(p.userId, list);
    }
    const assignsByUser = new Map<number, Assign[]>();
    for (const a of input.newAssignments) {
        const list = assignsByUser.get(a.userId) ?? [];
        list.push({ contentKey: a.contentKey, match: a.matchData ?? fallbackMatch(a.macAdi, a.tarih, a.saat) });
        assignsByUser.set(a.userId, list);
    }

    // 1) Kadro değişikliği — kişi maçta kaldı. Bildirim sadece "A yerine B" ya da
    // tarih/saat/salon değişikliği varsa gider; boş yere biri yazıldıysa (ilk dolum) gitmez.
    for (const s of input.shifted) {
        const newMatch = s.newMatchData ?? fallbackMatch(s.macAdi, s.tarih, s.saat);
        const changeLines = diffMatch(s.oldMatchData, s.newMatchData);
        // Aynı maça yeni atama olayı da geldiyse (teorik) onu tüket — kişi zaten maçta.
        const assigns = assignsByUser.get(s.userId);
        if (assigns) assignsByUser.set(s.userId, assigns.filter(a => a.contentKey !== s.contentKey));
        if (changeLines.length === 0) continue;
        push({
            kind: "UPDATED", userId: s.userId, contentKey: s.contentKey,
            match: newMatch, oldMatch: s.oldMatchData ?? undefined, changeLines,
        });
    }

    // 2) İptalleri aynı kişinin yeni atamalarıyla eşleştir.
    for (const [userId, cancels] of cancelsByUser) {
        const assigns = assignsByUser.get(userId) ?? [];
        for (const c of cancels) {
            // Önce aynı maç (aynı contentKey ya da aynı takımlar + lig) → Güncellendi.
            let idx = assigns.findIndex(a =>
                (c.contentKey && a.contentKey === c.contentKey) || sameFixture(a.match, c.match));
            if (idx >= 0) {
                const a = assigns.splice(idx, 1)[0];
                if (c.pendingId !== undefined) consumedPendingIds.push(c.pendingId);
                const changeLines = diffMatch(c.match, a.match);
                if (changeLines.length > 0) {
                    push({
                        kind: "UPDATED", userId, contentKey: a.contentKey, match: a.match,
                        oldMatch: c.match, oldContentKey: c.contentKey, changeLines,
                    });
                }
                continue;
            }
            // Sonra aynı gün başka bir maç → Değişiklik.
            idx = assigns.findIndex(a => sameDay(a.match, c.match));
            if (idx >= 0) {
                const a = assigns.splice(idx, 1)[0];
                if (c.pendingId !== undefined) consumedPendingIds.push(c.pendingId);
                push({
                    kind: "CHANGED", userId, contentKey: a.contentKey, match: a.match,
                    oldMatch: c.match, oldContentKey: c.contentKey,
                });
                continue;
            }
            // Zaten kuyrukta bekleyen iptal tekrar plana girmez.
            if (c.pendingId === undefined) {
                push({ kind: "CANCELLED", userId, contentKey: c.contentKey, match: c.match });
            }
        }
        assignsByUser.set(userId, assigns);
    }

    // 3) Eşleşmeyen yeni atamalar → Maç Atamanız Geldi.
    for (const [userId, assigns] of assignsByUser) {
        for (const a of assigns) {
            push({ kind: "ASSIGNED", userId, contentKey: a.contentKey, match: a.match });
        }
    }

    return { notifications: out, consumedPendingIds };
}

// Planlanmış bir bildirimin başlık + metni.
export function notificationText(n: PlannedNotification): { title: string; body: string } {
    switch (n.kind) {
        case "ASSIGNED": return assignedText(n.match);
        case "CANCELLED": return cancelledText(n.match);
        case "CHANGED": return changedText(n.oldMatch ?? n.match, n.match);
        case "UPDATED": return updatedText(n.match, n.changeLines ?? []);
    }
}
