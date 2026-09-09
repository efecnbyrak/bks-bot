import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    planConsolidation,
    ConsolidatorRow,
    ConsolidatorAssignment,
} from "../src/lib/contentkey-consolidator";

// Kısa satır üreteci
function row(overrides: Partial<ConsolidatorRow> = {}): ConsolidatorRow {
    return {
        id: 1, contentKey: "ck1", macAdi: "A - B", tarih: "07.09.2026",
        saat: "16:00", salon: "SALON", createdAt: new Date("2026-09-01T00:00:00Z"),
        hakemler: [], masaGorevlileri: [], saglikcilar: [],
        istatistikciler: [], gozlemciler: [], sahaKomiserleri: [],
        ...overrides,
    };
}

function asg(overrides: Partial<ConsolidatorAssignment> = {}): ConsolidatorAssignment {
    return { id: 1, userId: 1, matchId: 1, nameInSpreadsheet: "AHMET YILMAZ", ...overrides };
}

// assignmentsByRowId Map'i kurmak için kısayol
function byRow(...entries: [number, ConsolidatorAssignment[]][]): Map<number, ConsolidatorAssignment[]> {
    return new Map(entries);
}

describe("planConsolidation", () => {
    test("tek satırlı grup → plan üretilmez", () => {
        const plans = planConsolidation(
            [row({ id: 10, contentKey: "ck1", hakemler: ["AHMET YILMAZ"] })],
            byRow([10, [asg({ id: 1, matchId: 10 })]]),
        );
        assert.equal(plans.length, 0);
    });

    test("iki satır, kişi kanonik (en dolu) kadroda → MOVE", () => {
        const rows = [
            row({ id: 10, contentKey: "ck1", createdAt: new Date("2026-09-01"), hakemler: ["AHMET YILMAZ"] }),          // 1 kişi
            row({ id: 11, contentKey: "ck1", createdAt: new Date("2026-09-02"), hakemler: ["AHMET YILMAZ", "MEHMET KAYA"] }), // 2 kişi → kanonik
        ];
        const plans = planConsolidation(rows, byRow(
            [10, [asg({ id: 1, userId: 1, matchId: 10, nameInSpreadsheet: "AHMET YILMAZ" })]],
            [11, []],
        ));
        assert.equal(plans.length, 1);
        assert.equal(plans[0].canonicalRowId, 11);
        assert.equal(plans[0].moves.length, 1);
        assert.equal(plans[0].moves[0].action, "MOVE");
        assert.equal(plans[0].moves[0].fromRowId, 10);
        assert.equal(plans[0].ambiguous.length, 0);
    });

    test("kadro sayısı eşit → createdAt en yeni kanonik", () => {
        const rows = [
            row({ id: 10, contentKey: "ck1", createdAt: new Date("2026-09-01"), hakemler: ["AHMET YILMAZ"] }),
            row({ id: 11, contentKey: "ck1", createdAt: new Date("2026-09-05"), hakemler: ["AHMET YILMAZ"] }),
        ];
        const plans = planConsolidation(rows, byRow(
            [10, [asg({ id: 1, userId: 1, matchId: 10, nameInSpreadsheet: "AHMET YILMAZ" })]],
            [11, []],
        ));
        assert.equal(plans[0].canonicalRowId, 11);
        assert.equal(plans[0].moves[0].action, "MOVE");
    });

    test("kullanıcının kanonikte zaten ataması var → DELETE_DUPE", () => {
        const rows = [
            row({ id: 10, contentKey: "ck1", createdAt: new Date("2026-09-01"), hakemler: ["AHMET YILMAZ"] }),
            row({ id: 11, contentKey: "ck1", createdAt: new Date("2026-09-02"), hakemler: ["AHMET YILMAZ", "MEHMET KAYA"] }),
        ];
        const plans = planConsolidation(rows, byRow(
            [10, [asg({ id: 1, userId: 1, matchId: 10, nameInSpreadsheet: "AHMET YILMAZ" })]],
            [11, [asg({ id: 2, userId: 1, matchId: 11, nameInSpreadsheet: "AHMET YILMAZ" })]],
        ));
        assert.equal(plans[0].moves.length, 1);
        assert.equal(plans[0].moves[0].action, "DELETE_DUPE");
        assert.equal(plans[0].moves[0].assignmentId, 1); // kanonik-dışı olan silinir
    });

    test("kişi kanonikte YOK ama başka aktif kardeşte var → DELETE_ON_SIBLING", () => {
        const rows = [
            row({ id: 10, contentKey: "ck1", createdAt: new Date("2026-09-01"), hakemler: ["ESKI KISI"] }),
            row({ id: 11, contentKey: "ck1", createdAt: new Date("2026-09-02"), hakemler: ["ESKI KISI", "X"] }), // kanonik ama AHMET yok
            row({ id: 12, contentKey: "ck1", createdAt: new Date("2026-09-01"), hakemler: ["AHMET YILMAZ"] }),   // kardeşte AHMET var
        ];
        const plans = planConsolidation(rows, byRow(
            [10, [asg({ id: 1, userId: 1, matchId: 10, nameInSpreadsheet: "AHMET YILMAZ" })]],
            [11, []],
            [12, []],
        ));
        const mv = plans[0].moves.find(m => m.assignmentId === 1)!;
        assert.equal(mv.action, "DELETE_ON_SIBLING");
    });

    test("kişi HİÇBİR aktif kardeşte yok → ambiguous (otomatik akış dokunmaz)", () => {
        const rows = [
            row({ id: 10, contentKey: "ck1", createdAt: new Date("2026-09-01"), hakemler: ["AHMET YILMAZ"] }),
            row({ id: 11, contentKey: "ck1", createdAt: new Date("2026-09-02"), hakemler: ["BASKA BIRI", "IKINCI"] }), // kanonik, AHMET yok
        ];
        const plans = planConsolidation(rows, byRow(
            [10, [asg({ id: 1, userId: 1, matchId: 10, nameInSpreadsheet: "AHMET YILMAZ" })]],
            [11, []],
        ));
        assert.equal(plans[0].moves.length, 0);
        assert.equal(plans[0].ambiguous.length, 1);
        assert.equal(plans[0].ambiguous[0].assignmentId, 1);
    });

    test("kanonik satırdaki atamalar hiç plan'a girmez (dokunulmaz)", () => {
        const rows = [
            row({ id: 10, contentKey: "ck1", createdAt: new Date("2026-09-01"), hakemler: ["A"] }),
            row({ id: 11, contentKey: "ck1", createdAt: new Date("2026-09-02"), hakemler: ["A", "B"] }), // kanonik
        ];
        const plans = planConsolidation(rows, byRow(
            [10, []],
            [11, [asg({ id: 5, userId: 5, matchId: 11, nameInSpreadsheet: "A" })]],
        ));
        // Sadece kanonikte atama var, kanonik-dışı boş → yapılacak bir şey yok
        assert.equal(plans.length, 0);
    });

    test("farklı contentKey'ler karışmaz", () => {
        const rows = [
            row({ id: 10, contentKey: "ckA", createdAt: new Date("2026-09-01"), hakemler: ["A"] }),
            row({ id: 11, contentKey: "ckA", createdAt: new Date("2026-09-02"), hakemler: ["A", "B"] }),
            row({ id: 20, contentKey: "ckB", createdAt: new Date("2026-09-01"), hakemler: ["C"] }),
        ];
        const plans = planConsolidation(rows, byRow(
            [10, [asg({ id: 1, userId: 1, matchId: 10, nameInSpreadsheet: "A" })]],
            [11, []],
            [20, [asg({ id: 2, userId: 2, matchId: 20, nameInSpreadsheet: "C" })]],
        ));
        assert.equal(plans.length, 1);
        assert.equal(plans[0].contentKey, "ckA");
    });

    test("fuzzy isim eşleşmesi (isim sırası) → MOVE", () => {
        const rows = [
            row({ id: 10, contentKey: "ck1", createdAt: new Date("2026-09-01"), hakemler: ["EFE CAN BAYRAK"] }),
            row({ id: 11, contentKey: "ck1", createdAt: new Date("2026-09-02"), hakemler: ["BAYRAK EFE CAN", "DIGER KISI"] }), // kanonik, sıra farklı
        ];
        const plans = planConsolidation(rows, byRow(
            [10, [asg({ id: 1, userId: 1, matchId: 10, nameInSpreadsheet: "EFE CAN BAYRAK", firstName: "Efe Can", lastName: "Bayrak" })]],
            [11, []],
        ));
        assert.equal(plans[0].moves[0].action, "MOVE");
    });
});
