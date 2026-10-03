# CLAUDE.md

Bu dosya, bu repoda çalışırken Claude Code'a (claude.ai/code) rehberlik eder.

## Proje Özeti

**BKS-BOT** — Google Sheets/Drive'dan maç verisi çeken, ayrıştırıp veritabanına yazan ve
maç atama/iptal/değişikliklerinde ilgili kullanıcılara push bildirimi gönderen bir worker.
GitHub Actions ile zamanlanmış olarak çalışır (web sunucusu değildir, HTTP endpoint sunmaz).

## Paylaşılan Veritabanı (ÇOK ÖNEMLİ)

Bu proje ile **bks-web-system** (ayrı repo, Next.js web uygulaması) aynı PostgreSQL (Supabase)
veritabanını paylaşıyor. Bu iki proje birbirinden bağımsız geliştiriliyor ve bu geçmişte
birden fazla kez şema/davranış uyuşmazlığına yol açtı.

- **DB şemasının tek gerçek kaynağı `bks-web-system/prisma/schema.prisma`dır.**
- Bu reponun `prisma/schema.prisma` dosyası **sadece Prisma Client üretmek (generate) içindir**.
  **`prisma db push` bu repodan ASLA çalıştırılmaz** — `package.json`'da böyle bir script
  bulunmamalı, biri yanlışlıkla eklerse hemen kaldırılmalı.
- Bu repoda bir model/alan eksik veya farklıysa ve bot kodu (`src/**`) o modele/alana hiç
  dokunmuyorsa, bu genellikle zararsız bir şema-dosyası driftidir (Prisma Client sadece o
  alanı "görmez", DB'ye hiçbir etkisi olmaz). Ama şu ihtimalleri önce doğrula:
  1. `grep -rn "prisma\.<modelAdi>\.\|db\.<modelAdi>\." src` ile bot kodunun o modele
     gerçekten dokunmadığını teyit et.
  2. Bot bir modele YAZIYORSA ve o modelde web'de olup bot şemasında olmayan bir alan varsa
     (örn. `Announcement.source`), bot'un yazdığı satırlar o alan için DB'nin gerçek
     Postgres-seviyesi `DEFAULT` değerini alır (Prisma `@default(...)`, `db push` ile
     gerçek bir kolon default'u olarak DB'ye yazılır) — NULL veya hata değil.
- Yeni bir model bu repoya EKLENMEZ (bot sadece okuma/generate amaçlı) — yeni model ihtiyacı
  varsa önce `bks-web-system` şemasında tanımlanır, sonra buraya yansıtılır.

## Dokümantasyon Nerede

> Bu repoda **sadece bu `CLAUDE.md` var.** Bot'a ait ayrıntılı dokümanlar (çıkarsa)
> merkezi olarak `bks-web-system` reposunda tutulur:
> `E:\Yazilim\BKS\bks-web-system\docs\bot\`
>
> Yeni bir bot dokümanı gerektiğinde oraya eklenir, bu repoya yeni `.md` konmaz.
> (Sebep: kullanıcı 3 projeyi de `bks-web-system` üzerinden yönetiyor.)

## MD Dosyalarını Güncel Tutma Kuralı (ZORUNLU)

Bir görev/değişiklik tamamlandıktan sonra ilgili `.md` dosyaları **kontrol edilip
güncel tutulmalı**. Bu kontrol tahmine değil, sistemden (kod, şema, git durumu)
gerçekten okunan bilgiye dayanmalı:

- Yapılan değişiklik bu CLAUDE.md'deki bir kuralı/varsayımı geçersiz kıldıysa veya
  yeni bir kural gerektiriyorsa (örn. yeni bir şema senkron noktası, yeni bir
  paylaşılan alan/model) — CLAUDE.md güncellenir.
- Ayrıntılı bot dokümanı gerekiyorsa `bks-web-system\docs\bot\` altına eklenir.
- Güncelleme öncesi dosyanın MEVCUT halini oku, üzerine kör yazma yapma —
  mevcut format/üslup/madde işaretleme stiline uygun ekle.
- Emin olunmayan bir bilgi asla md'ye yazılmaz; önce kod/şema/git okunarak
  doğrulanır.

## Sezon Alanı (`ParsedMatch.sezon`) — ZORUNLU

`upsertParsedMatches`'e (`src/db-writer.ts`) `sezon` parametresi olarak **ASLA ham
`folderKey`** ("current", "latest-season" gibi) verilmez — bu, web tarafında
(`bks-web-system/lib/matches/season.ts`) "en güncel sezon"un alfabetik sıralamayla
yanlış tespit edilmesine yol açan bir bug'dı (2026-09-28'de bulundu: "current" 617,
"latest-season" 114 satır canlı DB'de doğrulandı, ~85K atama yanlışlıkla "eski sezon"
sanılıp gizlendi). `src/orchestrator.ts` artık `getSeasonKeyForFolder(folderKey)`
(`src/config.ts`) ile çözülen GERÇEK sezon adını ("2026-2027" gibi) kullanıyor.
**Yeni bir `DRIVE_FOLDERS` anahtarı veya `resolveSyncFolderKeys()`'e yeni bir özel
anahtar türü ("current"/"latest-season" gibi) eklenirse, `FOLDER_SEASON_KEYS` map'ine
de o anahtarın gerçek sezon karşılığı eklenmeli** — aksi halde aynı bug farklı bir
anahtarla geri gelir. Web tarafı artık `sezon` string'ine filtrelemede hiç
güvenmiyor (takvime göre filtreliyor) ama alan hâlâ UI'da ham gösterim için
kullanılıyor, o yüzden doğru değer yazmak önemini koruyor.

## Sezon Anahtarı Admin-Ayarlanabilir (2026-09-30'da eklendi)

`getCurrentSeasonKey()` (`src/config.ts`) hâlâ var (takvim tabanlı, Ağustos başlangıçlı
fallback) ama artık doğrudan çağrılmıyor — onun yerine `resolveCurrentSeasonKey()`
kullanılıyor. Bu fonksiyon önce web reposuyla paylaşılan `SystemSetting` tablosundan
(`SEASON_START_DATE`/`SEASON_END_DATE`, web tarafında Süper Admin → Ayarlar'dan
elle giriliyor) okumayı dener; ikisi de doluysa sezon etiketini oradan hesaplar,
boş/geçersizse `getCurrentSeasonKey()`'e fail-open düşer. `resolveSyncFolderKeys()`
içindeki iki çağrı noktası (`current` klasörü + `latest-season` beklenen anahtar
tespiti) `resolveCurrentSeasonKey()`'e geçirildi. **Yeni bir yerde sezon anahtarı
hesaplanacaksa `getCurrentSeasonKey()` değil `resolveCurrentSeasonKey()` kullanılmalı**
— aksi halde admin'in elle girdiği tarih o noktada sessizce yok sayılır. Detay:
`bks-web-system/docs/bot/YAPILACAKLAR.md` TAMAMLANANLAR.

## Excel Hücresi Okuma — UTC ZORUNLU (2026-10-01)

`src/lib/match-parser.ts` → `cellToString`'in `Date` dalı **UTC getter'ları** kullanır
(`getUTCHours`, `getUTCMinutes`, `getUTCDate`, `getUTCMonth`, `getUTCFullYear`).
ExcelJS saat/tarih hücrelerini UTC olarak saklıyor (18:00 → `1899-12-30T18:00:00Z`).
`getHours()` yerel saat dilimini uyguluyor ve 1899 için İstanbul farkı `+01:56:56`
olduğundan saat KAYIYORDU: saklanan `18:00` → `"19:56"`.

Sonucu web tarafında görüldü: Atamalar sayfasında yanlış maç saatleri ve aynı maçın iki
farklı saatle iki kez yazılması (177 mükerrer `GameAssignment`). **Yerel getter kullanmak
yasak.** Web reposundaki `lib/__tests__/match-parser-saat.test.ts` bu davranışı kilitliyor.

## Maç Adı Çıkarılamayan Satır YAZILMAZ (2026-10-01)

Eskiden son çare olarak `macAdi = \`${category} — ${ws.name}\`` yazılıyordu. Bu, sütun
düzeni farklı olan dosyalardan (özellikle arşiv kopyaları) çöp kayıtlar üretiyordu
(ör. maç adı "ÖZEL LİG VE ÜNİVERSİTE (2026 - 2027) — GÜNCEL") ve bu çöp web'in Ödemeler
sayfasına kategori olarak da sızıyordu. Artık satır atlanıyor, sayısı dosya sonunda
`[PARSER] ... satır atlandı` olarak loglanıyor. **Bu log'daki sayı artıyorsa kaynak
dosyanın başlıkları değişmiş demektir** — `scripts/inspect-drive-headers.ts` ile bak.

## Aktif Sezonun ARŞİV Kopyası Atlanır (2026-10-01)

Federasyon, içinde bulunduğumuz sezonun bir "ARŞİV ..." kopyasını da arşiv klasöründe
tutuyor. Canlı dosya güncel klasörde zaten var; arşiv kopyası elle başlatılan
`SYNC_MODE=archive-full` turunda çekilince aynı maçlar ikinci kez yazılıyor ve o kopyanın
sütun düzeni farklı olduğu için ayrıştırılamayan satırlar üretiyordu.

`src/orchestrator.ts` dosya döngüsünde: dosya adı `/AR[ŞS]İ?V/i` ile eşleşiyor **ve** o
klasörün sezon anahtarı `resolveCurrentSeasonKey()` ile aynıysa dosya atlanır + loglanır.
Geçmiş sezonların arşivleri etkilenmez (onlar zaten sezon kesim filtresinden düşüyor).

## Sütun Başlığı Eşlemesi — Tanınmayan Başlık = Sessiz Veri Kaybı (2026-09-30)

`src/lib/match-parser.ts` sütunları BAŞLIK METNİNE göre eşliyor (`colMap`). Bir başlık
tanınmazsa o sütunun verisi sessizce kaybolur. Gerçek bir örnek: Yerel Lig haftalık
dosyalarında kategori sütununun başlığı `KATEGORİ` (ör. "U16EA"), Özel Lig dosyalarında
`ORGANİZASYON`. Alias sadece `organizasyon`/`org` olduğu için `KATEGORİ` tanınmıyor ve
`rowKategori` SEKME ADINA ("1 hafta") düşüyordu — DB'deki 808 Yerel Lig maçının tamamı
böyle yazılmıştı. Ayrı bir `GRUP` sütunu ("A GRUBU") da tamamen kayboluyordu.

Artık `kategori` ve `grup` başlıkları tanınıyor; `grup` ayrı bir alan
(`MatchData.grup`, ParsedMatch'te tutulmaz — web tarafı `GameAssignment.grup`'a yazıyor).

**Yeni bir kaynak dosya formatı geldiğinde başlıkları TAHMİN ETME.** Web reposundaki
`scripts/inspect-drive-headers.ts` (salt okuma) gerçek başlık satırını yazdırır:
`npx tsx --env-file=.env.local scripts/inspect-drive-headers.ts "5.HAFTA"`.
Bu dosya web reposundaki `lib/match-parser.ts` ile BİREBİR aynı olmalı — alias
değişikliği iki repoda aynı turda yapılır.

## `parseTarihDate` Yıl Sınırı (2026-09-30)

Yıl 2015-2100 aralığına sınırlı ve regex `(\d{4})(?!\d)` ile tam dört haneye bağlı.
Gerçek veride bir satırın tarihi "05.12.22025" yazılmıştı; eski regex ilk dört haneyi
("2202") yıl sanıp kaydı 2202 yılına atıyordu. Böyle kayıtlar hem listelerde geleceğe
düşüyor hem de web'in eski sezon temizliğinden kaçıyordu (kesim tarihinden BÜYÜK
oldukları için). Aralık dışı yıl artık `null` döndürür.

## Sezon Kesim Filtresi — Eski Maçlar Bir Daha YAZILMAZ (2026-09-30'da eklendi)

Web tarafında Süper Admin → Ayarlar'dan eski sezon verisi kalıcı silinebiliyor
(`bks-web-system/lib/matches/season-purge.ts`). Bot hiçbir tarih filtresi uygulamadığı
için silinen bu maçlar bir sonraki senkronda geri geliyordu — özellikle
`sync-archives-once.yml` (`SYNC_MODE=archive-full`) elle çalıştırılınca, ya da
`current`/`latest-season` klasöründeki bir dosya değişince ve içinde eski tarihli satırlar
olduğunda.

Artık `src/orchestrator.ts`, dosyayı parse ettikten HEMEN SONRA
`getSeasonCutoffDate()` (`src/config.ts`) ile kesim tarihinden önceki maçları listeden
atıyor ve kaç tanesini attığını logluyor. Kesim tarihi web ile **ORTAK** ayardan
(`SystemSetting.SEASON_START_DATE`) okunuyor; ayar yoksa takvime (Ağustos 1) fail-open
düşülüyor. Yani "Ayarlar'daki sezon başlangıcı" iki repo için tek gerçek kaynak: web neyi
siliyorsa bot onu bir daha yazmıyor.

**Filtre bilinçli olarak orchestrator'da, `db-writer.ts` içinde DEĞİL.**
`buildUserAssignments(matches, matchIds)` (`src/user-matcher.ts`) iki listeyi indeks
indeks eşliyor — süzmeyi `upsertParsedMatches` içine indirmek bu hizayı bozar ve
atamalar yanlış maçlara bağlanır. Yeni bir filtre eklenecekse aynı yere eklenmeli.

`tarihDate === null` satırlar (tarihi ayrıştırılamamış) BİLEREK yazılmaya devam ediyor:
veri kaybetmek, fazladan bir satır tutmaktan daha kötü.

## `UserMatchAssignment.paidAt` — Bot ASLA Yazmaz (2026-09-30'da eklendi)

Kullanıcının "bu maçın ücreti ödendi" işareti. Bot bu alana **hiç yazmaz** —
`upsertUserMatchAssignment`'ın `update` payload'ında yok (`role`, `nameInSpreadsheet`
sadece). Ama duplicate birleştirme yolları atama satırını SİLİYOR:

- `src/db-writer.ts` → `ROW_SHIFTED` dalı
- `src/lib/contentkey-consolidator.ts` → `MOVE` / race-dupe dalı

Bu iki yerde silinen kaydın `paidAt`'i kalan kayda taşınıyor (hedefte işaret yoksa).
Yeni bir dedupe/silme yolu eklenirse **aynı taşımayı yapmak zorunlu** — aksi halde
kullanıcı kendi işaretini sessizce kaybeder.

## Tarih Ayrıştırma (`parseTarihDate`) — Türkçe Uzun Format (2026-09-29'da eklendi)

`src/db-writer.ts` → `parseTarihDate()` artık hem sayısal `DD.MM.YYYY` hem de uzun Türkçe
format (`"20 Aralık 2025 Cumartesi"`) tanıyor. Eski regex sadece sayısal formatı tanıyordu;
bazı kaynak dosyalar (OKUL İL VE İLÇE, ARŞİV TBF-FIBA-MİLLİ MAÇLAR, ARŞİV ÖZEL LİG VE
ÜNİVERSİTE) tarihi uzun Türkçe formatta veriyor, bu satırlar `tarihDate: NULL` kalıyordu
(568 satır, 2026-09-29'da tespit edildi). Web tarafı `tarihDate: null` kayıtları sezon
filtresinde bilerek görünür bıraktığı için (`bks-web-system/lib/matches/season.ts`) bu,
eski ve yeni sezon maçlarının ayrıştırılamayıp karışık görünmesine yol açıyordu.
**Yeni bir kaynak dosya/ay formatı eklenirse `TURKISH_MONTHS` map'i genişletilmeli.**
Geçmişte yazılmış NULL satırlar `scripts/backfill-turkish-tarihdate.ts` (report/apply)
ile düzeltildi — sadece `tarihDate` alanı UPDATE edilir, hiçbir satır silinmez.

## Şema Senkron Checklist'i

1. `bks-web-system/prisma/schema.prisma`'da bir değişiklik yapıldığını öğrendiğinde: bu
   reponun `prisma/schema.prisma`'sının etkilenip etkilenmediğini kontrol et. Bot kodu o
   modele/alana dokunuyorsa, bu repo şemasını da güncelleyip `npx prisma generate` çalıştır.
2. **Yeni bir "otomatik/sistem duyurusu" türü eklenecekse** (örn. `db.announcement.create` ile
   yeni bir otomatik bildirim yazılacaksa — bkz. `src/db-writer.ts` `createCancellationAnnouncements`),
   mutlaka `senderId: null` ile yaz (web tarafındaki pop-up sorguları `senderId: { not: null }`
   filtresiyle otomatik/bot kaynaklı satırları hariç tutuyor — bu filtreyi bozmayacak şekilde
   yaz, aksi halde bot'un ürettiği bir olay sessizce web'de kullanıcıya "Yeni Duyuru" pop-up'ı
   olarak çıkabilir).
3. Push bildirim payload şekli (`type`, `screen`, `channel`, `data` alanları — bkz.
   `src/lib/push-sender.ts`) değiştiğinde, hem `bks-web-system` hem mobil tarafı
   (`bks-mobile-flutter/lib/services/push_notification_service.dart`, `badge_service.dart`)
   aynı değişiklik döngüsünde gözden geçirilmeli. Mevcut maç bildirim tipleri:
   `MATCH_ASSIGNED`, `MATCH_CHANGED`, `MATCH_CANCELLED`, `MATCH_UPDATED` (hepsi
   `screen: "MATCHES"`). Yeni bir tip eklenirse `badge_service.dart` `bumpFromPushType`
   switch'ine de eklenmeli.
4. Periyodik olarak (örn. büyük bir özellik tamamlandığında) iki `schema.prisma` dosyası yan
   yana açılıp model/alan/index listesi karşılaştırılmalı.
5. **`Announcement.source` senkronu (2026-09-28):** web'in `schema.prisma`'sındaki
   `source String @default("ADMIN")` bu repoya da eklendi, `npx prisma generate`
   çalıştırıldı. `db.announcement.create` çağrısına (`src/db-writer.ts`) bilinçli
   olarak `source` set edilmedi — bot'un `senderId: null` bırakıp DB default'unu
   ("ADMIN") almaya devam etmesi, web'in bot-satırlarını ayırt etme mantığıyla
   (`senderId: {not: null}` filtresi) tutarlı; `source` elle set edilirse bu ayrım
   bozulabilir, önce web tarafı kontrol edilmeden değiştirilmemeli.

## Bildirim Kararı — İptal / Güncelleme / Yeni Atama (ZORUNLU)

Federasyon Excel'de kadroyu **kademeli** dolduruyor (önce masa → sonra gözlemci → ... →
en son hakemler). `matchKey` personel içerdiği için her adım yeni bir `ParsedMatch` satırı
açar; **aynı `contentKey`'e sahip birden fazla aktif satır normaldir**.

- **İptal/güncelleme kararı asla tek bir satıra bakılarak verilmez.** Bir kullanıcının
  maçtan çıkıp çıkmadığı, o `contentKey`'in **tüm aktif satırlarının** kadrosuna bakılarak
  belirlenir (`decideAssignmentOutcomes`, saf fonksiyon, `src/db-writer.ts`). Kullanıcı
  kanonik (kadrosu en dolu) satırda varsa maçtadır; eski satırdaki ataması kanonik satıra
  taşınır (`ROW_SHIFTED`), boşalan satır `cancelReason: "Kadro güncellendi"` ile iptal edilir.
- İsim karşılaştırması **her iki yönde de** `nameMatches()` (fuzzy, sıra-bağımsız) kullanır —
  atama tarafıyla (`user-matcher.ts`) simetrik olmalı. Ham `trim().toLowerCase()` eşitliği
  tek başına yeterli değildir (Excel'de isim sırası tutarsız).
- "Yeni atama mı" kararı `userId:matchId` değil **`userId:contentKey`** bazlıdır.
- `detectAndMarkCancelledMatches` → `CancellationScanResult { cancelled, shifted }` döner.
  `reconcileAndNotify` bunları + `newAssignments`'i alıp `planNotifications` (saf fonksiyon)
  ile kullanıcı bazında tek bir bildirim tipi seçer: `UPDATED` / `CHANGED` / `CANCELLED` / `ASSIGNED`.
- **BUG DÜZELTİLDİ (2026-09-24, destek talebi):** `CANCELLED` kararı verilen
  `UserMatchAssignment` satırı, karar doğru hesaplandığı hâlde hiç SİLİNMİYORDU
  (sadece bildirim için `cancelledMap`'e ekleniyordu) — bu yüzden eski `ParsedMatch`
  satırı asla "boş" sayılmıyor, `cancelledAt` hiç set edilmiyor, çıkarılan kişi
  sonsuza dek eski maçı görmeye devam ediyordu. `DRY_RUN` simülasyonu bu satırları
  zaten "yok" sayıyordu — sadece canlı moddaki asıl silme adımı unutulmuştu. Düzeltme:
  `detectAndMarkCancelledMatches` içine, `ROW_SHIFTED` uygulamasından hemen sonra
  ve satır-iptal sayımından ÖNCE, `CANCELLED` kararlı her atamayı silen bir adım
  eklendi (`src/db-writer.ts`, "2.5" adımı). Regresyon testi:
  `test/decide-assignment-outcomes.test.ts` → "gerçek vaka Ali Can Yılmaz". Bu bug
  nedeniyle birikmiş geçmiş veri `scripts/consolidate-active-contentkey-duplicates.ts
  apply-with-removals` ile temizlendi (bkz. `docs/bot/YAPILACAKLAR.md` madde 6,
  bks-web-system reposunda).
- **`NOTIFY_DRY_RUN=1`**: FAZ 2 kararları (atama taşıma, satır iptali, push gönderimi)
  uygulanmaz, sadece loglanır. `upsertDriveFile` / `upsertParsedMatches` normal çalışır
  (matchId üretmeleri gerekiyor). **`buildUserAssignments`'ın (`src/user-matcher.ts`)
  gerçek `UserMatchAssignment` yazma adımı da bu bayrakla korunuyor (2026-09-26'da
  eklendi)** — isim eşleştirme/ambiguity kontrolü/`assignmentCount` hesabı yine tam
  çalışır, sadece DB'ye yazılmaz. Hem `sync-current.yml` hem `sync-archives-once.yml`
  `workflow_dispatch` → `dry_run` seçeneğiyle manuel tetiklenebilir (cron turları
  etkilenmez). **Neden `sync-archives-once.yml`'e de eklendi:** 2026-09-26'da bu
  workflow önizlemesiz `sync_mode: archive-full` ile elle çalıştırılıp production'a
  53.284 satır yazmıştı (bkz. `docs/bot/YAPILACAKLAR.md` madde 5 detayı).
- **`evaluateCancellationSafety` sigortası**: bir dosyada iptal adayı ≥25 atama VE dosyanın
  aktif atamalarının >%40'ıysa (başlık bozulması / kolon kayması şüphesi) hiçbir iptal
  yazılmaz, `logger.error` ile loglanır. Eşiği düşürmeden önce günlük normal iade hacmini
  (5-24 atama) kontrol et.
- **reconcile (`detectAndMarkCancelledMatches`) sadece `filesChanged` olan dosyalarda çalışır**
  (`src/orchestrator.ts` → `toProcess` döngüsü, dosya-bazlı). Bir Drive dosyası kadrosu
  netleştikten sonra bir daha hiç değişmezse (donmuş dosya), o dosyanın kademeli-doldurma
  ikizleri (aynı contentKey, birden fazla aktif satır) reconcile tarafından birleştirilmez.
- **B6 ÇÖZÜMÜ (2026-09-09) — her sync sonunda periyodik konsolidasyon.** `src/index.ts`,
  `reconcileAndNotify`'dan SONRA `consolidateActiveContentKeyDuplicates()`
  (`src/lib/contentkey-consolidator.ts`) çağırır: tüm DB'yi tarar, aynı contentKey'e sahip
  >1 aktif satır olan grupları GÜVENLİ birleştirir (kanonik = en dolu kadro; atama
  kanoniğe taşınır / kardeşte varsa silinir; **belirsiz "gerçek çıkarılma" atamalarına
  DOKUNMAZ**). BİLDİRİM ÜRETMEZ. İlk kurulumda (`isFirstEverSync`) atlanır. Hata sync'i
  başarısız saymaz. `NOTIFY_DRY_RUN=1` ile DB'ye yazmadan çalışır. Bu, donmuş dosya
  ikizlerinin birikmesini kalıcı olarak engeller — web `dedupeMatchesByContent`
  (`bks-web-system/lib/matches/match-utils.ts`) ikinci savunma katmanı olarak kalır.
  Elle çalıştırma / bir kerelik "gerçek çıkarılma" temizliği için CLI:
  `scripts/consolidate-active-contentkey-duplicates.ts` (report / apply / apply-with-removals).

## Bakım / Onarım Script'leri (`scripts/`)

Tek seferlik DB düzeltme script'leri. **HEPSİ** aynı güvenlik disiplinine uyar: sadece
`user_match_assignments` (matchId update / delete) + boşalan `parsed_matches` satırına
`cancelledAt`/`cancelReason`; kanonik satıra, uygunluk/profil/duyuru tablolarına DOKUNMAZ;
`userId_matchId` unique guard çift atama üretmeyi imkânsız kılar; her `apply` geri alma
logu (JSON) basar. Önce `report` ile sayıyı doğrula, kullanıcı onayıyla `apply`.

| Script | Hedef | cancelReason |
|---|---|---|
| `repair-false-cancellations.ts` | A1 — `cancelledAt` DOLU eski satır + aktif kardeş (kademeli doldurma sahte iptali) | `Hakem listesinden çıkarıldı` (korunur) |

> **A1 `apply` çalıştırıldı (2026-09-10).** `report` = 50/255; `apply` = 255 atama, hepsi
> `DELETED (dupe)` (report↔apply arası bot sync'i atamaları zaten kanoniğe taşımıştı, `apply`
> iptal satırlarındaki kopyaları temizledi). Doğrulama: iptal olmuş kanonik 0, kanonikte
> aktif atama 309, ikinci `report` = 0 (idempotent). Geri alma logu:
> `E:\tmp\A1-undo-20260910T175411.json`. Detay: `bks-web-system/docs/web/YAPILACAKLAR.md`
> "✅ 0.A-TAMAMLANDI — 2026-09-10: A1".
| `detect-key-mismatch-duplicates.ts` | Salt okuma — isim/tarih değişimi kaynaklı farklı-contentKey ikizi | — |
| `repair-key-mismatch-duplicates.ts` | Farklı contentKey (placeholder isim → gerçek isim) stale satır. `apply` / `apply-with-removals` (belirsiz = gerçek kadro değişimi de siler) | `Anahtar uyuşmazlığı (isim/tarih değişimi) — otomatik onarım` / `Güncel kadroda yok — mükerrer stale kayıt temizliği` |
| `consolidate-active-contentkey-duplicates.ts` | Aynı contentKey, birden fazla AKTİF satır (donmuş dosya ikizi). Asıl mantık `src/lib/contentkey-consolidator.ts`'te (bot her sync sonunda otomatik çalıştırır — B6). Bu CLI sarmalayıcı: `report` / `apply` / `apply-with-removals` | `Aynı maçın mükerrer aktif kaydı — otomatik birleştirme` / `Güncel kadroda yok — mükerrer stale kayıt temizliği` |
| `repair-salon-rename-duplicates.ts` | Salon adı varyasyonu (`PAIRS` dizisinde elle enumerate edilmiş çiftler) | `Salon adı varyasyonu — mükerrer stale kayıt temizliği` |
| `backfill-turkish-tarihdate.ts` | `tarihDate: NULL` satırlar (uzun Türkçe tarih formatı parse edilemediği için, bkz. yukarıdaki "Tarih Ayrıştırma" bölümü). Sadece `tarihDate` UPDATE edilir, satır silinmez/iptal edilmez | — (cancelReason yok, sadece tarih dolduruluyor) |

Yeni bir mükerrer deseni çıkarsa: önce hangi alanın `contentKey`'i değiştirdiğini tespit et
(mac_adi / tarih / saat / salon), sonra ilgili script'i genişlet veya yeni bir hedefli
script yaz — **genel bir "slot bazlı hepsini birleştir" yaklaşımından kaçın** (aynı salonda
peş peşe maç yöneten ekipler yüksek kadro örtüşmesi üretir, yanlış pozitif riski yüksek).

## Ceza Sorgulama Tabloları — Bot ASLA Dokunmaz (2026-10-03'te eklendi)

Web tarafında Saha Komiserlerine özel bir **Ceza Sorgulama** sayfası var. Verisi iki
Google E-Tablo'dan geliyor: *CEZA KARARLARI* ve *ANTRENÖR OLMADAN SAHAYA ÇIKAN TAKIMLAR*.
Üç yeni tablo kullanılıyor: `DisciplinaryRecord`, `CoachlessTeamRecord`,
`DisciplinarySyncState` (şemada var çünkü şema tek kaynak web'de).

**Bu üç tabloya BKS-BOT ASLA YAZMAZ ve okumaz.** Senkronu web tarafı yapıyor
(`app/api/cron/sync-discipline` → `lib/discipline/sync.ts`, saatlik).

**Neden bot değil de web** (gelecekte "bunu bot yapsa daha mantıklı değil mi?" sorusu
çıkarsa cevabı burada): bot'un Google kimliği bir **servis hesabı** ve scope'u yalnızca
`drive.readonly` (`src/lib/google-drive.ts`) — Sheets API'yi hiç kullanmıyor, repoda
`spreadsheets.values.get` çağrısı yok. Web'in OAuth hattı ise `spreadsheets` scope'una
sahip ve 2026-10-03'te iki dosyayı da okuyabildiği **canlı olarak doğrulandı**. Veri çok
küçük (56 + 12 satır), bot'un ağır Drive/xlsx hattına taşımanın bir faydası yok; taşımak
yeni scope, yeni entry point ve yeni bir dış tetikleyici kurulumu demek olurdu.

**Yani:** bu özellik için bu repoda yapılacak hiçbir iş yok. Şema değişikliği de
gerekmiyor — bot kodu bu modellere hiç referans vermiyor (checklist adım 1'in testi:
`grep "prisma.disciplinary"` → 0 sonuç).

## Git Push Kuralları

- Push öncesi kullanıcıya kısa bir onay sorusu sor.
- Force push / history rewrite kesinlikle yasak.
- Commit mesajlarına AI imzası eklemek konusunda kullanıcıya sor — `bks-web-system` reposunda
  bu açıkça yasaklı (proje kuralı), bu repoda aksi belirtilmediği sürece aynı kural geçerli
  sayılmalı.
