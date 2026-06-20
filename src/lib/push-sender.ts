import { db } from "../db";
import { logger } from "../logger";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const CHUNK_SIZE = 100;

export async function sendCancellationPush(
    userIds: number[],
    matchName: string,
    matchDate: string
): Promise<void> {
    if (userIds.length === 0) return;

    const tokenRows = await db.pushToken.findMany({
        where: { userId: { in: userIds } },
        select: { token: true },
    });

    const tokens = tokenRows
        .map((r: { token: string }) => r.token)
        .filter((t: string) => typeof t === "string" && t.startsWith("ExponentPushToken["));

    if (tokens.length === 0) {
        logger.info("İade bildirimi: push token bulunamadı", { userIds });
        return;
    }

    const body = `${matchName} (${matchDate}) maçınız iptal edildi.`;

    for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
        const chunk = tokens.slice(i, i + CHUNK_SIZE);
        const messages = chunk.map((to: string) => ({
            to,
            sound: "default",
            title: "Maç İptal Edildi",
            body,
            data: { type: "MATCH_CANCELLED" },
            channelId: "matches",
        }));

        try {
            const res = await fetch(EXPO_PUSH_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify(messages),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                logger.error("Expo push API hatası", { status: res.status, text });
            }
        } catch (err: any) {
            logger.error("Push gönderme ağ hatası", { error: err?.message });
        }
    }

    logger.info("İade push bildirimleri gönderildi", {
        userCount: userIds.length,
        tokenCount: tokens.length,
        matchName,
    });
}
