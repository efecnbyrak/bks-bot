import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectRole } from "../src/user-matcher";
import { MatchData } from "../src/lib/match-parser";

function makeMatch(overrides: Partial<MatchData> = {}): MatchData {
    return {
        mac_adi: "Takım A - Takım B",
        tarih: "23.08.2026",
        saat: "18:00",
        salon: "Salon 1",
        kategori: "Erkek",
        ligTuru: "1. Lig",
        hakemler: [],
        masa_gorevlileri: [],
        saglikcilar: [],
        istatistikciler: [],
        gozlemciler: [],
        sahaKomiserleri: [],
        kaynak_dosya: "test.xlsx",
        ...overrides,
    };
}

describe("detectRole", () => {
    test("hakemler listesindeki isim için 'hakem' rolü döner", () => {
        const match = makeMatch({ hakemler: ["Ali Veli"] });
        const result = detectRole(match, "Ali Veli");
        assert.deepEqual(result, { role: "hakem", nameInSpreadsheet: "Ali Veli" });
    });

    test("masa görevlileri listesindeki isim için 'masa' rolü döner", () => {
        const match = makeMatch({ masa_gorevlileri: ["Ayşe Yılmaz"] });
        const result = detectRole(match, "Ayşe Yılmaz");
        assert.deepEqual(result, { role: "masa", nameInSpreadsheet: "Ayşe Yılmaz" });
    });

    test("gözlemciler listesindeki isim için 'gozlemci' rolü döner", () => {
        const match = makeMatch({ gozlemciler: ["Mehmet Can"] });
        const result = detectRole(match, "Mehmet Can");
        assert.deepEqual(result, { role: "gozlemci", nameInSpreadsheet: "Mehmet Can" });
    });

    test("hiçbir listede olmayan isim için null döner", () => {
        const match = makeMatch({ hakemler: ["Ali Veli"] });
        assert.equal(detectRole(match, "Bilinmeyen Kişi"), null);
    });

    test("birden fazla listede varsa öncelik sırasına göre ilk bulunan rol döner (hakemler önce)", () => {
        const match = makeMatch({ hakemler: ["Ali Veli"], masa_gorevlileri: ["Ali Veli"] });
        const result = detectRole(match, "Ali Veli");
        assert.equal(result?.role, "hakem");
    });
});
