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

// Geçici (tekrar denenince düzelebilecek) FCM hata kodları. Bu kodlarla düşen kişiye
// bildirim "gitmedi" sayılır ve teyit kuyruğundan yeniden denenir (2026-11-15). Kalıcı
// hatalar (ölü token, yanlış argüman, APNs kimlik hatası) tekrar denemekle düzelmez.
const TRANSIENT_ERROR_CODES = new Set([
    "messaging/unavailable",
    "messaging/internal-error",
    "messaging/server-unavailable",
    "messaging/message-rate-exceeded",
    "messaging/device-message-rate-exceeded",
    "messaging/quota-exceeded",
    "app/network-error",
    "app/network-timeout",
]);

export interface TokenResult {
    userId: number;
    success: boolean;
    code?: string;
}

// Saf: token sonuçlarından "hiçbir cihazına ulaşılamamış ve hata geçici" kişileri çıkarır.
// Kişinin bir cihazına bile ulaştıysa teslim edilmiş sayılır (aynı bildirim çift gitmesin).
export function classifyDelivery(results: TokenResult[]): { delivered: number[]; transientFailed: number[]; permanentFailed: number[] } {
    const byUser = new Map<number, TokenResult[]>();
    for (const r of results) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
    const delivered: number[] = [];
    const transientFailed: number[] = [];
    const permanentFailed: number[] = [];
    for (const [userId, rs] of byUser) {
        if (rs.some(r => r.success)) delivered.push(userId);
        else if (rs.some(r => !r.code || TRANSIENT_ERROR_CODES.has(r.code))) transientFailed.push(userId);
        else permanentFailed.push(userId);
    }
    return { delivered, transientFailed, permanentFailed };
}

export interface PushResult {
    // Hiçbir cihazına ulaşılamamış, geçici hatalı kişiler — çağıran tekrar dener.
    transientFailedUserIds: number[];
}

async function sendPushToUsers(
    userIds: number[],
    title: string,
    body: string,
    dataType: string,
    logLabel: string,
    extraData?: Record<string, string>
): Promise<PushResult> {
    if (userIds.length === 0) return { transientFailedUserIds: [] };

    const app = getFirebaseApp();
    // Firebase başlatılamadıysa HERKES geçici hatalı sayılır (sessizce "gönderildi" denmez).
    if (!app) return { transientFailedUserIds: [...userIds] };

    const tokenRows: { token: string; userId: number; platform: string }[] = await db.pushToken.findMany({
        where: { userId: { in: userIds } },
        select: { token: true, userId: true, platform: true },
    });

    const valid = tokenRows.filter(r => typeof r.token === "string" && r.token.length > 0);
    const withToken = new Set(valid.map(r => r.userId));
    const noToken = userIds.filter(id => !withToken.has(id));
    if (noToken.length > 0) {
        // Uygulaması yok / bildirim izni vermemiş / çıkış yapmış kişiler — bildirim ulaşamaz.
        logger.info(`${logLabel}: push token'ı olmayan kişiler`, { userIds: noToken });
    }
    if (valid.length === 0) return { transientFailedUserIds: [] };

    // screen: mobil taraf type'a bakmadan tek bir kuralla ("screen" alanına göre)
    // yönlendirme yapabilsin diye tüm maç bildirimlerine eklenen ortak alan.
    const data = { type: dataType, screen: "MATCHES", ...extraData };
    const message = buildPushMessage(title, body, data);

    const results: TokenResult[] = [];
    const deadTokens: string[] = [];
    const errorLog: { userId: number; platform: string; code: string }[] = [];

    for (let i = 0; i < valid.length; i += CHUNK_SIZE) {
        const chunk = valid.slice(i, i + CHUNK_SIZE);
        try {
            const response = await getMessaging(app).sendEachForMulticast({ tokens: chunk.map(c => c.token), ...message });
            response.responses.forEach((r, idx) => {
                const row = chunk[idx];
                const code = r.error?.code;
                results.push({ userId: row.userId, success: r.success, code });
                if (r.success) return;
                errorLog.push({ userId: row.userId, platform: row.platform, code: code ?? "unknown" });
                if (code && DEAD_TOKEN_ERROR_CODES.has(code)) deadTokens.push(row.token);
            });
        } catch (err: any) {
            // Tüm parça düştü (ağ / kimlik) — parçadaki herkes geçici hatalı.
            logger.error("Push gönderme hatası", { error: err?.message, code: err?.code });
            for (const row of chunk) results.push({ userId: row.userId, success: false });
        }
    }

    if (errorLog.length > 0) {
        // Kod + platform + kişi: "kime neden gitmedi" sorusu loglardan cevaplanabilsin.
        logger.error("FCM gönderim hataları", { failureCount: errorLog.length, errors: errorLog });
    }
    if (deadTokens.length > 0) {
        await db.pushToken
            .deleteMany({ where: { token: { in: deadTokens } } })
            .catch((err: Error) => logger.error("Ölü token temizliği başarısız", { error: err.message }));
    }

    const { delivered, transientFailed, permanentFailed } = classifyDelivery(results);
    const level = delivered.length === 0 && (transientFailed.length + permanentFailed.length) > 0 ? "error" : "info";
    logger.log(level, `${logLabel} sonucu`, {
        ulasti: delivered.length,
        geciciHata: transientFailed.length,
        kaliciHata: permanentFailed.length,
        tokensiz: noToken.length,
        tokenCount: valid.length,
    });
    return { transientFailedUserIds: transientFailed };
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
): Promise<PushResult> {
    const { dataType, logLabel } = MATCH_PUSH_TYPES[kind];
    return sendPushToUsers(userIds, text.title, text.body, dataType, logLabel, extraData);
}
