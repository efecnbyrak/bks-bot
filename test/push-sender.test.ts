import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildPushMessage, classifyDelivery, computeUndelivered } from "../src/lib/push-sender";
import { fallbackDedupeKey } from "../src/lib/notification-fallback";

// Maç bildirimi her cihaza klasik biçimde gider (sistem gösterir — kapalı uygulamada
// da kaybolmaz); mobil detay sayfası başlık/metni data'dan okur.
describe("buildPushMessage", () => {
    test("notification bloğu var, data title/body/type/screen/channel taşır", () => {
        const m = buildPushMessage("T", "B\nC", { type: "MATCH_ASSIGNED", screen: "MATCHES" });
        assert.deepEqual(m.notification, { title: "T", body: "B\nC" });
        assert.equal(m.data.title, "T");
        assert.equal(m.data.body, "B\nC");
        assert.equal(m.data.type, "MATCH_ASSIGNED");
        assert.equal(m.data.screen, "MATCHES");
        assert.equal(m.data.channel, "matches");
        assert.equal(m.android.priority, "high");
        assert.equal(m.android.notification.channelId, "matches");
    });
});

describe("classifyDelivery", () => {
    test("bir cihaza ulaşan teslim; geçici hata tekrar; ölü token kalıcı", () => {
        const r = classifyDelivery([
            { userId: 1, success: false, code: "messaging/unavailable" },
            { userId: 1, success: true },
            { userId: 2, success: false, code: "messaging/internal-error" },
            { userId: 3, success: false, code: "messaging/registration-token-not-registered" },
            { userId: 4, success: false },
        ]);
        assert.deepEqual(r.delivered, [1]);
        assert.deepEqual(r.transientFailed.sort(), [2, 4]);
        assert.deepEqual(r.permanentFailed, [3]);
    });
});

// E-posta yedeği (2026-11-15): kesin ulaşmayanlar = token'sız ∪ kalıcı hatalı ∪ izni kapalı.
describe("computeUndelivered", () => {
    test("token'sız ve kalıcı hatalılar dahil, ulaşanlar hariç", () => {
        assert.deepEqual(computeUndelivered([1], [2], [3], new Set()).sort(), [1, 2]);
    });
    test("ulaştı görünen ama izni kapalı kişi dahil (Android izin kapalıyken FCM başarılı der)", () => {
        assert.deepEqual(computeUndelivered([], [], [3, 4], new Set([4])), [4]);
    });
    test("tekrarlar tekilleşir", () => {
        assert.deepEqual(computeUndelivered([1], [1], [], new Set()), [1]);
    });
});

describe("fallbackDedupeKey", () => {
    const base = { userId: 5, kind: "ASSIGNED", title: "T", body: "B", matchKey: "ck" };
    test("aynı bildirim aynı anahtar", () => {
        assert.equal(fallbackDedupeKey(base), fallbackDedupeKey({ ...base }));
    });
    test("farklı metin, kişi ya da tür farklı anahtar", () => {
        const k = fallbackDedupeKey(base);
        assert.notEqual(k, fallbackDedupeKey({ ...base, body: "B2" }));
        assert.notEqual(k, fallbackDedupeKey({ ...base, userId: 6 }));
        assert.notEqual(k, fallbackDedupeKey({ ...base, kind: "CANCELLED" }));
    });
});
