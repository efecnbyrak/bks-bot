import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { supportsDataOnly } from "../src/lib/push-sender";

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
