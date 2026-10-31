import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolvePending } from "../src/notification-outbox";
import { planWithPending, PlannedNotification } from "../src/change-notifier";
import { MatchData } from "../src/lib/match-parser";
import { NewAssignmentInfo } from "../src/user-matcher";

function md(overrides: Partial<MatchData> = {}): MatchData {
    return {
        mac_adi: "A - B", tarih: "07.09.2099", saat: "16:00", salon: "SALON",
        kategori: "U14", ligTuru: "Yerel Lig",
        hakemler: ["ALİ", "CAN"], masa_gorevlileri: [], saglikcilar: [],
        istatistikciler: [], gozlemciler: ["G1"], sahaKomiserleri: [],
        kaynak_dosya: "test", ...overrides,
    };
}
const NOW = new Date("2099-09-01T10:00:00Z");

describe("resolvePending — teyit anında karar", () => {
    const cancelRow = { kind: "CANCELLED" as const, payload: { kind: "CANCELLED", userId: 1, contentKey: "ck", match: md() } as PlannedNotification };

    test("İPTAL: kişi maça geri yazıldıysa düşer (29 Ekim yarım düzenleme senaryosu)", () => {
        const r = resolvePending(cancelRow, { userMatch: md(), userInOldMatch: false }, NOW);
        assert.equal(r.action, "drop");
    });

    test("İPTAL: kişi hâlâ yoksa gönderilir", () => {
        const r = resolvePending(cancelRow, { userMatch: null, userInOldMatch: false }, NOW);
        assert.equal(r.action, "send");
    });

    test("İPTAL: teyit anında maç başlamışsa düşer", () => {
        const r = resolvePending(cancelRow, { userMatch: null, userInOldMatch: false }, new Date("2099-09-07T14:00:00Z"));
        assert.equal(r.action, "drop");
    });

    const updatedRow = (oldMatch: MatchData) => ({
        kind: "UPDATED" as const,
        payload: { kind: "UPDATED", userId: 2, contentKey: "ck", match: md(), oldMatch, changeLines: ["eski satır"] } as PlannedNotification,
    });

    test("GÜNCELLENDİ: fark tabandan güncel satıra yeniden hesaplanır", () => {
        const r = resolvePending(updatedRow(md({ hakemler: ["X", "CAN"] })), { userMatch: md(), userInOldMatch: false }, NOW);
        assert.equal(r.action, "send");
        if (r.action === "send") assert.deepEqual(r.notification.changeLines, ["🔁 Baş Hakem: X yerine ALİ geldi"]);
    });

    test("GÜNCELLENDİ: düzenleme geri alındıysa (net fark yok) düşer", () => {
        const r = resolvePending(updatedRow(md()), { userMatch: md(), userInOldMatch: false }, NOW);
        assert.equal(r.action, "drop");
    });

    test("GÜNCELLENDİ: kişi artık maçta değilse düşer (ona ayrıca İptal gider)", () => {
        const r = resolvePending(updatedRow(md({ hakemler: ["X", "CAN"] })), { userMatch: null, userInOldMatch: false }, NOW);
        assert.equal(r.action, "drop");
    });

    const changedRow = {
        kind: "CHANGED" as const,
        payload: {
            kind: "CHANGED", userId: 3, contentKey: "new", oldContentKey: "old",
            match: md({ mac_adi: "C - D" }), oldMatch: md(),
        } as PlannedNotification,
    };

    test("DEĞİŞİKLİK: kişi yeni maçta, eski maçta değil → gönderilir", () => {
        assert.equal(resolvePending(changedRow, { userMatch: md({ mac_adi: "C - D" }), userInOldMatch: false }, NOW).action, "send");
    });

    test("DEĞİŞİKLİK: kişi eski maça geri döndüyse düşer", () => {
        assert.equal(resolvePending(changedRow, { userMatch: md({ mac_adi: "C - D" }), userInOldMatch: true }, NOW).action, "drop");
    });

    test("DEĞİŞİKLİK: yeni maçtan da çıkarıldıysa eski maç için düz İPTAL'e iner", () => {
        const r = resolvePending(changedRow, { userMatch: null, userInOldMatch: false }, NOW);
        assert.equal(r.action, "send");
        if (r.action === "send") {
            assert.equal(r.notification.kind, "CANCELLED");
            assert.equal(r.notification.contentKey, "old");
        }
    });
});

describe("planWithPending — bekleyen iptal + bu turun ataması", () => {
    const asg = (o: { userId: number; contentKey: string; match: MatchData }): NewAssignmentInfo => ({
        userId: o.userId, matchId: 1, macAdi: o.match.mac_adi, tarih: o.match.tarih, saat: o.match.saat,
        contentKey: o.contentKey, matchData: o.match,
    });

    test("29 Ekim: iptal kuyrukta bekliyor, kişi aynı maça geri yazıldı → bildirim YOK, iptal düşer", () => {
        const r = planWithPending(
            { newAssignments: [asg({ userId: 410, contentKey: "ck", match: md() })], cancellations: [], shifted: [] },
            [{ id: 77, userId: 410, contentKey: "ck", match: md() }],
            NOW,
        );
        assert.equal(r.notifications.length, 0);
        assert.deepEqual(r.consumedPendingIds, [77]);
    });

    test("bekleyen iptal + aynı gün başka maç → DEĞİŞİKLİK, iptal düşer", () => {
        const r = planWithPending(
            { newAssignments: [asg({ userId: 5, contentKey: "new", match: md({ mac_adi: "C - D", saat: "19:00" }) })], cancellations: [], shifted: [] },
            [{ id: 9, userId: 5, contentKey: "old", match: md() }],
            NOW,
        );
        assert.deepEqual(r.notifications.map(n => n.kind), ["CHANGED"]);
        assert.deepEqual(r.consumedPendingIds, [9]);
    });

    test("eşleşmeyen bekleyen iptal tekrar plana girmez, kuyrukta kalır", () => {
        const r = planWithPending(
            { newAssignments: [asg({ userId: 5, contentKey: "new", match: md({ mac_adi: "C - D", tarih: "12.09.2099" }) })], cancellations: [], shifted: [] },
            [{ id: 9, userId: 5, contentKey: "old", match: md() }],
            NOW,
        );
        assert.deepEqual(r.notifications.map(n => n.kind), ["ASSIGNED"]);
        assert.deepEqual(r.consumedPendingIds, []);
    });
});
