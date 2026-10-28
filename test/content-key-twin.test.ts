import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { contentKeyRaw } from "../src/db-writer";

// Web `lib/matches/__tests__/content-key-twin.test.ts` ile AYNI fixture listesi.
// Biri değişirse diğeri de değişmeli — iki taraf aynı ham anahtarı üretmek zorunda.
const CASES: Array<[{ mac_adi: string; tarih: string; saat: string; kaynak_satir?: number }, string]> = [
    [{ mac_adi: "  Takım  A -   Takım B ", tarih: "23.08.2026", saat: "18:00" }, "takım a - takım b|23.08.2026|18:00"],
    [{ mac_adi: "Takım A - Takım B", tarih: "23.08.2026", saat: "18:00", kaynak_satir: 7 }, "takım a - takım b|23.08.2026|18:00"],
    [{ mac_adi: "3x3 - 3x3", tarih: "27.10.2026", saat: "09:00-17:00", kaynak_satir: 4 }, "3x3 - 3x3|27.10.2026|09:00-17:00|#4"],
    [{ mac_adi: " 3X3 - 3X3 ", tarih: "27.10.2026", saat: "10:00 -  14:30", kaynak_satir: 9 }, "3x3 - 3x3|27.10.2026|10:00 - 14:30|#9"],
    [{ mac_adi: "3x3 - 3x3", tarih: "03.10.2026", saat: "16:30-20:00" }, "3x3 - 3x3|03.10.2026|16:30-20:00"],
];

describe("contentKeyRaw (web ikizi)", () => {
    for (const [input, expected] of CASES) {
        test(JSON.stringify(input), () => assert.equal(contentKeyRaw(input), expected));
    }
});
