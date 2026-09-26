import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { nameMatches, fuzzyNameMatch } from "../src/lib/match-parser";

describe("nameMatches", () => {
    test("tam eşleşen ad-soyad true döner", () => {
        assert.equal(nameMatches("Ali Veli", "Ali", "Veli"), true);
    });

    test("ad-soyad sırası ters olsa da eşleşir", () => {
        assert.equal(nameMatches("Veli Ali", "Ali", "Veli"), true);
    });

    test("büyük Türkçe karakterler küçük harfe normalize edilerek eşleşir", () => {
        assert.equal(nameMatches("ŞÜKRÜ ÖZTÜRK", "şükrü", "öztürk"), true);
    });

    test("tek harflik yazım hatası (Levenshtein ≤ 1, yeterince uzun kelimede) eşleşir", () => {
        assert.equal(nameMatches("Ahmet Yilmaz", "Ahmet", "Yılmaz"), true);
    });

    test("soyad tamamen farklıysa eşleşmez", () => {
        assert.equal(nameMatches("Ali Kaya", "Ali", "Veli"), false);
    });

    test("boş hücre adı için false döner", () => {
        assert.equal(nameMatches("", "Ali", "Veli"), false);
    });

    test("3 karakterden kısa hücre adı için false döner", () => {
        assert.equal(nameMatches("Al", "Ali", "Veli"), false);
    });

    test("firstName veya lastName boşsa false döner", () => {
        assert.equal(nameMatches("Ali Veli", "", "Veli"), false);
        assert.equal(nameMatches("Ali Veli", "Ali", ""), false);
    });
});

describe("fuzzyNameMatch", () => {
    test("gerçek vaka: birleşik ad (GENÇOSMAN) boşluklu profil adıyla (GENÇ OSMAN) eşleşir", () => {
        assert.equal(fuzzyNameMatch("GENÇOSMAN KOCAEREN", "GENÇ OSMAN", "KOCAEREN"), true);
    });

    test("nameMatches'in kelime-uzunluk farkı yüzünden elediği durumu fuzzyNameMatch yakalar", () => {
        assert.equal(nameMatches("GENÇOSMAN KOCAEREN", "GENÇ OSMAN", "KOCAEREN"), false);
    });

    test("tek harflik yazım hatası (17 harfte 1 hata, ~%94 benzerlik) eşleşir", () => {
        assert.equal(fuzzyNameMatch("Ahmet Kocaereen", "Ahmet", "Kocaeren"), true);
    });

    test("farklı iki kişi eşiğin altında kalır, eşleşmez", () => {
        assert.equal(fuzzyNameMatch("Mehmet Yıldız", "Ahmet", "Yıldırım"), false);
    });

    test("boş alanlar için false döner", () => {
        assert.equal(fuzzyNameMatch("", "Ali", "Veli"), false);
        assert.equal(fuzzyNameMatch("Ali Veli", "", "Veli"), false);
    });

    test("çok kısa isimlerde yükseltilmiş eşik uygulanır (kısa+farklı isim eşleşmez)", () => {
        assert.equal(fuzzyNameMatch("Ali Su", "Ali", "So"), false);
    });
});
