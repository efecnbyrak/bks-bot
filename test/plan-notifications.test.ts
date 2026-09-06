import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planNotifications } from "../src/change-notifier";
import { MatchData } from "../src/lib/match-parser";
import { NewAssignmentInfo } from "../src/user-matcher";

function md(overrides: Partial<MatchData> = {}): MatchData {
    return {
        mac_adi: "A - B", tarih: "07.09.2026", saat: "16:00", salon: "SALON",
        kategori: "U14", ligTuru: "Yerel Lig",
        hakemler: [], masa_gorevlileri: [], saglikcilar: [],
        istatistikciler: [], gozlemciler: [], sahaKomiserleri: [],
        kaynak_dosya: "test", ...overrides,
    };
}
function newAsg(o: Partial<NewAssignmentInfo> & { userId: number }): NewAssignmentInfo {
    return {
        matchId: 1, macAdi: "A - B", tarih: "07.09.2026", contentKey: "ck1",
        matchData: md(), ...o,
    };
}

describe("planNotifications", () => {
    test("ROW_SHIFTED → 'UPDATED' bildirimi, 'ASSIGNED' DEĞİL", () => {
        const { notifications } = planNotifications({
            newAssignments: [newAsg({ userId: 1, contentKey: "ck1" })], // aynı kullanıcı yeni satıra da atandı
            cancellations: [],
            shifted: [{
                userId: 1, macAdi: "A - B", tarih: "07.09.2026", contentKey: "ck1",
                oldMatchData: md({ masa_gorevlileri: ["AHMET"] }),
                newMatchData: md({ masa_gorevlileri: ["AHMET"], hakemler: ["X", "Y"] }),
            }],
        });
        const n = notifications.find(x => x.userId === 1)!;
        assert.equal(n.kind, "UPDATED");
        assert.ok(n.changeSummary);
        // Aynı kullanıcı için ikinci bir bildirim OLMAMALI
        assert.equal(notifications.filter(x => x.userId === 1).length, 1);
    });

    test("iptal + AYNI contentKey'de yeni atama → 'UPDATED' (değişti değil)", () => {
        const { notifications, realCancellationGroups } = planNotifications({
            newAssignments: [newAsg({ userId: 5, contentKey: "ckSAME", macAdi: "A - B" })],
            cancellations: [{
                matchId: 10, matchKey: "", contentKey: "ckSAME",
                macAdi: "A - B", tarih: "07.09.2026", affectedUserIds: [5],
            }],
            shifted: [],
        });
        assert.equal(notifications.find(x => x.userId === 5)!.kind, "UPDATED");
        assert.equal(realCancellationGroups.length, 0);
    });

    test("iptal + FARKLI contentKey'de yeni atama → 'CHANGED'", () => {
        const { notifications } = planNotifications({
            newAssignments: [newAsg({ userId: 5, contentKey: "ckNEW", macAdi: "C - D" })],
            cancellations: [{
                matchId: 10, matchKey: "", contentKey: "ckOLD",
                macAdi: "A - B", tarih: "07.09.2026", affectedUserIds: [5],
            }],
            shifted: [],
        });
        const n = notifications.find(x => x.userId === 5)!;
        assert.equal(n.kind, "CHANGED");
        assert.equal(n.oldMacAdi, "A - B");
        assert.equal(n.newMacAdi, "C - D");
    });

    test("sadece iptal → realCancellationGroups'a gider, notifications'da yok", () => {
        const { notifications, realCancellationGroups } = planNotifications({
            newAssignments: [],
            cancellations: [{
                matchId: 10, matchKey: "", contentKey: "ck1",
                macAdi: "A - B", tarih: "07.09.2026", affectedUserIds: [7, 8],
            }],
            shifted: [],
        });
        assert.equal(notifications.length, 0);
        assert.equal(realCancellationGroups.length, 1);
        assert.deepEqual(realCancellationGroups[0].userIds.sort(), [7, 8]);
    });

    test("sadece yeni atama → 'ASSIGNED'", () => {
        const { notifications } = planNotifications({
            newAssignments: [newAsg({ userId: 9, contentKey: "ckX" })],
            cancellations: [],
            shifted: [],
        });
        assert.equal(notifications.find(x => x.userId === 9)!.kind, "ASSIGNED");
    });

    test("aynı maçtan çıkan birden fazla kullanıcı tek grupta toplanır", () => {
        const { realCancellationGroups } = planNotifications({
            newAssignments: [],
            cancellations: [
                { matchId: 1, matchKey: "", contentKey: "a", macAdi: "M", tarih: "T", affectedUserIds: [1, 2] },
                { matchId: 2, matchKey: "", contentKey: "b", macAdi: "M", tarih: "T", affectedUserIds: [3] },
            ],
            shifted: [],
        });
        assert.equal(realCancellationGroups.length, 1);
        assert.equal(realCancellationGroups[0].userIds.length, 3);
    });
});
