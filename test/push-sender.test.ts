import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { supportsDataOnly, buildPushMessages } from "../src/lib/push-sender";

// 1.0.12+ Android → sadece veri taşıyan (uygulamanın büyütülebilir çizdiği) bildirim.
// Diğer her durumda klasik bildirim: eski sürüm veri mesajını GÖSTEREMEZ.
describe("supportsDataOnly", () => {
    test("1.0.12 ve üstü Android → evet", () => {
        assert.equal(supportsDataOnly("android", "1.0.12"), true);
        assert.equal(supportsDataOnly("android", "1.0.13"), true);
        assert.equal(supportsDataOnly("android", "1.1.0"), true);
        assert.equal(supportsDataOnly("android", "2.0.0"), true);
    });
    test("eski sürüm / sürümsüz / iOS / bozuk değer → hayır", () => {
        assert.equal(supportsDataOnly("android", "1.0.11"), false);
        assert.equal(supportsDataOnly("android", "1.0.9"), false);
        assert.equal(supportsDataOnly("android", null), false);
        assert.equal(supportsDataOnly("ios", "1.0.12"), false);
        assert.equal(supportsDataOnly("android", "1.0"), false);
        assert.equal(supportsDataOnly("android", "1.0.x"), false);
    });
});

// Mobil uygulama içi detay sayfası başlık/metni data'dan okur — iki biçimde de olmalı.
describe("buildPushMessages", () => {
    test("klasik ve sadece-veri mesajı data'da title/body taşır", () => {
        const { classic, dataOnly } = buildPushMessages("T", "B\nC", { type: "MATCH_ASSIGNED", screen: "MATCHES" });
        for (const m of [classic, dataOnly]) {
            assert.equal(m.data.title, "T");
            assert.equal(m.data.body, "B\nC");
            assert.equal(m.data.type, "MATCH_ASSIGNED");
            assert.equal(m.data.screen, "MATCHES");
        }
        assert.deepEqual(classic.notification, { title: "T", body: "B\nC" });
        assert.equal("notification" in dataOnly, false);
    });
});
