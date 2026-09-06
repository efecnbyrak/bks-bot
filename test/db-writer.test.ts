import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeMatchKey, computeContentKey, parseTarihDate, evaluateCancellationSafety } from "../src/db-writer";
import { MatchData } from "../src/lib/match-parser";

function makeMatch(overrides: Partial<MatchData> = {}): MatchData {
    return {
        mac_adi: "Takım A - Takım B",
        tarih: "23.08.2026",
        saat: "18:00",
        salon: "Salon 1",
        kategori: "Erkek",
        ligTuru: "1. Lig",
        hakemler: ["Ali Veli"],
        masa_gorevlileri: [],
        saglikcilar: [],
        istatistikciler: [],
        gozlemciler: [],
        sahaKomiserleri: [],
        kaynak_dosya: "test.xlsx",
        ...overrides,
    };
}

describe("computeMatchKey", () => {
    test("aynı maç için deterministik aynı anahtarı üretir", () => {
        const a = makeMatch();
        const b = makeMatch();
        assert.equal(computeMatchKey(a), computeMatchKey(b));
    });

    test("hakem listesi değişirse anahtar değişir", () => {
        const a = makeMatch({ hakemler: ["Ali Veli"] });
        const b = makeMatch({ hakemler: ["Ali Veli", "Ayşe Yılmaz"] });
        assert.notEqual(computeMatchKey(a), computeMatchKey(b));
    });

    test("hakem sırası anahtarı etkilemez (sıralanıp hashleniyor)", () => {
        const a = makeMatch({ hakemler: ["Ali Veli", "Ayşe Yılmaz"] });
        const b = makeMatch({ hakemler: ["Ayşe Yılmaz", "Ali Veli"] });
        assert.equal(computeMatchKey(a), computeMatchKey(b));
    });

    test("baş/son boşluk ve İngilizce harflerde büyük/küçük farkı anahtarı etkilemez (trim + toLowerCase)", () => {
        const a = makeMatch({ mac_adi: "Team A - Team B" });
        const b = makeMatch({ mac_adi: "  TEAM A - TEAM B  " });
        assert.equal(computeMatchKey(a), computeMatchKey(b));
    });
});

describe("computeContentKey", () => {
    test("hakem listesi değişse de içerik anahtarı aynı kalır", () => {
        const a = makeMatch({ hakemler: ["Ali Veli"] });
        const b = makeMatch({ hakemler: ["Başka Hakem"] });
        assert.equal(computeContentKey(a), computeContentKey(b));
    });

    test("maç adı değişirse içerik anahtarı değişir", () => {
        const a = makeMatch({ mac_adi: "Takım A - Takım B" });
        const b = makeMatch({ mac_adi: "Takım C - Takım D" });
        assert.notEqual(computeContentKey(a), computeContentKey(b));
    });

    test("tarih değişirse içerik anahtarı değişir", () => {
        const a = makeMatch({ tarih: "23.08.2026" });
        const b = makeMatch({ tarih: "24.08.2026" });
        assert.notEqual(computeContentKey(a), computeContentKey(b));
    });
});

describe("evaluateCancellationSafety (FAZ 1 sigortası)", () => {
    test("normal günlük iade hacmi (24 atama / 60 aktif) güvenli sayılır", () => {
        assert.equal(evaluateCancellationSafety(24, 60).safe, true);
    });

    test("mutlak eşiğin altındaki her şey oran ne olursa olsun güvenli (10 / 10)", () => {
        assert.equal(evaluateCancellationSafety(10, 10).safe, true);
    });

    test("mutlak eşik aşıldı ama oran düşük (25 / 100) → güvenli", () => {
        assert.equal(evaluateCancellationSafety(25, 100).safe, true);
    });

    test("hem mutlak hem oran eşiği aşıldı (25 / 60, %42) → engellenir", () => {
        const r = evaluateCancellationSafety(25, 60);
        assert.equal(r.safe, false);
        assert.ok(r.reason);
    });

    test("parser regresyonu senaryosu (300 / 310, ~%97) → engellenir", () => {
        assert.equal(evaluateCancellationSafety(300, 310).safe, false);
    });

    test("dosyada aktif atama görünmüyor ama aday çok (30 / 0) → engellenir", () => {
        assert.equal(evaluateCancellationSafety(30, 0).safe, false);
    });

    test("kanıtlanmış 227821 vakası (6 atama) → sigorta bloklamaz, Faz 2'ye kalır", () => {
        assert.equal(evaluateCancellationSafety(6, 40).safe, true);
    });
});

describe("parseTarihDate", () => {
    test("nokta ayraçlı DD.MM.YYYY formatını parse eder", () => {
        const d = parseTarihDate("23.08.2026");
        assert.ok(d);
        assert.equal(d!.getUTCFullYear(), 2026);
        assert.equal(d!.getUTCMonth(), 7); // 0-indexed => Ağustos
        assert.equal(d!.getUTCDate(), 23);
    });

    test("slash ayraçlı D/M/YYYY formatını parse eder", () => {
        const d = parseTarihDate("3/8/2026");
        assert.ok(d);
        assert.equal(d!.getUTCFullYear(), 2026);
        assert.equal(d!.getUTCMonth(), 7);
        assert.equal(d!.getUTCDate(), 3);
    });

    test("boş string için null döner", () => {
        assert.equal(parseTarihDate(""), null);
    });

    test("tanınmayan format için null döner", () => {
        assert.equal(parseTarihDate("geçersiz tarih"), null);
    });
});
