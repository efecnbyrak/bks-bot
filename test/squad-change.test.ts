import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { diffMatch } from "../src/lib/squad-change";
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

describe("diffMatch", () => {
    test("null girdi → değişiklik yok", () => {
        assert.deepEqual(diffMatch(null, md()), []);
    });

    test("boş yere ekleme (ilk dolum) → değişiklik SAYILMAZ", () => {
        const oldM = md({ hakemler: ["ALİ VELİ", "AYŞE KAYA"] });
        const newM = md({ hakemler: ["ALİ VELİ", "AYŞE KAYA"], gozlemciler: ["MEHMET DEMİR"], masa_gorevlileri: ["X Y"] });
        assert.deepEqual(diffMatch(oldM, newM), []);
    });

    test("yerine kimse yazılmadan çıkarma → değişiklik SAYILMAZ", () => {
        const oldM = md({ gozlemciler: ["MEHMET DEMİR"] });
        const newM = md({ gozlemciler: [] });
        assert.deepEqual(diffMatch(oldM, newM), []);
    });

    test("Baş Hakem değişti → 'A yerine B geldi'", () => {
        const oldM = md({ hakemler: ["ALİ VELİ", "AYŞE KAYA"] });
        const newM = md({ hakemler: ["CAN ER", "AYŞE KAYA"] });
        assert.deepEqual(diffMatch(oldM, newM), ["🔁 Baş Hakem: ALİ VELİ yerine CAN ER geldi"]);
    });

    test("masa ve gözlemci değişimi koltuk adıyla yazılır", () => {
        const oldM = md({ masa_gorevlileri: ["M1", "M2", "M3"], gozlemciler: ["G1"] });
        const newM = md({ masa_gorevlileri: ["M1", "YENİ", "M3"], gozlemciler: ["G2"] });
        assert.deepEqual(diffMatch(oldM, newM), [
            "🔁 Saat Görevlisi: M2 yerine YENİ geldi",
            "🔁 Gözlemci: G1 yerine G2 geldi",
        ]);
    });

    test("hakemler yer değiştirdi → koltuk satırları", () => {
        const oldM = md({ hakemler: ["ALİ", "CAN"] });
        const newM = md({ hakemler: ["CAN", "ALİ"] });
        assert.deepEqual(diffMatch(oldM, newM), ["🔁 Baş Hakem artık CAN", "🔁 Yardımcı Hakem artık ALİ"]);
    });

    test("tarih / saat / salon değişimi", () => {
        const oldM = md({ tarih: "01.11.2026", saat: "12.00", salon: "A SALONU" });
        const newM = md({ tarih: "02.11.2026", saat: "14:30", salon: "B SALONU" });
        assert.deepEqual(diffMatch(oldM, newM), [
            "📅 Tarih: 1 Kasım Pazar → 2 Kasım Pazartesi",
            "⏰ Saat: 12:00 → 14:30",
            "🏟️ Salon: A SALONU → B SALONU",
        ]);
    });

    test("salonun sonradan doldurulması ve saat yazım farkı değişiklik değildir", () => {
        const oldM = md({ salon: "", saat: "12.00" });
        const newM = md({ salon: "B SALONU", saat: "12:00" });
        assert.deepEqual(diffMatch(oldM, newM), []);
    });

    test("büyük/küçük harf ve boşluk farkı değişiklik değildir; '*' yer tutucusu isim sayılmaz", () => {
        const oldM = md({ hakemler: ["ALİ  VELİ", "*"] });
        const newM = md({ hakemler: ["Ali Veli", "-"] });
        assert.deepEqual(diffMatch(oldM, newM), []);
    });
    test("eksik grupta koltuk adı verilmez (boş hücre kayması): 'Hakem: A yerine B'", () => {
        // Baş Hakem hücresi boş, sadece Yardımcı dolu → liste tek isim, sıra güvenilmez
        const oldM = md({ hakemler: ["ALİ"], masa_gorevlileri: ["M1", "M2"] });
        const newM = md({ hakemler: ["CAN"], masa_gorevlileri: ["M1", "YENİ"] });
        assert.deepEqual(diffMatch(oldM, newM), [
            "🔁 Hakem: ALİ yerine CAN geldi",
            "🔁 Masa Görevlisi: M2 yerine YENİ geldi",
        ]);
    });

    test("ilk dolum: Yardımcı önce yazılmış, Baş Hakem sonradan geldi → bildirim YOK", () => {
        const oldM = md({ hakemler: ["CAN"] });
        const newM = md({ hakemler: ["ALİ", "CAN"] });
        assert.deepEqual(diffMatch(oldM, newM), []);
    });
});
