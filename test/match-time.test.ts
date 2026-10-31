import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isMatchStarted, matchStartUtc } from "../src/lib/match-time";
import { decideAssignmentOutcomes } from "../src/db-writer";
import { planNotifications } from "../src/change-notifier";
import { MatchData } from "../src/lib/match-parser";

// TRT (UTC+3) yerel saatini UTC Date'e çevirir
const trt = (iso: string) => new Date(new Date(iso + "Z").getTime() - 3 * 3600_000);

function md(o: Partial<MatchData> = {}): MatchData {
    return {
        mac_adi: "A - B", tarih: "25.10.2026", saat: "18:00", salon: "S", kategori: "U14", ligTuru: "Yerel Lig",
        hakemler: [], masa_gorevlileri: [], saglikcilar: [], istatistikciler: [], gozlemciler: [], sahaKomiserleri: [],
        kaynak_dosya: "t", ...o,
    };
}

describe("isMatchStarted (İstanbul saati)", () => {
    test("başlama saatinden önce false, sonra true", () => {
        assert.equal(isMatchStarted("25.10.2026", "18:00", trt("2026-10-25T17:59:00")), false);
        assert.equal(isMatchStarted("25.10.2026", "18:00", trt("2026-10-25T18:00:00")), true);
    });
    test("TRT gece yarısından sonra (UTC hâlâ önceki gün) dünkü maç başlamış sayılır", () => {
        assert.equal(isMatchStarted("25.10.2026", "21:00", trt("2026-10-26T00:30:00")), true);
    });
    test("saat yoksa gün sonuna kadar başlamamış", () => {
        assert.equal(isMatchStarted("25.10.2026", "", trt("2026-10-25T23:00:00")), false);
        assert.equal(isMatchStarted("25.10.2026", null, trt("2026-10-26T00:00:00")), true);
    });
    test("bozuk tarih → false (eski davranış)", () => {
        assert.equal(isMatchStarted("??", "18:00", new Date()), false);
        assert.equal(matchStartUtc("??"), null);
    });
    test("'18.30' yazımı da okunur", () => {
        assert.equal(isMatchStarted("25.10.2026", "18.30", trt("2026-10-25T18:15:00")), false);
    });
});

describe("decideAssignmentOutcomes — oynanmış maça iptal yok", () => {
    const asg = (saat: string) => [{ userId: 9, nameInSpreadsheet: "EFE CAN BAYRAK",
        match: { id: 1, contentKey: "ck", macAdi: "A - B", tarih: "25.10.2026", saat } }];

    test("oynanmış maç dosyadan kalktı (arşiv) → EXPIRED_WINDOW", () => {
        const out = decideAssignmentOutcomes({ assignments: asg("18:00"), activeRowsByContentKey: new Map(),
            currentFileContentKeys: new Set(), movedContentKeys: new Set(), now: trt("2026-10-26T00:30:00") });
        assert.equal(out[0].kind, "EXPIRED_WINDOW");
    });
    test("aynı gün oynanmış maç kadrodan düştü → EXPIRED_WINDOW", () => {
        const rows = new Map([["ck", [{ id: 1, data: md({ hakemler: ["BAŞKASI"] }) }]]]);
        const out = decideAssignmentOutcomes({ assignments: asg("10:00"), activeRowsByContentKey: rows,
            currentFileContentKeys: new Set(["ck"]), movedContentKeys: new Set(), now: trt("2026-10-25T20:00:00") });
        assert.equal(out[0].kind, "EXPIRED_WINDOW");
    });
    test("gelecekteki maçtan isim kaldırıldı → CANCELLED", () => {
        const rows = new Map([["ck", [{ id: 1, data: md({ hakemler: ["BAŞKASI"] }) }]]]);
        const out = decideAssignmentOutcomes({ assignments: asg("18:00"), activeRowsByContentKey: rows,
            currentFileContentKeys: new Set(["ck"]), movedContentKeys: new Set(), now: trt("2026-10-23T12:00:00") });
        assert.equal(out[0].kind, "CANCELLED");
    });
    test("gelecekteki maç dosyadan tamamen kalktı → CANCELLED", () => {
        const out = decideAssignmentOutcomes({ assignments: asg("18:00"), activeRowsByContentKey: new Map(),
            currentFileContentKeys: new Set(), movedContentKeys: new Set(), now: trt("2026-10-25T17:00:00") });
        assert.equal(out[0].kind, "CANCELLED");
    });
});

describe("planNotifications — sadece gelecek maçlar", () => {
    const now = trt("2026-10-26T10:00:00");
    const cancel = (tarih: string, saat: string) => ({ matchId: 1, matchKey: "", macAdi: "ESKİ", tarih, saat, affectedUserIds: [9], contentKey: "old", matchData: md({ mac_adi: "ESKİ", tarih, saat }) });
    const assign = (tarih: string, saat: string) => ({ userId: 9, matchId: 2, macAdi: "YENİ", tarih, saat, contentKey: "new", matchData: md({ mac_adi: "YENİ", tarih, saat }) });
    const kinds = (r: { kind: string }[]) => r.map(n => n.kind).sort();

    test("geçmiş iptal / güncelleme / yeni atama → hiç bildirim yok", () => {
        const r = planNotifications({ cancellations: [cancel("25.10.2026", "18:00")], newAssignments: [],
            shifted: [{ userId: 5, macAdi: "X", tarih: "26.10.2026", saat: "09:00", contentKey: "c", oldMatchData: null, newMatchData: null }] }, now);
        assert.equal(r.length, 0);
        const r2 = planNotifications({ cancellations: [], newAssignments: [assign("25.10.2026", "18:00")], shifted: [] }, now);
        assert.equal(r2.length, 0);
    });
    test("bugün henüz başlamamış maç iptali → bildirim gider", () => {
        const r = planNotifications({ cancellations: [cancel("26.10.2026", "19:00")], newAssignments: [], shifted: [] }, now);
        assert.deepEqual(r.map(n => [n.kind, n.userId]), [["CANCELLED", 9]]);
    });
    test("eski maç geçmiş + yeni maç gelecek → düz Atama (Değişiklik değil)", () => {
        const r = planNotifications({ cancellations: [cancel("25.10.2026", "18:00")], newAssignments: [assign("30.10.2026", "18:00")], shifted: [] }, now);
        assert.deepEqual(kinds(r), ["ASSIGNED"]);
    });
    test("eski maç gelecek + yeni maç geçmiş → düz iptal", () => {
        const r = planNotifications({ cancellations: [cancel("30.10.2026", "18:00")], newAssignments: [assign("25.10.2026", "18:00")], shifted: [] }, now);
        assert.deepEqual(kinds(r), ["CANCELLED"]);
    });
    test("ikisi de gelecek, AYNI gün → Değişiklik", () => {
        const r = planNotifications({ cancellations: [cancel("30.10.2026", "14:00")], newAssignments: [assign("30.10.2026", "18:00")], shifted: [] }, now);
        assert.deepEqual(kinds(r), ["CHANGED"]);
    });
    test("ikisi de gelecek, FARKLI gün → ayrı İptal + Atama (kullanıcı kararı 2026-10-31)", () => {
        const r = planNotifications({ cancellations: [cancel("29.10.2026", "18:00")], newAssignments: [assign("30.10.2026", "18:00")], shifted: [] }, now);
        assert.deepEqual(kinds(r), ["ASSIGNED", "CANCELLED"]);
    });
});
