import { getApps, initializeApp, cert, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { db } from "../db";
import { logger } from "../logger";

// SYNC: Bu dosyanın alt-seviye FCM gönderim mantığı (getFirebaseApp, DEAD_TOKEN_ERROR_CODES,
// chunk gönderim, dead-token temizleme) bks-web-system/lib/push-notifications.ts ile aynı
// mantığı ayrı ayrı implemente ediyor (iki ayrı repo/deploy, ortak paket çıkarmak fayda/
// maliyet dengesi kötü olduğu için bilinçli yapılmadı). Burada bir düzeltme yapılırsa
// karşı tarafa da elle taşınmalı.

// FCM'in "bu token bir daha asla çalışmayacak" dediği hata kodları — bunlarla dönen
// token'lar tabloda tutulmaya devam ederse zamanla push_tokens şişer, boşa istek gider.
// "messaging/invalid-argument" BİLİNÇLİ OLARAK listede YOK (2026-10-31): FCM bu kodu
// mesajın kendisi hatalıyken de (ör. payload fazla büyük) döndürüyor — o durumda o
// gönderimdeki SAĞLAM token'lar da silinip kullanıcı sessizce bildirimsiz kalıyordu.
const DEAD_TOKEN_ERROR_CODES = new Set([
    "messaging/registration-token-not-registered",
    "messaging/invalid-registration-token",
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

// Maç bildirimi mesajı — HER cihaza klasik biçim (`notification` bloklu, sistem gösterir).
// 2026-10-31'de 1.0.12+ Android'e sadece veri taşıyan (data-only) mesaj gönderilmeye
// başlanmıştı (uygulama büyütülebilir çizsin diye); 2026-11-05'te kaldırıldı: uygulama
// kaydırılıp kapatılmışsa veya üretici pil kısıtlaması varsa data-only mesaj uygulamaya
// ulaşmıyor, bildirim sessizce kayboluyordu (Uygunluk bildirimleri klasik olduğu için
// geliyor, maç bildirimleri gelmiyordu). `data` başlık ve metni TAŞIR: mobil (1.0.13+)
// bildirime dokunulunca detay sayfasını buradan doldurur. Anlık teslim: web
// lib/push-notifications.ts ile aynı — Android "high", iOS apns-priority 10 + alert.
export function buildPushMessage(title: string, body: string, data: Record<string, string>) {
    const fullData: Record<string, string> = { ...data, title, body, channel: "matches" };
    return {
        notification: { title, body },
        data: fullData,
        android: {
            priority: "high" as const,
            notification: { sound: "default", channelId: "matches" },
        },
        apns: {
            headers: { "apns-priority": "10", "apns-push-type": "alert" },
            payload: { aps: { sound: "default" } },
        },
    };
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

    const valid = tokenRows
        .map((r: { token: string }) => r.token)
        .filter((t: string) => typeof t === "string" && t.length > 0);
    if (valid.length === 0) {
        logger.info(`${logLabel}: push token bulunamadı`, { userIds });
        return;
    }

    // screen: mobil taraf type'a bakmadan tek bir kuralla ("screen" alanına göre)
    // yönlendirme yapabilsin diye tüm maç bildirimlerine eklenen ortak alan.
    const data = { type: dataType, screen: "MATCHES", ...extraData };

    const message = buildPushMessage(title, body, data);

    for (let i = 0; i < valid.length; i += CHUNK_SIZE) {
        const chunk = valid.slice(i, i + CHUNK_SIZE);
        try {
            const response = await getMessaging(app).sendEachForMulticast({ tokens: chunk, ...message });

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
        tokenCount: valid.length,
    });
}

// Maç bildirimi türü → mobilin okuduğu `type` alanı. screen/channel dört türde de aynı
// ("MATCHES" / "matches"), mobilde ek bir yönlendirme kuralı gerekmez.
const MATCH_PUSH_TYPES = {
    ASSIGNED: { dataType: "MATCH_ASSIGNED", logLabel: "Atama bildirimi" },
    CHANGED: { dataType: "MATCH_CHANGED", logLabel: "Değişiklik bildirimi" },
    CANCELLED: { dataType: "MATCH_CANCELLED", logLabel: "İptal bildirimi" },
    UPDATED: { dataType: "MATCH_UPDATED", logLabel: "Güncelleme bildirimi" },
} as const;

export type MatchPushKind = keyof typeof MATCH_PUSH_TYPES;

// Başlık ve metin src/lib/notification-text.ts'te üretilir; burası sadece gönderir.
export async function sendMatchPush(
    userIds: number[],
    kind: MatchPushKind,
    text: { title: string; body: string },
    extraData?: Record<string, string>
): Promise<void> {
    const { dataType, logLabel } = MATCH_PUSH_TYPES[kind];
    await sendPushToUsers(userIds, text.title, text.body, dataType, logLabel, extraData);
}
