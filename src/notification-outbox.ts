import { db } from "./db";
import { logger } from "./logger";
import { MatchData } from "./lib/match-parser";
import { diffMatch } from "./lib/squad-change";
import { isMatchStarted } from "./lib/match-time";
import {
    CancelledMatchInfo, MATCH_DATA_SELECT, ShiftedAssignmentInfo, createCancellationAnnouncements, parsedRowToMatchData,
} from "./db-writer";
import { NewAssignmentInfo } from "./user-matcher";
import { sendMatchPush } from "./lib/push-sender";
import { NotificationKind, PendingCancel, PlannedNotification, notificationText, planWithPending } from "./change-notifier";

// Maç bildirimi TEYİT KUYRUĞU (2026-10-31).
//
// Neden var: federasyon E-Tabloyu canlı düzenlerken bot dakikada bir okuyor; bir ismin
// silinip yenisinin henüz yazılmadığı yarım hâl "iptal" sanılıyordu. 29 Ekim 20:09'da
// 15 kişiye sahte "Maç İptal" gitti, 20:17'de dosya düzelince aynı kişilere "Yeni Maça
// Atandınız" gitti (26 Ekim'den sonraki 39 iptal bildiriminin 17'si böyleydi).
//
// Kural: "Atama" anında gider (yarım düzenleme sahte atama üretmiyor — eşleşme tam isim
// istiyor). İptal / Güncellendi / Değişiklik `match_notification_outbox`'a yazılır,
// `dueAt`'e kadar bekler; süre dolunca DB'nin O ANKİ hâliyle yeniden kontrol edilir,
// hâlâ geçerliyse gönderilir (SENT), değilse sessizce düşer (DROPPED + sebep).
// DB'deki atama silme / satır iptali bugünkü gibi anında yapılır; sadece bildirim bekler.

const DRY_RUN = process.env.NOTIFY_DRY_RUN === "1";

export const CONFIRM_DELAY_MIN = Math.max(1, Number(process.env.NOTIFY_CONFIRM_DELAY_MIN) || 10);

type QueuedKind = "CANCELLED" | "UPDATED" | "CHANGED";

// Bildirim payload'ı JSON olarak saklanır; Prisma Json alanı düz obje bekliyor.
function toPayload(n: PlannedNotification): object {
    return JSON.parse(JSON.stringify(n));
}

// Kuyruktaki iptalleri bu turun planlamasına sokmak için okur (sadece olayı olan kişiler).
export async function loadPendingCancels(userIds: number[]): Promise<PendingCancel[]> {
    if (userIds.length === 0) return [];
    const rows = await db.matchNotificationOutbox.findMany({
        where: { status: "PENDING", kind: "CANCELLED", userId: { in: userIds } },
        select: { id: true, userId: true, contentKey: true, payload: true },
    });
    return rows.map((r: { id: number; userId: number; contentKey: string | null; payload: unknown }) => ({
        id: r.id,
        userId: r.userId,
        contentKey: r.contentKey,
        match: (r.payload as unknown as PlannedNotification).match,
    }));
}

export async function dropPending(ids: number[], reason: string): Promise<void> {
    if (ids.length === 0) return;
    await db.matchNotificationOutbox.updateMany({
        where: { id: { in: ids }, status: "PENDING" },
        data: { status: "DROPPED", dropReason: reason, sentAt: new Date() },
    });
}

// İptal / Güncellendi / Değişiklik bildirimlerini kuyruğa yazar. Aynı kişi + maç +
// tür için zaten bekleyen bir kayıt varsa yenisi açılmaz: ilk kaydın tabanı (eski
// kadro/tarih) korunur, art arda yapılan düzenlemeler teyitte tek bir net farka iner.
export async function enqueueNotifications(notifications: PlannedNotification[], now: Date = new Date()): Promise<number> {
    const queued = notifications.filter(n => n.kind !== "ASSIGNED");
    if (queued.length === 0) return 0;

    const existing = await db.matchNotificationOutbox.findMany({
        where: { status: "PENDING", userId: { in: [...new Set(queued.map(n => n.userId))] } },
        select: { userId: true, kind: true, contentKey: true },
    });
    const has = new Set(existing.map((e: { userId: number; kind: string; contentKey: string | null }) =>
        `${e.userId}|${e.kind}|${e.contentKey ?? ""}`));

    const dueAt = new Date(now.getTime() + CONFIRM_DELAY_MIN * 60_000);
    const data = queued
        .filter(n => !has.has(`${n.userId}|${n.kind}|${n.contentKey ?? ""}`))
        .map(n => ({
            userId: n.userId,
            kind: n.kind,
            contentKey: n.contentKey,
            oldContentKey: n.oldContentKey ?? null,
            payload: toPayload(n),
            dueAt,
        }));
    if (data.length > 0) await db.matchNotificationOutbox.createMany({ data });
    return data.length;
}

// --- Teyit kararı (saf, DB'siz, testli) ---

export interface PendingRow {
    kind: QueuedKind;
    payload: PlannedNotification;
}

// Teyit anında DB'den okunan güncel durum.
export interface CurrentState {
    // Kişinin bildirimdeki maçın (contentKey) aktif bir satırında ataması var mı; varsa o satırın hâli.
    userMatch: MatchData | null;
    // CHANGED için: kişi ESKİ maçta (oldContentKey) hâlâ duruyor mu.
    userInOldMatch: boolean;
}

export type Resolution =
    | { action: "send"; notification: PlannedNotification }
    | { action: "drop"; reason: string };

export function resolvePending(row: PendingRow, state: CurrentState, now: Date = new Date()): Resolution {
    const n = row.payload;

    if (row.kind === "CANCELLED") {
        if (state.userMatch) return { action: "drop", reason: "Kişi maça geri yazıldı" };
        if (isMatchStarted(n.match.tarih, n.match.saat, now)) return { action: "drop", reason: "Maç başladı" };
        return { action: "send", notification: n };
    }

    if (row.kind === "UPDATED") {
        if (!state.userMatch) return { action: "drop", reason: "Kişi artık maçta değil" };
        if (isMatchStarted(state.userMatch.tarih, state.userMatch.saat, now)) return { action: "drop", reason: "Maç başladı" };
        // Fark tabandan (ilk kayıttaki eski hâl) güncel satıra yeniden hesaplanır —
        // arada geri alınan düzenlemeler bildirime girmez.
        const changeLines = diffMatch(n.oldMatch ?? null, state.userMatch);
        if (changeLines.length === 0) return { action: "drop", reason: "Net değişiklik kalmadı" };
        return { action: "send", notification: { ...n, match: state.userMatch, changeLines } };
    }

    // CHANGED
    if (state.userMatch) {
        if (isMatchStarted(state.userMatch.tarih, state.userMatch.saat, now)) return { action: "drop", reason: "Maç başladı" };
        if (state.userInOldMatch) return { action: "drop", reason: "Kişi eski maçta da duruyor" };
        return { action: "send", notification: { ...n, match: state.userMatch } };
    }
    // Yeni maçta değil: eski maçtan çıkarılma hâlâ geçerliyse düz iptal olarak gönder.
    if (!state.userInOldMatch && n.oldMatch && !isMatchStarted(n.oldMatch.tarih, n.oldMatch.saat, now)) {
        return {
            action: "send",
            notification: { kind: "CANCELLED", userId: n.userId, contentKey: n.oldContentKey ?? null, match: n.oldMatch },
        };
    }
    return { action: "drop", reason: "Kişi yeni maçta değil" };
}

// Kişinin verilen contentKey'e ait aktif bir satırda ataması varsa o satırın MatchData'sı.
async function findUserMatch(userId: number, contentKey: string | null): Promise<MatchData | null> {
    if (!contentKey) return null;
    const row = await db.parsedMatch.findFirst({
        where: { contentKey, cancelledAt: null, userAssignments: { some: { userId } } },
        orderBy: { id: "desc" },
        select: MATCH_DATA_SELECT,
    });
    return row ? parsedRowToMatchData(row) : null;
}

// Süresi dolan kayıtları teyit edip gönderir. Her bot turunun sonunda çağrılır
// (dosya değişmese bile) — böylece bekleyen bildirim en geç süre + ~1 dk içinde gider.
export async function flushDueNotifications(now: Date = new Date()): Promise<void> {
    if (DRY_RUN) return; // kuru çalıştırmada kuyruğa dokunulmaz
    const due = await db.matchNotificationOutbox.findMany({
        where: { status: "PENDING", dueAt: { lte: now } },
        orderBy: { id: "asc" },
        take: 500,
        select: { id: true, userId: true, kind: true, contentKey: true, oldContentKey: true, payload: true },
    });
    if (due.length === 0) return;

    const toSend: PlannedNotification[] = [];
    const sentIds: number[] = [];
    const drops = new Map<string, number[]>();

    for (const r of due) {
        try {
            const payload = r.payload as unknown as PlannedNotification;
            const userMatch = await findUserMatch(r.userId, r.contentKey);
            const userInOldMatch = r.kind === "CHANGED" ? !!(await findUserMatch(r.userId, r.oldContentKey)) : false;
            const res = resolvePending({ kind: r.kind as QueuedKind, payload }, { userMatch, userInOldMatch }, now);
            if (res.action === "send") {
                toSend.push(res.notification);
                sentIds.push(r.id);
            } else {
                const list = drops.get(res.reason) ?? [];
                list.push(r.id);
                drops.set(res.reason, list);
            }
        } catch (err: any) {
            // Tek kaydın hatası diğerlerini durdurmaz; kayıt PENDING kalır, sonraki turda tekrar denenir.
            logger.error("Bildirim teyidi başarısız", { outboxId: r.id, error: err?.message });
        }
    }

    // Önce SENT işaretlenir, sonra gönderilir: gönderim yarıda kalırsa aynı bildirim bir
    // sonraki turda İKİNCİ kez gitmesin (kaybolan tek bildirim, çift bildirimden iyidir).
    if (sentIds.length > 0) {
        await db.matchNotificationOutbox.updateMany({
            where: { id: { in: sentIds } },
            data: { status: "SENT", sentAt: new Date() },
        });
    }
    for (const [reason, ids] of drops) await dropPending(ids, reason);

    if (toSend.length > 0) await deliverNotifications(toSend);

    const count = (k: string) => toSend.filter(n => n.kind === k).length;
    logger.info("Teyit kuyruğu işlendi", {
        gonderilen: toSend.length,
        iptal: count("CANCELLED"),
        guncellendi: count("UPDATED"),
        degisti: count("CHANGED"),
        dusen: Object.fromEntries([...drops].map(([k, v]) => [k, v.length])),
    });
}

// Bildirimleri gönderir. İptallerde aynı maçtan çıkan kişiler tek push + tek
// "Maç İadesi" duyurusunda toplanır (metin herkes için aynı). Duyuru da iptal
// TEYİT EDİLDİKTEN sonra yazılır — sahte iptal duyurusu kalmaz.
export async function deliverNotifications(notifications: PlannedNotification[]): Promise<void> {
    const cancelGroups = new Map<string, { n: PlannedNotification; userIds: number[] }>();
    for (const n of notifications) {
        if (n.kind !== "CANCELLED") continue;
        const key = n.contentKey ?? `${n.match.mac_adi}|${n.match.tarih}`;
        const g = cancelGroups.get(key) ?? { n, userIds: [] };
        g.userIds.push(n.userId);
        cancelGroups.set(key, g);
    }

    if (cancelGroups.size > 0) {
        try {
            await createCancellationAnnouncements(
                [...cancelGroups.values()].map(g => ({
                    matchId: 0, matchKey: "", contentKey: g.n.contentKey,
                    macAdi: g.n.match.mac_adi, tarih: g.n.match.tarih, affectedUserIds: g.userIds,
                }))
            );
        } catch (err: any) {
            // Duyuru yazılamasa da push gitsin.
            logger.error("İptal duyurusu yazılamadı", { error: err?.message });
        }
        for (const g of cancelGroups.values()) {
            try {
                await sendMatchPush(g.userIds, "CANCELLED", notificationText(g.n));
            } catch (err: any) {
                logger.error("İptal bildirimi gönderilemedi", { macAdi: g.n.match.mac_adi, error: err?.message });
            }
        }
    }

    for (const n of notifications) {
        if (n.kind === "CANCELLED") continue;
        try {
            const extra = n.kind === "CHANGED"
                ? { oldMatchName: n.oldMatch?.mac_adi ?? "", newMatchName: n.match.mac_adi }
                : undefined;
            await sendMatchPush([n.userId], n.kind, notificationText(n), extra);
        } catch (err: any) {
            logger.error("Bildirim gönderilemedi", { kind: n.kind, userId: n.userId, error: err?.message });
        }
    }
}

// Bir sync turunun olaylarını planlar: Atama anında gönderilir, gerisi teyit kuyruğuna
// yazılır. Bekleyen iptaller bu turun yeni atamalarıyla eşleşirse düşer / dönüşür.
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

    // Bekleyen iptaller sadece bu turda yeni ataması olan kişiler için anlamlı.
    const pending = await loadPendingCancels([...new Set(newAssignments.map(a => a.userId))]);
    const { notifications, consumedPendingIds } = planWithPending({ newAssignments, cancellations, shifted }, pending);

    if (DRY_RUN) {
        logger.info("NOTIFY_DRY_RUN — bildirimler GÖNDERİLMEDİ, kuyruğa YAZILMADI", {
            planlanan: notifications.map(n => ({ kind: n.kind, userId: n.userId })),
            dusecekBekleyenIptal: consumedPendingIds.length,
        });
        return;
    }

    await dropPending(consumedPendingIds, "Aynı turda yeniden atandı (birleşti / geri geldi)");
    const queuedCount = await enqueueNotifications(notifications);
    const immediate = notifications.filter(n => n.kind === "ASSIGNED");
    if (immediate.length > 0) await deliverNotifications(immediate);

    const count = (k: NotificationKind) => notifications.filter(n => n.kind === k).length;
    logger.info("Bildirimler planlandı", {
        yeniAtamaGonderildi: immediate.length,
        kuyrugaYazildi: queuedCount,
        iptal: count("CANCELLED"),
        guncellendi: count("UPDATED"),
        degisti: count("CHANGED"),
        dusenBekleyenIptal: consumedPendingIds.length,
    });
}
