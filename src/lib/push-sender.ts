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

// Büyütülebilir bildirimi uygulamanın KENDİSİ çizebilen ilk mobil sürüm (2026-10-31).
// Firebase'in Android'de kendi çizdiği klasik bildirim uzun metni büyütmüyor (tek satır
// kalıyor); 1.0.12+ Android'e `notification` bloğu OLMAYAN, sadece veri taşıyan mesaj
// gönderilir ve uygulama onu Telegram gibi büyütülebilir gösterir
// (bks-mobile-flutter push_notification_service.dart → showDataOnlyNotification).
// Eski sürümler bu mesajı GÖSTEREMEZ — o yüzden onlara klasik biçim gider.
export const DATA_ONLY_MIN_VERSION = [1, 0, 12];

export function supportsDataOnly(platform: string | null | undefined, appVersion: string | null | undefined): boolean {
    if (platform !== "android" || !appVersion) return false;
    const parts = appVersion.split(".").map(n => Number(n));
    if (parts.length !== 3 || parts.some(n => !Number.isInteger(n))) return false;
    for (let i = 0; i < 3; i++) {
        if (parts[i] !== DATA_ONLY_MIN_VERSION[i]) return parts[i] > DATA_ONLY_MIN_VERSION[i];
    }
    return true;
}

// İki mesaj biçimi. İkisinin de `data`'sı başlık ve metni TAŞIR: mobil (1.0.13+)
// bildirime dokunulunca uygulama içinde detay sayfası açar ve tüm bilgiyi buradan
// okur — klasik biçimde de (iOS, eski Android) sayfa boş kalmasın.
export function buildPushMessages(title: string, body: string, data: Record<string, string>) {
    const fullData: Record<string, string> = { ...data, title, body, channel: "matches" };
    // Klasik biçim (eski sürümler, iOS): bildirimi sistem gösterir.
    // Anlık teslim: web lib/push-notifications.ts ile aynı — Android "high"
    // öncelik (Doze'da beklemesin), iOS apns-priority 10 + alert.
    const classic = {
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
    // Sadece veri (1.0.12+ Android): uygulama kendisi çizer.
    // "high" öncelik şart — yoksa uygulama kapalıyken mesaj Doze'da bekletilir.
    const dataOnly = {
        data: fullData,
        android: { priority: "high" as const },
    };
    return { classic, dataOnly };
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
        select: { token: true, platform: true, appVersion: true },
    });

    type TokenRow = { token: string; platform: string; appVersion: string | null };
    const valid = tokenRows.filter((r: TokenRow) => typeof r.token === "string" && r.token.length > 0);
    if (valid.length === 0) {
        logger.info(`${logLabel}: push token bulunamadı`, { userIds });
        return;
    }

    // screen: mobil taraf type'a bakmadan tek bir kuralla ("screen" alanına göre)
    // yönlendirme yapabilsin diye tüm maç bildirimlerine eklenen ortak alan.
    const data = { type: dataType, screen: "MATCHES", ...extraData };

    const { classic, dataOnly } = buildPushMessages(title, body, data);

    const groups = [
        { message: dataOnly, tokens: valid.filter((r: TokenRow) => supportsDataOnly(r.platform, r.appVersion)).map((r: TokenRow) => r.token) },
        { message: classic, tokens: valid.filter((r: TokenRow) => !supportsDataOnly(r.platform, r.appVersion)).map((r: TokenRow) => r.token) },
    ];

    for (const group of groups) {
        for (let i = 0; i < group.tokens.length; i += CHUNK_SIZE) {
            const chunk = group.tokens.slice(i, i + CHUNK_SIZE);
            try {
                const response = await getMessaging(app).sendEachForMulticast({ tokens: chunk, ...group.message });

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
    }

    logger.info(`${logLabel} gönderildi`, {
        userCount: userIds.length,
        tokenCount: valid.length,
        buyutulebilir: groups[0].tokens.length,
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
