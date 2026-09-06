import { getApps, initializeApp, cert, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { db } from "../db";
import { logger } from "../logger";

// FCM'in "bu token bir daha asla çalışmayacak" dediği hata kodları — bunlarla dönen
// token'lar tabloda tutulmaya devam ederse zamanla push_tokens şişer, boşa istek gider.
const DEAD_TOKEN_ERROR_CODES = new Set([
    "messaging/registration-token-not-registered",
    "messaging/invalid-registration-token",
    "messaging/invalid-argument",
]);

const CHUNK_SIZE = 500; // FCM sendEachForMulticast tek istekte en fazla 500 token kabul ediyor

// Firebase Admin SDK'yı tek sefer başlatır (aynı süreç içinde tekrar tekrar init edilmesin diye getApps() kontrolü var).
function getFirebaseApp(): App | null {
    if (getApps().length > 0) return getApps()[0];

    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_BASE64;
    if (!serviceAccountBase64) {
        logger.error("FIREBASE_SERVICE_ACCOUNT_KEY_BASE64 ortam değişkeni tanımlı değil.");
        return null;
    }

    try {
        const serviceAccountJson = Buffer.from(serviceAccountBase64, "base64").toString("utf8");
        const serviceAccount = JSON.parse(serviceAccountJson);
        return initializeApp({ credential: cert(serviceAccount) });
    } catch (err) {
        logger.error("Firebase Admin SDK başlatılamadı", { error: (err as Error)?.message });
        return null;
    }
}

async function sendPushToUsers(
    userIds: number[],
    title: string,
    body: string,
    dataType: string,
    logLabel: string,
    extraData?: Record<string, string>
): Promise<void> {
    if (userIds.length === 0) return;

    const app = getFirebaseApp();
    if (!app) return;

    const tokenRows = await db.pushToken.findMany({
        where: { userId: { in: userIds } },
        select: { token: true },
    });

    const tokens = tokenRows
        .map((r: { token: string }) => r.token)
        .filter((t: string) => typeof t === "string" && t.length > 0);

    if (tokens.length === 0) {
        logger.info(`${logLabel}: push token bulunamadı`, { userIds });
        return;
    }

    for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
        const chunk = tokens.slice(i, i + CHUNK_SIZE);

        try {
            const response = await getMessaging(app).sendEachForMulticast({
                tokens: chunk,
                notification: { title, body },
                // screen: mobil taraf type'a bakmadan tek bir kuralla ("screen" alanına göre)
                // yönlendirme yapabilsin diye üç bildirim tipine de eklenen ortak alan.
                data: { type: dataType, screen: "MATCHES", ...extraData },
                android: {
                    notification: {
                        sound: "default",
                        channelId: "matches",
                    },
                },
                apns: {
                    payload: {
                        aps: { sound: "default" },
                    },
                },
            });

            if (response.failureCount > 0) {
                const deadTokens: string[] = [];
                response.responses.forEach((r, idx) => {
                    if (r.success) return;
                    if (r.error?.code && DEAD_TOKEN_ERROR_CODES.has(r.error.code)) {
                        deadTokens.push(chunk[idx]);
                    }
                });
                logger.error("FCM gönderim hataları", { failureCount: response.failureCount });

                if (deadTokens.length > 0) {
                    await db.pushToken
                        .deleteMany({ where: { token: { in: deadTokens } } })
                        .catch((err: Error) => logger.error("Ölü token temizliği başarısız", { error: err.message }));
                }
            }
        } catch (err: any) {
            logger.error("Push gönderme hatası", { error: err?.message });
        }
    }

    logger.info(`${logLabel} gönderildi`, {
        userCount: userIds.length,
        tokenCount: tokens.length,
    });
}

export async function sendCancellationPush(
    userIds: number[],
    matchName: string,
    matchDate: string
): Promise<void> {
    const body = `${matchName} (${matchDate}) maçınız iptal edildi.`;
    await sendPushToUsers(userIds, "Maç İptal Edildi", body, "MATCH_CANCELLED", "İptal bildirimi");
}

export async function sendAssignmentPush(
    userId: number,
    matchName: string,
    matchDate: string
): Promise<void> {
    const body = `${matchName} (${matchDate}) maçına atandınız.`;
    await sendPushToUsers([userId], "Yeni Maça Atandınız", body, "MATCH_ASSIGNED", "Atama bildirimi");
}

export async function sendMatchChangedPush(
    userId: number,
    oldMatchName: string,
    oldMatchDate: string,
    newMatchName: string,
    newMatchDate: string
): Promise<void> {
    const body = `${oldMatchName} (${oldMatchDate}) yerine ${newMatchName} (${newMatchDate}) maçına atandınız.`;
    await sendPushToUsers(
        [userId],
        "Maçınız Değişti",
        body,
        "MATCH_CHANGED",
        "Değişiklik bildirimi",
        { oldMatchName, newMatchName }
    );
}

// FAZ 3 — Kullanıcı maçta KALDI ama kadro/görevli listesi değişti (federasyon kademeli
// doldurdu ya da bir görevliyi değiştirdi). "Yeni maça atandınız" YANLIŞ olurdu — bunun
// yerine kısa bir "güncellendi" bildirimi. screen/channel diğer maç bildirimleriyle aynı,
// mobil tarafta ek bir yönlendirme kuralı gerekmez.
export async function sendMatchUpdatedPush(
    userId: number,
    matchName: string,
    matchDate: string,
    changeSummary: string
): Promise<void> {
    const body = `${matchName} (${matchDate}) — ${changeSummary}`;
    await sendPushToUsers(
        [userId],
        "Maçınız Güncellendi",
        body,
        "MATCH_UPDATED",
        "Güncelleme bildirimi"
    );
}
