import { resolveSyncFolderKeys } from "./config";
import { runSync } from "./orchestrator";
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
        // Birden fazla klasör anahtarı (virgülle ayrılmış) verildiyse hepsini sırayla senkronize et —
        // federasyon "current" dışında arşiv klasörüne de güncel maç ekleyebiliyor, ikisi de otomatik taranmalı
        for (const folderKey of folderKeys) {
            await runSync(folderKey);
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
