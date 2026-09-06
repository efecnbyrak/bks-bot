import { NewAssignmentInfo } from "./user-matcher";
import { CancelledMatchInfo, ShiftedAssignmentInfo, createCancellationAnnouncements } from "./db-writer";
import {
    sendAssignmentPush,
    sendCancellationPush,
    sendMatchChangedPush,
    sendMatchUpdatedPush,
} from "./lib/push-sender";
import { summarizeSquadChange } from "./lib/squad-change";
import { logger } from "./logger";

/**
 * Bir sync koşusunda (current + arşiv, tüm klasörler işlendikten sonra) toplanan
 * "yeni atama", "iptal" ve "kadro güncellemesi (taşınan atama)" olaylarını kullanıcı
 * bazında karşılaştırıp doğru bildirim tipini seçer:
 *
 *   1. Kullanıcı maçta kaldı, sadece kadro değişti (ROW_SHIFTED)         → "Maçınız Güncellendi"
 *   2. Kullanıcı bir maçtan çıkarıldı + FARKLI bir maça atandı           → "Maçınız Değişti"
 *   3. Kullanıcı sadece bir maçtan çıkarıldı                             → "Maç İptal Edildi"
 *   4. Kullanıcı sadece yeni (daha önce hiç görülmemiş) bir maça atandı  → "Yeni Maça Atandınız"
 *
 * Karar mantığı planNotifications() saf fonksiyonunda; bu fonksiyon sadece I/O yapar.
 */

export type NotificationKind = "UPDATED" | "CHANGED" | "CANCELLED" | "ASSIGNED";

export interface PlannedNotification {
    kind: NotificationKind;
    userId: number;
    // UPDATED / ASSIGNED / CANCELLED
    macAdi?: string;
    tarih?: string;
    // UPDATED
    changeSummary?: string;
    // CHANGED
    oldMacAdi?: string;
    oldTarih?: string;
    newMacAdi?: string;
    newTarih?: string;
}

export interface PlanInput {
    newAssignments: NewAssignmentInfo[];
    cancellations: CancelledMatchInfo[];
    shifted: ShiftedAssignmentInfo[];
}

export function planNotifications(input: PlanInput): {
    notifications: PlannedNotification[];
    // Gerçek iptaller için toplu duyuru + toplu push (maç bazında gruplu)
    realCancellationGroups: { macAdi: string; tarih: string; userIds: number[] }[];
} {
    const notifications: PlannedNotification[] = [];

    // Bir kullanıcı için birden fazla olay olabilir — hangi kullanıcının hangi bildirimi
    // aldığını tek seferde belirleyelim ki çift bildirim gitmesin.
    const handledUsers = new Set<number>();

    // 1) ROW_SHIFTED — kullanıcı maçta kaldı, kadro değişti
    const shiftedByUser = new Map<number, ShiftedAssignmentInfo>();
    for (const s of input.shifted) {
        if (!shiftedByUser.has(s.userId)) shiftedByUser.set(s.userId, s);
    }

    // 2) Yeni atamalar — kullanıcı başına ilk atama
    const newAssignmentByUser = new Map<number, NewAssignmentInfo>();
    for (const a of input.newAssignments) {
        if (!newAssignmentByUser.has(a.userId)) newAssignmentByUser.set(a.userId, a);
    }

    // 3) İptaller — kullanıcı bazında düzleştir (contentKey ile birlikte)
    interface FlatCancellation { userId: number; macAdi: string; tarih: string; contentKey: string | null }
    const flatCancellations: FlatCancellation[] = [];
    for (const c of input.cancellations) {
        for (const userId of c.affectedUserIds) {
            flatCancellations.push({ userId, macAdi: c.macAdi, tarih: c.tarih, contentKey: c.contentKey });
        }
    }
    const cancellationByUser = new Map<number, FlatCancellation>();
    for (const fc of flatCancellations) {
        if (!cancellationByUser.has(fc.userId)) cancellationByUser.set(fc.userId, fc);
    }

    // --- Öncelik 1: ROW_SHIFTED → "Maçınız Güncellendi" ---
    for (const [userId, s] of shiftedByUser) {
        notifications.push({
            kind: "UPDATED",
            userId,
            macAdi: s.macAdi,
            tarih: s.tarih,
            changeSummary: summarizeSquadChange(s.oldMatchData, s.newMatchData),
        });
        handledUsers.add(userId);
    }

    // --- Öncelik 2 & 3: iptaller ---
    const realCancellationsByMatch = new Map<string, { macAdi: string; tarih: string; userIds: number[] }>();

    for (const [userId, fc] of cancellationByUser) {
        if (handledUsers.has(userId)) continue; // zaten UPDATED aldı

        const newAssignment = newAssignmentByUser.get(userId);

        // Aynı maça (aynı contentKey) yeniden atanma → bu aslında bir güncelleme, iptal değil.
        // (ROW_SHIFTED yakalayamadığı bir edge-case: satır iptal + yeni satır atama ayrı ayrı geldi.)
        if (newAssignment && fc.contentKey && newAssignment.contentKey === fc.contentKey) {
            notifications.push({
                kind: "UPDATED",
                userId,
                macAdi: newAssignment.macAdi,
                tarih: newAssignment.tarih,
                changeSummary: "Maç bilgileri güncellendi",
            });
            handledUsers.add(userId);
            continue;
        }

        // Farklı bir maça atanma → "Maçınız Değişti"
        if (newAssignment) {
            notifications.push({
                kind: "CHANGED",
                userId,
                oldMacAdi: fc.macAdi,
                oldTarih: fc.tarih,
                newMacAdi: newAssignment.macAdi,
                newTarih: newAssignment.tarih,
            });
            handledUsers.add(userId);
            continue;
        }

        // Sadece iptal → gerçek iade, maç bazında grupla
        const key = `${fc.macAdi}|${fc.tarih}`;
        if (!realCancellationsByMatch.has(key)) {
            realCancellationsByMatch.set(key, { macAdi: fc.macAdi, tarih: fc.tarih, userIds: [] });
        }
        realCancellationsByMatch.get(key)!.userIds.push(userId);
        handledUsers.add(userId);
    }

    // --- Öncelik 4: yeni atamalar (henüz ele alınmamış kullanıcılar) ---
    for (const [userId, a] of newAssignmentByUser) {
        if (handledUsers.has(userId)) continue;
        notifications.push({
            kind: "ASSIGNED",
            userId,
            macAdi: a.macAdi,
            tarih: a.tarih,
        });
        handledUsers.add(userId);
    }

    return {
        notifications,
        realCancellationGroups: [...realCancellationsByMatch.values()],
    };
}

const DRY_RUN = process.env.NOTIFY_DRY_RUN === "1";

export async function reconcileAndNotify(
    newAssignments: NewAssignmentInfo[],
    cancellations: CancelledMatchInfo[],
    isInitialBootstrap: boolean,
    shifted: ShiftedAssignmentInfo[] = []
): Promise<void> {
    if (isInitialBootstrap) {
        logger.info("İlk kurulum — bildirim gönderimi atlandı", {
            newAssignmentCount: newAssignments.length,
            cancellationCount: cancellations.reduce((sum, c) => sum + c.affectedUserIds.length, 0),
            shiftedCount: shifted.length,
        });
        return;
    }

    if (newAssignments.length === 0 && cancellations.length === 0 && shifted.length === 0) return;

    const { notifications, realCancellationGroups } = planNotifications({
        newAssignments,
        cancellations,
        shifted,
    });

    if (DRY_RUN) {
        logger.info("NOTIFY_DRY_RUN — bildirimler GÖNDERİLMEDİ, sadece loglandı", {
            planlanan: notifications.map(n => ({ kind: n.kind, userId: n.userId })),
            gercekIptalGrup: realCancellationGroups.length,
        });
        return;
    }

    // Gerçek iptaller: duyuru + toplu push
    if (realCancellationGroups.length > 0) {
        await createCancellationAnnouncements(
            realCancellationGroups.map(c => ({
                matchId: 0, matchKey: "", contentKey: null,
                macAdi: c.macAdi, tarih: c.tarih, affectedUserIds: c.userIds,
            }))
        );
        for (const c of realCancellationGroups) {
            try {
                await sendCancellationPush(c.userIds, c.macAdi, c.tarih);
            } catch (err: any) {
                logger.error("İptal bildirimi gönderilemedi", { macAdi: c.macAdi, error: err?.message });
            }
        }
    }

    // Kullanıcı bazlı bildirimler
    let updated = 0, changed = 0, assigned = 0;
    for (const n of notifications) {
        try {
            if (n.kind === "UPDATED") {
                await sendMatchUpdatedPush(n.userId, n.macAdi!, n.tarih!, n.changeSummary!);
                updated++;
            } else if (n.kind === "CHANGED") {
                await sendMatchChangedPush(n.userId, n.oldMacAdi!, n.oldTarih!, n.newMacAdi!, n.newTarih!);
                changed++;
            } else if (n.kind === "ASSIGNED") {
                await sendAssignmentPush(n.userId, n.macAdi!, n.tarih!);
                assigned++;
            }
        } catch (err: any) {
            logger.error("Bildirim gönderilemedi", { kind: n.kind, userId: n.userId, error: err?.message });
        }
    }

    logger.info("Bildirimler gönderildi", {
        guncellendi: updated,
        degisti: changed,
        yeniAtama: assigned,
        gercekIptalGrup: realCancellationGroups.length,
        gercekIptalKullanici: realCancellationGroups.reduce((s, c) => s + c.userIds.length, 0),
    });
}
