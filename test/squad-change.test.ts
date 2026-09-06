import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { summarizeSquadChange } from "../src/lib/squad-change";
import { MatchData } from "../src/lib/match-parser";

function md(overrides: Partial<MatchData> = {}): MatchData {
    return {
        mac_adi: "A - B", tarih: "07.09.2026", saat: "16:00", salon: "SALON",
        kategori: "U14", ligTuru: "Yerel Lig",
        hakemler: [], masa_gorevlileri: [], saglikcilar: [],
        istatistikciler: [], gozlemciler: [], sahaKomiserleri: [],
        kaynak_dosya: "test", ...overrides,
    };
}

describe("summarizeSquadChange", () => {
    test("null girdi → genel mesaj", () => {
        assert.equal(summarizeSquadChange(null, md()), "Görevli kadrosu güncellendi");
    });

    test("tek rol grubuna ekleme → 'Kadroya N X eklendi'", () => {
        const oldM = md({ hakemler: ["A"] });
        const newM = md({ hakemler: ["A", "B", "C"] });
        assert.equal(summarizeSquadChange(oldM, newM), "Kadroya 2 hakem eklendi");
    });

    test("tek rol grubundan çıkarma → 'Kadrodan N X çıkarıldı'", () => {
        const oldM = md({ masa_gorevlileri: ["A", "B", "C"] });
        const newM = md({ masa_gorevlileri: ["A"] });
        assert.equal(summarizeSquadChange(oldM, newM), "Kadrodan 2 masa görevlisi çıkarıldı");
    });

    test("tek rol grubunda isim değişimi (BİROL ÖZDAL → EVİN ÖZDEMİR)", () => {
        const oldM = md({ masa_gorevlileri: ["BAŞAK ÇELİK", "ESER FIRIL", "BİROL ÖZDAL"] });
        const newM = md({ masa_gorevlileri: ["BAŞAK ÇELİK", "ESER FIRIL", "EVİN ÖZDEMİR"] });
        assert.equal(summarizeSquadChange(oldM, newM), "Masa görevlisi kadrosu değişti");
    });

    test("birden fazla rol grubuna ekleme → genel özet", () => {
        const oldM = md({ hakemler: ["A"] });
        const newM = md({ hakemler: ["A", "B"], gozlemciler: ["G"], sahaKomiserleri: ["K"] });
        assert.equal(summarizeSquadChange(oldM, newM), "Görevli kadrosuna 3 kişi eklendi");
    });

    test("kadro aynı (sadece sıra farkı) → 'Maç bilgileri güncellendi'", () => {
        const oldM = md({ hakemler: ["A", "B"] });
        const newM = md({ hakemler: ["B", "A"] });
        assert.equal(summarizeSquadChange(oldM, newM), "Maç bilgileri güncellendi");
    });

    test("gerçek vaka: 227821 → 228013 (isim değişimi + 4 kişi eklendi)", () => {
        const oldM = md({
            hakemler: ["HASAN HÜSEYİN DEVECİ", "EMRE EFE CİHAN"],
            masa_gorevlileri: ["BAŞAK ÇELİK", "ESER FIRIL", "BİROL ÖZDAL"],
            saglikcilar: ["MERVE KAYA"],
        });
        const newM = md({
            hakemler: ["HASAN HÜSEYİN DEVECİ", "EMRE EFE CİHAN"],
            masa_gorevlileri: ["BAŞAK ÇELİK", "ESER FIRIL", "EVİN ÖZDEMİR"],
            saglikcilar: ["MERVE KAYA"],
            gozlemciler: ["SAVAŞ ERTÜRK"],
            sahaKomiserleri: ["AZMİ HAKAN ARK"],
        });
        // masa: 1 çıktı 1 girdi, gozlemci: +1, sahaKomiseri: +1 → çok rollü, net eklenen 2
        const summary = summarizeSquadChange(oldM, newM);
        assert.ok(summary.length > 0 && summary.length < 60);
    });
});
