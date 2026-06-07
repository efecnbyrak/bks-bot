import { getSyncFolderKey } from "./config";
import { runSync } from "./orchestrator";
import { logger } from "./logger";
import { db } from "./db";

async function main() {
    const folderKey = getSyncFolderKey();

    logger.info("bks-bot başlıyor", {
        folderKey,
        syncMode: process.env.SYNC_MODE ?? "normal",
        nodeVersion: process.version,
    });

    try {
        await runSync(folderKey);
    } catch (err: any) {
        logger.error("Beklenmeyen hata — işlem sonlandırılıyor", { error: err?.message });
        process.exit(1);
    } finally {
        await db.$disconnect();
    }

    logger.info("bks-bot tamamlandı");
}

main();
