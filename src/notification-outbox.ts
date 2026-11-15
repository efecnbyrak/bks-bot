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
import { FallbackItem, recordFallbacks } from "./lib/notification-fallback";
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

// ASSIGNED kuyruğa sadece gönderimi geçici hatayla düşerse (yeniden deneme) yazılır.
type QueuedKind = "ASSIGNED" | "CANCELLED" | "UPDATED" | "CHANGED";

// Yeniden deneme (2026-11-15): FCM geçici hatasında (ağ, FCM 5xx, kota) bildirim
// kaybolmasın. Deneme sayısı payload'da `_attempt` olarak tutulur (şema değişmez).
// 1., 2., ... denemeden sonra bekleme (dk); dizi bitince FAILED.
export const RETRY_DELAYS_MIN = [1, 2, 5, 15, 30];

type StoredPayload = PlannedNotification & { _attempt?: number };

// Saf: başarısız gönderimden sonra satırın yeni hâli. attempt = şimdiye kadar yapılan deneme sayısı.
export function nextRetry(attempt: number, now: Date): { status: "PENDING"; dueAt: Date } | { status: "FAILED" } {
    if (attempt > RETRY_DELAYS_MIN.length) return { status: "FAILED" };
    return { status: "PENDING", dueAt: new Date(now.getTime() + RETRY_DELAYS_MIN[attempt - 1] * 60_000) };
}

// Planlanan bildirim → e-posta yedeği kaydı (push ulaşmadığında; lib/notification-fallback.ts).
export function toFallbackItem(n: PlannedNotification): FallbackItem {
    const { title, body } = notificationText(n);
    return { userId: n.userId, kind: n.kind, title, body, matchKey: n.contentKey ?? `${n.match.mac_adi}|${n.match.tarih}` };
}

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

    // Atama yeniden denemesi: kişi hâlâ maçtaysa ve maç başlamadıysa güncel hâliyle gönder.
    if (row.kind === "ASSIGNED") {
        if (!state.userMatch) return { action: "drop", reason: "Kişi artık maçta değil" };
        if (isMatchStarted(state.userMatch.tarih, state.userMatch.saat, now)) return { action: "drop", reason: "Maç başladı" };
        return { action: "send", notification: { ...n, match: state.userMatch } };
    }

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
    // Gönderilen bildirim → outbox satırı (yeniden deneme için).
    const rowOf = new Map<PlannedNotification, { id: number; attempt: number; payload: StoredPayload }>();
    const drops = new Map<string, number[]>();

    for (const r of due) {
        try {
            const payload = r.payload as unknown as StoredPayload;
            const userMatch = await findUserMatch(r.userId, r.contentKey);
            const userInOldMatch = r.kind === "CHANGED" ? !!(await findUserMatch(r.userId, r.oldContentKey)) : false;
            const res = resolvePending({ kind: r.kind as QueuedKind, payload }, { userMatch, userInOldMatch }, now);
            if (res.action === "send") {
                toSend.push(res.notification);
                sentIds.push(r.id);
                rowOf.set(res.notification, { id: r.id, attempt: (payload._attempt ?? 0) + 1, payload });
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

    // Önce SENT işaretlenir, sonra gönderilir: süreç gönderim ortasında ölürse aynı bildirim
    // bir sonraki turda İKİNCİ kez gitmesin. FCM'in geçici hata DÖNDÜĞÜ kişiler ise aşağıda
    // tekrar PENDING'e alınır (2026-11-15) — sessiz kayıp yok.
    if (sentIds.length > 0) {
        await db.matchNotificationOutbox.updateMany({
            where: { id: { in: sentIds } },
            data: { status: "SENT", sentAt: new Date() },
        });
    }
    for (const [reason, ids] of drops) await dropPending(ids, reason);

    const failed = toSend.length > 0 ? await deliverNotifications(toSend) : [];
    let retried = 0;
    let gaveUp = 0;
    const gaveUpNotifications: PlannedNotification[] = [];
    for (const n of failed) {
        const row = rowOf.get(n);
        if (!row) continue;
        const next = nextRetry(row.attempt, new Date());
        if (next.status === "FAILED") {
            gaveUp++;
            gaveUpNotifications.push(n);
            await db.matchNotificationOutbox.update({
                where: { id: row.id },
                data: { status: "FAILED", dropReason: `FCM ${row.attempt} denemede ulaştıramadı` },
            });
        } else {
            retried++;
            await db.matchNotificationOutbox.update({
                where: { id: row.id },
                data: { status: "PENDING", dueAt: next.dueAt, sentAt: null, payload: toPayload({ ...row.payload, _attempt: row.attempt } as PlannedNotification) },
            });
        }
    }

    // Yeniden denemeler tükendi → push artık gitmeyecek; e-posta yedeği yazılır.
    await recordFallbacks(gaveUpNotifications.map(toFallbackItem));

    const count = (k: string) => toSend.filter(n => n.kind === k).length;
    logger.info("Teyit kuyruğu işlendi", {
        gonderilen: toSend.length,
        iptal: count("CANCELLED"),
        guncellendi: count("UPDATED"),
        degisti: count("CHANGED"),
        atamaTekrar: count("ASSIGNED"),
        yenidenDenenecek: retried,
        vazgecildi: gaveUp,
        dusen: Object.fromEntries([...drops].map(([k, v]) => [k, v.length])),
    });
}

// Bildirimleri gönderir. İptallerde aynı maçtan çıkan kişiler tek push + tek
// "Maç İadesi" duyurusunda toplanır (metin herkes için aynı). Duyuru da iptal
// TEYİT EDİLDİKTEN sonra yazılır — sahte iptal duyurusu kalmaz.
// Dönüş: FCM geçici hatasıyla HİÇBİR cihazına ulaşılamayan bildirimler (çağıran yeniden dener).
// Push'un KESİN ulaşmadığı kişiler (token yok / kalıcı hata / izin kapalı) için e-posta
// yedeği burada yazılır (2026-11-15) — geçici hatalılar ise yeniden denemeler tükenince
// flushDueNotifications'ta yazılır.
export async function deliverNotifications(notifications: PlannedNotification[]): Promise<PlannedNotification[]> {
    const failed: PlannedNotification[] = [];
    const undelivered: PlannedNotification[] = [];
    const cancelGroups = new Map<string, { n: PlannedNotification; userIds: number[]; members: PlannedNotification[] }>();
    for (const n of notifications) {
        if (n.kind !== "CANCELLED") continue;
        const key = n.contentKey ?? `${n.match.mac_adi}|${n.match.tarih}`;
        const g = cancelGroups.get(key) ?? { n, userIds: [], members: [] };
        g.userIds.push(n.userId);
        g.members.push(n);
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
                const res = await sendMatchPush(g.userIds, "CANCELLED", notificationText(g.n));
                const bad = new Set(res.transientFailedUserIds);
                failed.push(...g.members.filter(m => bad.has(m.userId)));
                const lost = new Set(res.undeliveredUserIds);
                undelivered.push(...g.members.filter(m => lost.has(m.userId)));
            } catch (err: any) {
                logger.error("İptal bildirimi gönderilemedi", { macAdi: g.n.match.mac_adi, error: err?.message });
                failed.push(...g.members);
            }
        }
    }

    for (const n of notifications) {
        if (n.kind === "CANCELLED") continue;
        try {
            const extra = n.kind === "CHANGED"
                ? { oldMatchName: n.oldMatch?.mac_adi ?? "", newMatchName: n.match.mac_adi }
                : undefined;
            const res = await sendMatchPush([n.userId], n.kind, notificationText(n), extra);
            if (res.transientFailedUserIds.length > 0) failed.push(n);
            if (res.undeliveredUserIds.includes(n.userId)) undelivered.push(n);
        } catch (err: any) {
            logger.error("Bildirim gönderilemedi", { kind: n.kind, userId: n.userId, error: err?.message });
            failed.push(n);
        }
    }
    await recordFallbacks(undelivered.map(toFallbackItem));
    return failed;
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
    const failedImmediate = immediate.length > 0 ? await deliverNotifications(immediate) : [];
    if (failedImmediate.length > 0) {
        // Atama anında gider; FCM geçici hata verdiyse kaybolmasın — kuyruktan yeniden denenir
        // (gönderim anında kişinin hâlâ maçta olduğu yeniden kontrol edilir).
        const first = nextRetry(1, new Date());
        const dueAt = first.status === "PENDING" ? first.dueAt : new Date();
        await db.matchNotificationOutbox.createMany({
            data: failedImmediate.map(n => ({
                userId: n.userId,
                kind: "ASSIGNED",
                contentKey: n.contentKey,
                oldContentKey: null,
                payload: toPayload({ ...n, _attempt: 1 } as PlannedNotification),
                dueAt,
            })),
        });
    }

    const count = (k: NotificationKind) => notifications.filter(n => n.kind === k).length;
    logger.info("Bildirimler planlandı", {
        yeniAtamaGonderildi: immediate.length - failedImmediate.length,
        yeniAtamaTekrarKuyrugu: failedImmediate.length,
        kuyrugaYazildi: queuedCount,
        iptal: count("CANCELLED"),
        guncellendi: count("UPDATED"),
        degisti: count("CHANGED"),
        dusenBekleyenIptal: consumedPendingIds.length,
    });
}
