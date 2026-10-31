import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    formatDayTR, formatTime, matchDetailLines, assignedText, cancelledText, changedText, updatedText,
} from "../src/lib/notification-text";
import { MatchData } from "../src/lib/match-parser";

function md(overrides: Partial<MatchData> = {}): MatchData {
    return {
        mac_adi: "FENERBAHÇE (A) - ANADOLU EFES", tarih: "01.11.2026", saat: "14.00", salon: "ÜLKER SALONU",
        kategori: "U14EB", ligTuru: "Yerel Lig",
        hakemler: ["ALİ VELİ", "CAN ER"], masa_gorevlileri: ["M1", "M2", "M3"], saglikcilar: [],
        istatistikciler: [], gozlemciler: ["G1"], sahaKomiserleri: [],
        kaynak_dosya: "test", ...overrides,
    };
}

describe("formatDayTR / formatTime", () => {
    test("tarih gün adıyla", () => {
        assert.equal(formatDayTR("01.11.2026"), "1 Kasım Pazar");
        assert.equal(formatDayTR("31.10.2026"), "31 Ekim Cumartesi");
    });
    test("okunamayan tarih aynen döner", () => {
        assert.equal(formatDayTR("TARİHSİZ"), "TARİHSİZ");
    });
    test("saat biçimi", () => {
        assert.equal(formatTime("12.00"), "12:00");
        assert.equal(formatTime("9:30"), "09:30");
        assert.equal(formatTime(undefined), "");
    });
});

describe("bildirim metinleri", () => {
    test("maç detayı tüm bilgileri alt alta verir", () => {
        assert.deepEqual(matchDetailLines(md()), [
            "🏀 FENERBAHÇE (A) - ANADOLU EFES",
            "🏷️ Yerel Lig · U14EB",
            "📅 1 Kasım Pazar · ⏰ 14:00",
            "🏟️ ÜLKER SALONU",
            "",
            "👥 Görevliler",
            "• Baş Hakem: ALİ VELİ",
            "• Yardımcı Hakem: CAN ER",
            "• Sayı Görevlisi: M1",
            "• Saat Görevlisi: M2",
            "• Şut Saati Görevlisi: M3",
            "• Gözlemci: G1",
        ]);
    });

    test("Atama: zil başlığı, ilk satırda takım adı yok", () => {
        const t = assignedText(md());
        assert.equal(t.title, "🔔 Maç Atamanız Geldi!");
        assert.equal(t.body.split("\n")[0], "📅 1 Kasım Pazar · ⏰ 14:00 — Detaylar için dokunun 👉");
        assert.ok(!t.title.includes("FENERBAHÇE"));
    });

    test("İptal: görevli listesi yok", () => {
        const t = cancelledText(md());
        assert.equal(t.title, "❌ Maç Atamanız İptal Edildi");
        assert.equal(t.body.split("\n")[0], "📅 1 Kasım Pazar · ⏰ 14:00 maçındaki göreviniz kaldırıldı.");
        assert.ok(!t.body.includes("Görevliler"));
    });

    test("Değişiklik: yeni maç önde, eski maç sonda", () => {
        const t = changedText(md({ mac_adi: "ESKİ - MAÇ", saat: "10:00" }), md());
        assert.equal(t.title, "🔄 Atamanızda Değişiklik Var");
        assert.equal(t.body.split("\n")[0], "Eski maçınız kaldırıldı, yeni maçınız: 📅 1 Kasım Pazar ⏰ 14:00 🏀");
        assert.ok(t.body.endsWith("❌ Eski maç: ESKİ - MAÇ · 📅 1 Kasım Pazar · ⏰ 10:00"));
    });

    test("Güncellendi: önce değişiklik satırları", () => {
        const t = updatedText(md(), ["🔁 Baş Hakem: X yerine ALİ VELİ geldi"]);
        assert.equal(t.title, "📝 Maçınız Güncellendi");
        assert.equal(t.body.split("\n")[0], "🔁 Baş Hakem: X yerine ALİ VELİ geldi");
    });
});
