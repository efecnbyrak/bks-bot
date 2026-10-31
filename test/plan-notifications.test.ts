import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planNotifications, filterFutureEvents } from "../src/change-notifier";
import { CancelledMatchInfo } from "../src/db-writer";
import { MatchData } from "../src/lib/match-parser";
import { NewAssignmentInfo } from "../src/user-matcher";

function md(overrides: Partial<MatchData> = {}): MatchData {
    return {
        mac_adi: "A - B", tarih: "07.09.2099", saat: "16:00", salon: "SALON",
        kategori: "U14", ligTuru: "Yerel Lig",
        hakemler: [], masa_gorevlileri: [], saglikcilar: [],
        istatistikciler: [], gozlemciler: [], sahaKomiserleri: [],
        kaynak_dosya: "test", ...overrides,
    };
}
function newAsg(o: { userId: number; contentKey?: string; match?: MatchData }): NewAssignmentInfo {
    const m = o.match ?? md();
    return {
        userId: o.userId, matchId: 1, macAdi: m.mac_adi, tarih: m.tarih, saat: m.saat,
        contentKey: o.contentKey ?? "ck1", matchData: m,
    };
}
function cancel(o: { userIds: number[]; contentKey?: string; match?: MatchData }): CancelledMatchInfo {
    const m = o.match ?? md();
    return {
        matchId: 10, matchKey: "", contentKey: o.contentKey ?? "ck1",
        macAdi: m.mac_adi, tarih: m.tarih, saat: m.saat, affectedUserIds: o.userIds, matchData: m,
    };
}

describe("planNotifications", () => {
    test("kadroda 'A yerine B' → maçta kalan herkese UPDATED, yeni gelene ASSIGNED", () => {
        const oldM = md({ hakemler: ["ALİ", "CAN"], gozlemciler: ["G1"] });
        const newM = md({ hakemler: ["DENİZ", "CAN"], gozlemciler: ["G1"] });
        const out = planNotifications({
            newAssignments: [newAsg({ userId: 3, match: newM })], // DENİZ
            cancellations: [cancel({ userIds: [1], match: oldM })], // ALİ
            shifted: [2, 4].map(userId => ({
                userId, macAdi: "A - B", tarih: "07.09.2099", saat: "16:00", contentKey: "ck1",
                oldMatchData: oldM, newMatchData: newM,
            })),
        });
        const byUser = (u: number) => out.filter(n => n.userId === u).map(n => n.kind);
        assert.deepEqual(byUser(1), ["CANCELLED"]);
        assert.deepEqual(byUser(2), ["UPDATED"]);
        assert.deepEqual(byUser(4), ["UPDATED"]);
        assert.deepEqual(byUser(3), ["ASSIGNED"]);
        assert.deepEqual(out.find(n => n.userId === 2)!.changeLines, ["🔁 Baş Hakem: ALİ yerine DENİZ geldi"]);
    });

    test("ilk dolum: hakemler yazılıydı, gözlemci eklendi → hakemlere bildirim YOK", () => {
        const oldM = md({ hakemler: ["ALİ", "CAN"] });
        const newM = md({ hakemler: ["ALİ", "CAN"], gozlemciler: ["G1"] });
        const out = planNotifications({
            newAssignments: [newAsg({ userId: 9, match: newM })],
            cancellations: [],
            shifted: [{ userId: 1, macAdi: "A - B", tarih: "07.09.2099", contentKey: "ck1", oldMatchData: oldM, newMatchData: newM }],
        });
        assert.deepEqual(out.map(n => [n.userId, n.kind]), [[9, "ASSIGNED"]]);
    });

    test("aynı turda iptal + AYNI maça geri yazılma, kadro aynı → hiç bildirim YOK", () => {
        const out = planNotifications({
            newAssignments: [newAsg({ userId: 5 })],
            cancellations: [cancel({ userIds: [5] })],
            shifted: [],
        });
        assert.equal(out.length, 0);
    });

    test("aynı takımlar, tarih değişti → UPDATED (Değişiklik değil)", () => {
        const oldM = md({ tarih: "07.09.2099" });
        const newM = md({ tarih: "08.09.2099" });
        const out = planNotifications({
            newAssignments: [newAsg({ userId: 5, contentKey: "ckNEW", match: newM })],
            cancellations: [cancel({ userIds: [5], contentKey: "ckOLD", match: oldM })],
            shifted: [],
        });
        assert.equal(out.length, 1);
        assert.equal(out[0].kind, "UPDATED");
        assert.equal(out[0].changeLines![0], "📅 Tarih: 7 Eylül Pazartesi → 8 Eylül Salı");
    });

    test("aynı gün başka maça kaydırıldı → CHANGED", () => {
        const out = planNotifications({
            newAssignments: [newAsg({ userId: 5, contentKey: "ckNEW", match: md({ mac_adi: "C - D", saat: "18:00" }) })],
            cancellations: [cancel({ userIds: [5], contentKey: "ckOLD" })],
            shifted: [],
        });
        assert.equal(out.length, 1);
        assert.equal(out[0].kind, "CHANGED");
        assert.equal(out[0].oldMatch!.mac_adi, "A - B");
        assert.equal(out[0].match.mac_adi, "C - D");
    });

    test("farklı günlerde iptal + atama → ayrı CANCELLED ve ASSIGNED", () => {
        const out = planNotifications({
            newAssignments: [newAsg({ userId: 5, contentKey: "ckNEW", match: md({ mac_adi: "C - D", tarih: "10.09.2099" }) })],
            cancellations: [cancel({ userIds: [5], contentKey: "ckOLD" })],
            shifted: [],
        });
        assert.deepEqual(out.map(n => n.kind).sort(), ["ASSIGNED", "CANCELLED"]);
    });

    test("aynı turda iki yeni maça atanan kişi İKİ bildirim alır (eskiden tek)", () => {
        const out = planNotifications({
            newAssignments: [
                newAsg({ userId: 7, contentKey: "a", match: md({ mac_adi: "A - B" }) }),
                newAsg({ userId: 7, contentKey: "b", match: md({ mac_adi: "C - D", tarih: "09.09.2099" }) }),
            ],
            cancellations: [],
            shifted: [],
        });
        assert.equal(out.filter(n => n.userId === 7 && n.kind === "ASSIGNED").length, 2);
    });

    test("aynı olay iki kez gelse de tek bildirim", () => {
        const out = planNotifications({
            newAssignments: [newAsg({ userId: 7 }), newAsg({ userId: 7 })],
            cancellations: [],
            shifted: [],
        });
        assert.equal(out.length, 1);
    });

    test("oynanmış (geçmiş tarihli) maç dosyadan kalkınca bildirim YOK", () => {
        const past = md({ tarih: "01.01.2020" });
        const out = planNotifications({
            newAssignments: [],
            cancellations: [cancel({ userIds: [1], match: past })],
            shifted: [],
        });
        assert.equal(out.length, 0);
    });

    test("bugün başlamış maç da geçmiş sayılır", () => {
        const now = new Date("2099-09-07T14:00:00Z"); // 17:00 TRT, maç 16:00'da başladı
        const f = filterFutureEvents({ newAssignments: [], cancellations: [cancel({ userIds: [1] })], shifted: [] }, now);
        assert.equal(f.cancellations.length, 0);
    });
});
