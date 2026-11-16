import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildPushMessage, buildDeliveryRows, classifyDelivery } from "../src/lib/push-sender";

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

// Teslim kaydı (2026-11-16): kişi başına tek satır, durum + token sayısı + hata kodları.
describe("buildDeliveryRows", () => {
    const ctx = { kind: "MATCH_ASSIGNED", refKey: "ck1", attempt: 2 };
    test("token'sız, ulaşan, izni kapalı, geçici ve kalıcı hata ayrı durum alır", () => {
        const rows = buildDeliveryRows(
            [1],
            [
                { userId: 2, success: true },
                { userId: 2, success: false, code: "messaging/unavailable" },
                { userId: 3, success: true },
                { userId: 4, success: false, code: "messaging/internal-error" },
                { userId: 5, success: false, code: "messaging/registration-token-not-registered" },
            ],
            new Set([3]),
            ctx,
        );
        const by = new Map(rows.map(r => [r.userId, r]));
        assert.equal(rows.length, 5);
        assert.equal(by.get(1)!.status, "NO_TOKEN");
        assert.equal(by.get(1)!.tokenCount, 0);
        assert.equal(by.get(2)!.status, "DELIVERED");
        assert.equal(by.get(2)!.tokenCount, 2);
        assert.equal(by.get(2)!.errorCodes, "messaging/unavailable");
        assert.equal(by.get(3)!.status, "PERMISSION_DENIED");
        assert.equal(by.get(4)!.status, "TRANSIENT_FAIL");
        assert.equal(by.get(5)!.status, "PERMANENT_FAIL");
        for (const r of rows) {
            assert.equal(r.source, "BOT");
            assert.equal(r.kind, "MATCH_ASSIGNED");
            assert.equal(r.refKey, "ck1");
            assert.equal(r.attempt, 2);
        }
    });
    test("hata kodu yoksa 'unknown' yazılır, başarılıda null", () => {
        const rows = buildDeliveryRows([], [{ userId: 7, success: false }, { userId: 8, success: true }], new Set(), ctx);
        assert.equal(rows.find(r => r.userId === 7)!.errorCodes, "unknown");
        assert.equal(rows.find(r => r.userId === 8)!.errorCodes, null);
    });
});
