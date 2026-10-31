import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchCellName, cellNameMatches, resolveCellCandidates, cellWordsOf } from "../src/lib/name-match";

// İKİZ TEST: bks-web-system `lib/__tests__/name-match.test.ts` aynı fixture'ları kullanır.
// Canlı vaka (2026-11-01): "Cem Akan", "AYHAN CEM AKAN" ve "ASLAN CEM AKAN" üç
// farklı kişi; eski kural Cem Akan'a diğer ikisinin maçlarını da yazıyordu.

const CEM = { id: 13, firstName: "Cem", lastName: "Akan" };
const AYHAN = { id: 301, firstName: "AYHAN CEM", lastName: "AKAN" };
const ASLAN = { id: 655, firstName: "Aslan Cem", lastName: "Akan" };
const RECEP = { id: 132, firstName: "Recep", lastName: "Dağdelen" };
const MERT = { id: 145, firstName: "Mert", lastName: "Kayaalplı" };
const CEVIK = { id: 234, firstName: "Ahmet", lastName: "Çevik" };
const CELIK = { id: 999, firstName: "Ahmet", lastName: "Çelik" };

describe("matchCellName", () => {
    it("birebir ad → exact", () => {
        assert.equal(matchCellName("CEM AKAN", "Cem", "Akan")?.kind, "exact");
    });
    it("sıra farkı ve Türkçe harf → exact", () => {
        assert.equal(matchCellName("BAYRAK EFE CAN", "Efe Can", "Bayrak")?.kind, "exact");
        assert.equal(matchCellName("İSA ERUZUN", "isa", "eruzun")?.kind, "exact");
    });
    it("tek harf yazım hatası → exact (typo işaretli)", () => {
        const m = matchCellName("MEHMET BOYRAT", "Mehmet", "Boyvat");
        assert.equal(m?.kind, "exact");
        assert.equal(m?.typo, true);
    });
    it("hücrede başka birinin adının parçası artıyorsa → eşleşmez", () => {
        assert.equal(matchCellName("AYHAN CEM AKAN", "Cem", "Akan"), null);
        assert.equal(matchCellName("ASLAN CEM AKAN", "Cem", "Akan"), null);
    });
    it("profil hücreden uzunsa → eşleşmez (eski davranış)", () => {
        assert.equal(matchCellName("CEM AKAN", "Ayhan Cem", "Akan"), null);
    });
    it("iki kişilik hücre → partial", () => {
        assert.equal(matchCellName("RECEP DAĞDELEN- MERT KAYAALPLI", "Recep", "Dağdelen")?.kind, "partial");
        assert.equal(matchCellName("RECEP DAĞDELEN- MERT KAYAALPLI", "Mert", "Kayaalplı")?.kind, "partial");
    });
    it("hem fazla kelime hem yazım hatası → eşleşmez", () => {
        assert.equal(matchCellName("AHMET TARIK ÇELİK", "Ahmet", "Çevik"), null);
    });
    it("harf içermeyen parça kelime sayılmaz", () => {
        assert.deepEqual(cellWordsOf("￼ HÜLYA ÖZKAN"), ["hülya", "özkan"]);
        assert.equal(matchCellName("￼ HÜLYA ÖZKAN", "Hülya", "Özkan")?.kind, "exact");
    });
    it("kısa/boş girdiler → null", () => {
        assert.equal(cellNameMatches("AY", "Ali", "Ay"), false);
        assert.equal(cellNameMatches("ALİ KAYA", "", "Kaya"), false);
    });
});

describe("resolveCellCandidates", () => {
    const all = [CEM, AYHAN, ASLAN, RECEP, MERT, CEVIK, CELIK];

    it("her hücre yalnız kendi sahibine gider", () => {
        assert.deepEqual(resolveCellCandidates("AYHAN CEM AKAN", all).ids, [301]);
        assert.deepEqual(resolveCellCandidates("ASLAN CEM AKAN", all).ids, [655]);
        assert.deepEqual(resolveCellCandidates("CEM AKAN", all).ids, [13]);
    });
    it("iki kişilik hücre → ikisi de atanır", () => {
        assert.deepEqual(resolveCellCandidates("RECEP DAĞDELEN- MERT KAYAALPLI", all).ids.sort(), [132, 145]);
    });
    it("yazım hatasız tam eşleşme yazım hatalıya tercih edilir", () => {
        assert.deepEqual(resolveCellCandidates("AHMET ÇELİK", all), { ids: [999], ambiguous: [234] });
    });
    it("birebir aynı isimli iki hesap → ikisi de atanır (eski davranış)", () => {
        const twins = [{ id: 457, firstName: "Rıfat", lastName: "Bayar" }, { id: 630, firstName: "RIFAT", lastName: "BAYAR" }];
        assert.deepEqual(resolveCellCandidates("RIFAT BAYAR", twins).ids.sort(), [457, 630]);
    });
    it("aynı kişinin iki profili tek aday sayılır, en iyi sonuç geçerli", () => {
        const dual = [{ id: 7, firstName: "Gönül Bakır", lastName: "Tükel" }, { id: 7, firstName: "Gönül", lastName: "Bakır" }];
        assert.deepEqual(resolveCellCandidates("GÖNÜL BAKIR", dual).ids, [7]);
    });
    it("kimse uymuyorsa boş", () => {
        assert.deepEqual(resolveCellCandidates("ZEYNEP YILDIZ", all), { ids: [], ambiguous: [] });
    });
});
