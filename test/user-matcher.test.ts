import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { detectRole, resolveFuzzyCandidate, buildUserAssignments, UserProfile } from "../src/user-matcher";
import { db } from "../src/db";
import { MatchData } from "../src/lib/match-parser";

// user-matcher.ts, DRY_RUN sabitini modül yüklenirken bir kez okuyor (db-writer.ts'teki
// pattern ile aynı) — bu yüzden NOTIFY_DRY_RUN'ı test içinde set edip modülü require
// cache'inden atıp yeniden yüklüyoruz ki sabit doğru değerle yeniden hesaplansın.
function loadUserMatcherFresh(): typeof import("../src/user-matcher") {
    const modPath = require.resolve("../src/user-matcher");
    delete require.cache[modPath];
    return require("../src/user-matcher");
}

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

describe("resolveFuzzyCandidate", () => {
    function makeUser(overrides: Partial<UserProfile>): UserProfile {
        return { userId: 1, firstName: "Ali", lastName: "Veli", ...overrides };
    }

    test("tek net aday varsa onu döner", () => {
        const users = [
            makeUser({ userId: 412, firstName: "GENÇ OSMAN", lastName: "KOCAEREN" }),
            makeUser({ userId: 2, firstName: "Ayşe", lastName: "Yılmaz" }),
        ];
        const result = resolveFuzzyCandidate("GENÇOSMAN KOCAEREN", users);
        assert.equal(result?.userId, 412);
    });

    test("eşiği geçen aday yoksa null döner", () => {
        const users = [makeUser({ userId: 1, firstName: "Ayşe", lastName: "Yılmaz" })];
        const result = resolveFuzzyCandidate("Bambaşka Biri", users);
        assert.equal(result, null);
    });

    test("iki aday birbirine çok yakınsa (belirsiz) null döner", () => {
        const users = [
            makeUser({ userId: 1, firstName: "Mehmet", lastName: "Kocaeran" }),
            makeUser({ userId: 2, firstName: "Mehmet", lastName: "Kocaerin" }),
        ];
        const result = resolveFuzzyCandidate("Mehmet Kocaeren", users);
        assert.equal(result, null);
    });
});

describe("buildUserAssignments DRY_RUN", () => {
    const matches: MatchData[] = [{
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
    }];
    const matchIds = [101];

    // node:test'in t.mock.method()'ı burada çalışmıyor: Prisma model delegate'leri
    // (db.referee, db.userMatchAssignment, ...) gerçek metodu bir Proxy get-trap'i
    // ile dinamik üretiyor, own-property descriptor'ı ise "value: undefined" dönüyor —
    // mock.method bunu "metot değil" sayıp hata veriyor. Orijinal referansı saklayıp
    // elle atayıp t.after() ile geri yükleyerek aynı sonucu elde ediyoruz.
    function stubMethod<T extends object, K extends keyof T>(t: import("node:test").TestContext, obj: T, key: K, impl: T[K]) {
        const original = obj[key];
        obj[key] = impl;
        t.after(() => { obj[key] = original; });
    }

    function mockDbForAssignment(t: import("node:test").TestContext) {
        stubMethod(t, db.referee, "findMany", (async () => [
            { userId: 1, firstName: "Ali", lastName: "Veli" },
        ]) as typeof db.referee.findMany);
        stubMethod(t, db.generalOfficial, "findMany", (async () => []) as typeof db.generalOfficial.findMany);
        stubMethod(t, db.userMatchAssignment, "findMany", (async () => []) as typeof db.userMatchAssignment.findMany);
        const upsertMock = mock.fn(async () => ({}));
        stubMethod(t, db.userMatchAssignment, "upsert", upsertMock as unknown as typeof db.userMatchAssignment.upsert);
        return upsertMock;
    }

    test("NOTIFY_DRY_RUN=1 iken upsert hiç çağrılmaz ama assignmentCount aynı hesaplanır", async (t) => {
        const upsertMock = mockDbForAssignment(t);

        process.env.NOTIFY_DRY_RUN = "1";
        const freshModule = loadUserMatcherFresh();
        let result: { assignmentCount: number; newAssignments: unknown[] };
        try {
            result = await freshModule.buildUserAssignments(matches, matchIds);
        } finally {
            delete process.env.NOTIFY_DRY_RUN;
            loadUserMatcherFresh(); // sonraki testler için DRY_RUN=false ile yeniden yükle
        }

        assert.equal(upsertMock.mock.calls.length, 0);
        assert.equal(result.assignmentCount, 1);
    });

    test("NOTIFY_DRY_RUN=0 (varsayılan) iken upsert normal şekilde çağrılır", async (t) => {
        const upsertMock = mockDbForAssignment(t);

        const result = await buildUserAssignments(matches, matchIds);

        assert.equal(upsertMock.mock.calls.length, 1);
        assert.equal(result.assignmentCount, 1);
    });
});
