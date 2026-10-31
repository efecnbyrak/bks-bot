import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeTabFingerprint, shouldSkipTab } from "../src/lib/tbf-milli-fingerprint";

// TBF/Milli sekme parmak izi: içerik/bağlam değişince hash değişmeli, aynıysa aynı kalmalı.
const CTX = { seasonKey: "2026-2027", cutoffIso: "2026-08-01T00:00:00.000Z" };
const makeTab = () => ({
    spreadsheetTitle: "TBF-FIBA-MİLLİ MAÇLAR 2026-2027",
    tabTitle: "Sayfa1",
    rows: [
        ["TARİH", "SAAT", "MAÇ"],
        ["01.11.2026", "18:00", "A - B"],
    ],
});

describe("computeTabFingerprint", () => {
    const base = computeTabFingerprint(makeTab(), CTX);

    test("aynı sekme + bağlam aynı hash'i verir", () => {
        assert.equal(computeTabFingerprint(makeTab(), CTX), base);
        assert.match(base, /^[0-9a-f]{64}$/);
    });

    test("tek hücre değişince hash değişir", () => {
        const tab = makeTab();
        tab.rows[1][1] = "19:00";
        assert.notEqual(computeTabFingerprint(tab, CTX), base);
    });

    test("tabTitle değişince hash değişir", () => {
        assert.notEqual(computeTabFingerprint({ ...makeTab(), tabTitle: "Sayfa2" }, CTX), base);
    });

    test("spreadsheetTitle değişince hash değişir", () => {
        assert.notEqual(computeTabFingerprint({ ...makeTab(), spreadsheetTitle: "Başka" }, CTX), base);
    });

    test("seasonKey değişince hash değişir", () => {
        assert.notEqual(computeTabFingerprint(makeTab(), { ...CTX, seasonKey: "2027-2028" }), base);
    });

    test("cutoffIso değişince hash değişir", () => {
        assert.notEqual(computeTabFingerprint(makeTab(), { ...CTX, cutoffIso: "2026-09-01T00:00:00.000Z" }), base);
    });
});

describe("shouldSkipTab", () => {
    test("eşit ve zorlama yok -> atlanır", () => assert.equal(shouldSkipTab("a", "a", false), true));
    test("force -> atlanmaz", () => assert.equal(shouldSkipTab("a", "a", true), false));
    test("önceki null -> atlanmaz", () => assert.equal(shouldSkipTab(null, "a", false), false));
    test("önceki undefined -> atlanmaz", () => assert.equal(shouldSkipTab(undefined, "a", false), false));
    test("yeni null -> atlanmaz", () => assert.equal(shouldSkipTab("a", null, false), false));
    test("farklı -> atlanmaz", () => assert.equal(shouldSkipTab("a", "b", false), false));
});
