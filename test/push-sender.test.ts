import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildPushMessage, classifyDelivery } from "../src/lib/push-sender";

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
