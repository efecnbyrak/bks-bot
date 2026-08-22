import { NewAssignmentInfo } from "./user-matcher";
import { CancelledMatchInfo, createCancellationAnnouncements } from "./db-writer";
import { sendAssignmentPush, sendCancellationPush, sendMatchChangedPush } from "./lib/push-sender";
import { logger } from "./logger";

/**
 * Bir sync koşusunda (current + arşiv, tüm klasörler işlendikten sonra) toplanan
 * "yeni atama" ve "iptal" olaylarını kullanıcı bazında karşılaştırıp doğru bildirim
 * tipini gönderir:
 *   - Aynı userId hem iptal hem yeni atama listesinde varsa → "maçınız değişti"
 *   - Sadece iptal listesindeyse → "maçınız iptal edildi"
 *   - Sadece yeni atama listesindeyse → "maça atandınız"
 *
 * Dosya bazlı değil, run bazlı çalışması kasıtlı: current dosyasından çıkarılıp
 * arşiv dosyasına eklenen bir kullanıcı, current işlenirken henüz arşivdeki yeni
 * atamayı görmüyor olabilir — karar tüm dosyalar işlendikten sonra verilmeli.
 */
export async function reconcileAndNotify(
    newAssignments: NewAssignmentInfo[],
    cancellations: CancelledMatchInfo[],
    isInitialBootstrap: boolean
): Promise<void> {
    if (isInitialBootstrap) {
        logger.info("İlk kurulum — bildirim gönderimi atlandı", {
            newAssignmentCount: newAssignments.length,
            cancellationCount: cancellations.reduce((sum, c) => sum + c.affectedUserIds.length, 0),
        });
        return;
    }

    if (newAssignments.length === 0 && cancellations.length === 0) return;

    // userId → o kullanıcı için ilk yeni atama (birden fazla varsa ilkini alırız,
    // aynı sync'te bir kullanıcının birden fazla yeni maça atanması nadir bir edge-case)
    const newAssignmentByUser = new Map<number, NewAssignmentInfo>();
    for (const a of newAssignments) {
        if (!newAssignmentByUser.has(a.userId)) newAssignmentByUser.set(a.userId, a);
    }

    // userId → iptal edilen (userId, matchId) çiftleri (düzleştirilmiş liste)
    interface FlatCancellation { userId: number; macAdi: string; tarih: string }
    const flatCancellations: FlatCancellation[] = [];
    for (const c of cancellations) {
        for (const userId of c.affectedUserIds) {
            flatCancellations.push({ userId, macAdi: c.macAdi, tarih: c.tarih });
        }
    }

    const consumedUserIds = new Set<number>();
    const realCancellationsByMatch = new Map<string, { macAdi: string; tarih: string; userIds: number[] }>();

    for (const fc of flatCancellations) {
        const newAssignment = newAssignmentByUser.get(fc.userId);

        if (newAssignment) {
            // Aynı kullanıcı hem bir maçtan çıkarılmış hem yeni bir maça atanmış → değişti
            consumedUserIds.add(fc.userId);
            try {
                await sendMatchChangedPush(fc.userId, fc.macAdi, fc.tarih, newAssignment.macAdi, newAssignment.tarih);
            } catch (err: any) {
                logger.error("Değişiklik bildirimi gönderilemedi", { userId: fc.userId, error: err?.message });
            }
        } else {
            // Gerçek iptal — aynı maç için birden fazla kullanıcı olabilir, gruplayalım
            const key = `${fc.macAdi}|${fc.tarih}`;
            if (!realCancellationsByMatch.has(key)) {
                realCancellationsByMatch.set(key, { macAdi: fc.macAdi, tarih: fc.tarih, userIds: [] });
            }
            realCancellationsByMatch.get(key)!.userIds.push(fc.userId);
        }
    }

    // Gerçek iptaller: duyuru + toplu push (mevcut davranış)
    const realCancellations = [...realCancellationsByMatch.values()];
    if (realCancellations.length > 0) {
        await createCancellationAnnouncements(
            realCancellations.map(c => ({
                matchId: 0, // announcement için kullanılmıyor, sadece push/duyuru içeriği lazım
                matchKey: "",
                macAdi: c.macAdi,
                tarih: c.tarih,
                affectedUserIds: c.userIds,
            }))
        );
        for (const c of realCancellations) {
            try {
                await sendCancellationPush(c.userIds, c.macAdi, c.tarih);
            } catch (err: any) {
                logger.error("İptal bildirimi gönderilemedi", { macAdi: c.macAdi, error: err?.message });
            }
        }
        logger.info("İptal bildirimleri gönderildi", {
            matchCount: realCancellations.length,
            affectedUsers: [...new Set(realCancellations.flatMap(c => c.userIds))].length,
        });
    }

    // Yeni atamalar: "değişti" olarak zaten tüketilmemiş olanlar gerçek yeni atamadır
    let sentAssignmentCount = 0;
    for (const [userId, a] of newAssignmentByUser) {
        if (consumedUserIds.has(userId)) continue;
        try {
            await sendAssignmentPush(userId, a.macAdi, a.tarih);
            sentAssignmentCount++;
        } catch (err: any) {
            logger.error("Atama bildirimi gönderilemedi", { userId, error: err?.message });
        }
    }
    if (sentAssignmentCount > 0) {
        logger.info("Yeni atama bildirimleri gönderildi", { count: sentAssignmentCount });
    }

    if (consumedUserIds.size > 0) {
        logger.info("Maç değişikliği bildirimleri gönderildi", { count: consumedUserIds.size });
    }
}
