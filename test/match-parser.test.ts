import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { nameMatches } from "../src/lib/match-parser";

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
