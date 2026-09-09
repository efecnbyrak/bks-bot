import { resolveSyncFolderKeys } from "./config";
import { runSync, RunSyncResult } from "./orchestrator";
import { reconcileAndNotify } from "./change-notifier";
import { isFirstEverSync, CancelledMatchInfo, ShiftedAssignmentInfo } from "./db-writer";
import { consolidateActiveContentKeyDuplicates } from "./lib/contentkey-consolidator";
import { NewAssignmentInfo } from "./user-matcher";
import { logger } from "./logger";
import { db } from "./db";

async function main() {
    const folderKeys = await resolveSyncFolderKeys();

    logger.info("bks-bot başlıyor", {
        folderKeys,
        syncMode: process.env.SYNC_MODE ?? "normal",
        nodeVersion: process.version,
    });

    try {
        // İlk kurulum koruması: DB boşken tüm atamalar "yeni" sayılıp binlerce
        // yanlış bildirim gitmesin diye, bu run başlamadan önce TEK SEFER kontrol edilir.
        const isInitial = await isFirstEverSync();

        const allNewAssignments: NewAssignmentInfo[] = [];
        const allCancellations: CancelledMatchInfo[] = [];
        const allShifted: ShiftedAssignmentInfo[] = [];

        // Birden fazla klasör anahtarı (virgülle ayrılmış) verildiyse hepsini sırayla senkronize et —
        // federasyon "current" dışında arşiv klasörüne de güncel maç ekleyebiliyor, ikisi de otomatik taranmalı
        for (const folderKey of folderKeys) {
            const result: RunSyncResult = await runSync(folderKey);
            allNewAssignments.push(...result.newAssignments);
            allCancellations.push(...result.cancellations);
            allShifted.push(...result.shifted);
        }

        // Tüm klasörler işlendikten SONRA tek bir uzlaştırma adımı: kullanıcı bazında
        // "güncellendi / değişti / iptal / yeni atama" ayrımı yapılıp doğru bildirim gönderilir.
        await reconcileAndNotify(allNewAssignments, allCancellations, isInitial, allShifted);

        // B6: Donmuş dosyalarda birikmiş aktif-aktif contentKey ikizlerini birleştir.
        // detectAndMarkCancelledMatches (db-writer.ts) yalnızca DEĞİŞEN dosyalarda çalışıyor
        // (orchestrator.ts toProcess döngüsü) — hiç değişmeyen bir dosyanın kademeli-doldurma
        // ikizleri hiç birleşmiyor. Bu adım her sync sonunda tüm DB'yi tarayıp GÜVENLİ
        // birleştirmeyi yapar (atama kullanıcıda kalır, sadece bağlı olduğu satır değişir —
        // BİLDİRİM ÜRETMEZ). Belirsiz "gerçek çıkarılma" atamalarına DOKUNMAZ. İlk kurulumda
        // atlanır (tüm veri "yeni" sayılırken çalıştırmak anlamsız).
        if (!isInitial) {
            try {
                await consolidateActiveContentKeyDuplicates();
            } catch (consErr: any) {
                // Konsolidasyon hatası sync'i başarısız saymaz — bir sonraki turda tekrar denenir.
                logger.error("contentKey konsolidasyonu hatası (sync yine de tamamlandı)", { error: consErr?.message });
            }
        }
    } catch (err: any) {
        const errMsg: string = err?.message ?? "";
        const isDbConnError =
            err?.constructor?.name === "PrismaClientInitializationError" ||
            errMsg.includes("Can't reach database server") ||
            errMsg.includes("ECONNREFUSED") ||
            errMsg.includes("connection refused") ||
            errMsg.includes("Connection timed out");

        if (isDbConnError) {
            logger.warn("Veritabanına ulaşılamadı — işlem atlandı, job başarısız sayılmıyor", { error: errMsg });
            await db.$disconnect().catch(() => {});
            process.exit(0);
        }

        logger.error("Beklenmeyen hata — işlem sonlandırılıyor", { error: errMsg });
        process.exit(1);
    } finally {
        await db.$disconnect().catch(() => {});
    }

    logger.info("bks-bot tamamlandı");
}

main();
