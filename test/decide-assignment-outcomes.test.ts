import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decideAssignmentOutcomes, AssignmentDecisionInput } from "../src/db-writer";
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

// Kısayol: verilen contentKey'ler işlenen dosyada varsayılır (aksi belirtilmedikçe)
function input(
    assignments: AssignmentDecisionInput["assignments"],
    activeRowsByContentKey: AssignmentDecisionInput["activeRowsByContentKey"],
    opts: Partial<Pick<AssignmentDecisionInput, "currentFileContentKeys" | "movedContentKeys">> = {}
): AssignmentDecisionInput {
    return {
        assignments,
        activeRowsByContentKey,
        currentFileContentKeys: opts.currentFileContentKeys ?? new Set([...activeRowsByContentKey.keys()]),
        movedContentKeys: opts.movedContentKeys ?? new Set(),
    };
}

describe("decideAssignmentOutcomes", () => {
    test("kullanıcı hâlâ atandığı satırın kadrosunda → KEPT", () => {
        const out = decideAssignmentOutcomes(input(
            [{ userId: 1, nameInSpreadsheet: "AHMET YILMAZ",
               match: { id: 100, contentKey: "ck1", macAdi: "A - B", tarih: "07.09.2026" } }],
            new Map([["ck1", [{ id: 100, data: md({ hakemler: ["AHMET YILMAZ"] }) }]]]),
        ));
        assert.equal(out[0].kind, "KEPT");
    });

    test("kullanıcının ismi maçın HİÇBİR satırında yok → CANCELLED", () => {
        const out = decideAssignmentOutcomes(input(
            [{ userId: 1, nameInSpreadsheet: "AHMET YILMAZ",
               match: { id: 100, contentKey: "ck1", macAdi: "A - B", tarih: "07.09.2026" } }],
            new Map([["ck1", [{ id: 100, data: md({ hakemler: ["BAŞKA KİŞİ"] }) }]]]),
        ));
        assert.equal(out[0].kind, "CANCELLED");
    });

    test("maç işlenen dosyada yok + moved listesinde → MOVED (arşive taşınma, sessiz)", () => {
        const out = decideAssignmentOutcomes(input(
            [{ userId: 1, nameInSpreadsheet: "AHMET YILMAZ",
               match: { id: 100, contentKey: "ck1", macAdi: "A - B", tarih: "07.09.2026" } }],
            new Map(),
            { currentFileContentKeys: new Set(), movedContentKeys: new Set(["ck1"]) },
        ));
        assert.equal(out[0].kind, "MOVED");
    });

    test("maç işlenen dosyada yok + moved DEĞİL → CANCELLED", () => {
        const out = decideAssignmentOutcomes(input(
            [{ userId: 1, nameInSpreadsheet: "AHMET YILMAZ",
               match: { id: 100, contentKey: "ck1", macAdi: "A - B", tarih: "07.09.2026" } }],
            new Map(),
            { currentFileContentKeys: new Set(), movedContentKeys: new Set() },
        ));
        assert.equal(out[0].kind, "CANCELLED");
    });

    test("kademeli doldurma: kullanıcı eski satırda, kanonik (dolu) satır aynı dosyada → ROW_SHIFTED", () => {
        const out = decideAssignmentOutcomes(input(
            [{ userId: 1, nameInSpreadsheet: "AHMET YILMAZ",
               match: { id: 100, contentKey: "ck1", macAdi: "A - B", tarih: "07.09.2026" } }],
            new Map([["ck1", [
                { id: 100, data: md({ masa_gorevlileri: ["AHMET YILMAZ"] }) },
                { id: 200, data: md({ hakemler: ["X", "Y"], masa_gorevlileri: ["AHMET YILMAZ", "Z"] }) },
            ]]]),
        ));
        assert.equal(out[0].kind, "ROW_SHIFTED");
        assert.equal(out[0].toMatchId, 200);
    });

    test("isim sırası ters (fuzzy nameMatches) — profil adı verilirse KEPT sayılır", () => {
        const out = decideAssignmentOutcomes(input(
            [{ userId: 1, nameInSpreadsheet: "EFE CAN BAYRAK", firstName: "EFE CAN", lastName: "BAYRAK",
               match: { id: 100, contentKey: "ck1", macAdi: "A - B", tarih: "07.09.2026" } }],
            new Map([["ck1", [{ id: 100, data: md({ hakemler: ["BAYRAK EFE CAN"] }) }]]]),
        ));
        assert.equal(out[0].kind, "KEPT");
    });

    test("contentKey null (geçiş dönemi kaydı) → KEPT (dokunma)", () => {
        const out = decideAssignmentOutcomes(input(
            [{ userId: 1, nameInSpreadsheet: "AHMET YILMAZ",
               match: { id: 100, contentKey: null, macAdi: "A - B", tarih: "07.09.2026" } }],
            new Map(),
        ));
        assert.equal(out[0].kind, "KEPT");
    });

    // ---- KANITLANMIŞ ÜRETİM VAKASI (2026-09-06, 08:02) ----
    // 227821: hakemler=[HASAN HÜSEYİN DEVECİ, EMRE EFE CİHAN], masa=[BAŞAK ÇELİK, ESER FIRIL, BİROL ÖZDAL], saglik=[MERVE KAYA]
    // 228013 AKTİF aynı contentKey: hakemler AYNI, masa=[BAŞAK ÇELİK, ESER FIRIL, EVİN ÖZDEMİR], saglik=[MERVE KAYA], +gozlemci +sahaKomiseri
    // Beklenen: 5 kişi maçta kaldı, sadece BİROL ÖZDAL çıkarıldı
    test("gerçek vaka 227821/228013 — iptal ÖNCESİ tur: 5 kişi CANCELLED OLMAMALI", () => {
        const row227821 = md({
            hakemler: ["HASAN HÜSEYİN DEVECİ", "EMRE EFE CİHAN"],
            masa_gorevlileri: ["BAŞAK ÇELİK", "ESER FIRIL", "BİROL ÖZDAL"],
            saglikcilar: ["MERVE KAYA"],
        });
        const row228013 = md({
            hakemler: ["HASAN HÜSEYİN DEVECİ", "EMRE EFE CİHAN"],
            masa_gorevlileri: ["BAŞAK ÇELİK", "ESER FIRIL", "EVİN ÖZDEMİR"],
            saglikcilar: ["MERVE KAYA"],
            gozlemciler: ["SAVAŞ ERTÜRK"], sahaKomiserleri: ["AZMİ HAKAN ARK"],
        });
        const people = [
            { userId: 216, name: "BAŞAK ÇELİK" }, { userId: 291, name: "ESER FIRIL" },
            { userId: 492, name: "MERVE KAYA" }, { userId: 524, name: "EMRE EFE CİHAN" },
            { userId: 552, name: "HASAN HÜSEYİN DEVECİ" }, { userId: 222, name: "BİROL ÖZDAL" },
        ];
        const out = decideAssignmentOutcomes(input(
            people.map(p => ({
                userId: p.userId, nameInSpreadsheet: p.name,
                match: { id: 227821, contentKey: "ck-akademi", macAdi: "AKADEMİ", tarih: "07.09.2026" },
            })),
            new Map([["ck-akademi", [
                { id: 227821, data: row227821 },
                { id: 228013, data: row228013 },
            ]]]),
        ));
        const byUser = new Map(out.map(o => [o.userId, o.kind]));
        for (const uid of [216, 291, 492, 524, 552]) {
            assert.notEqual(byUser.get(uid), "CANCELLED", `user ${uid} CANCELLED olmamalı`);
        }
    });

    test("gerçek vaka — iptal SONRASI tur: sadece 228013 aktif → 5 kişi ROW_SHIFTED, BİROL ÖZDAL CANCELLED", () => {
        const row228013 = md({
            hakemler: ["HASAN HÜSEYİN DEVECİ", "EMRE EFE CİHAN"],
            masa_gorevlileri: ["BAŞAK ÇELİK", "ESER FIRIL", "EVİN ÖZDEMİR"],
            saglikcilar: ["MERVE KAYA"],
        });
        const people = [
            { userId: 216, name: "BAŞAK ÇELİK" }, { userId: 291, name: "ESER FIRIL" },
            { userId: 492, name: "MERVE KAYA" }, { userId: 524, name: "EMRE EFE CİHAN" },
            { userId: 552, name: "HASAN HÜSEYİN DEVECİ" }, { userId: 222, name: "BİROL ÖZDAL" },
        ];
        const out = decideAssignmentOutcomes(input(
            people.map(p => ({
                userId: p.userId, nameInSpreadsheet: p.name,
                match: { id: 227821, contentKey: "ck-akademi", macAdi: "AKADEMİ", tarih: "07.09.2026" },
            })),
            new Map([["ck-akademi", [{ id: 228013, data: row228013 }]]]),
        ));
        const byUser = new Map(out.map(o => [o.userId, o]));
        for (const uid of [216, 291, 492, 524, 552]) {
            assert.equal(byUser.get(uid)!.kind, "ROW_SHIFTED", `user ${uid} ROW_SHIFTED olmalı`);
            assert.equal(byUser.get(uid)!.toMatchId, 228013);
        }
        assert.equal(byUser.get(222)!.kind, "CANCELLED");
    });

    test("kademeli doldurma — dosya revizyonu (1.HAFTA → 1.HAFTA_R1): eski dosyadaki atama yeni dosyadaki kanonik satıra ROW_SHIFTED", () => {
        // Eski dosya (896): masa=[ZEHRA AKAN] — bu dosya artık işlenmiyor, contentKey current'te yok
        // Yeni dosya (901): tam kadro — currentFileContentKeys'te var
        const out = decideAssignmentOutcomes(input(
            [{ userId: 1, nameInSpreadsheet: "ZEHRA AKAN",
               match: { id: 221614, contentKey: "ckHafta", macAdi: "ÜMRANİYE - İGSK", tarih: "28.08.2026" } }],
            new Map([["ckHafta", [
                { id: 221614, data: md({ masa_gorevlileri: ["ZEHRA AKAN"] }) },
                { id: 222649, data: md({ hakemler: ["A", "B"], masa_gorevlileri: ["ZEHRA AKAN", "C", "D"] }) },
            ]]]),
        ));
        assert.equal(out[0].kind, "ROW_SHIFTED");
        assert.equal(out[0].toMatchId, 222649);
    });
});
