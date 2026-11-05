# CLAUDE.md

**BKS-BOT** — Google Drive/Sheets'ten maç verisi çeker, ayrıştırıp DB'ye yazar, atama/iptal/değişiklikte push gönderir.
GitHub Actions ile zamanlanmış çalışır (HTTP ucu yok). Ayrıntı ve tarihçe: git geçmişi + bks-web-system `docs/bot/`.

## 1. Temel Kurallar

- **Paylaşılan DB:** bks-web-system ile aynı PostgreSQL (Supabase). **Şemanın tek kaynağı `bks-web-system/prisma/schema.prisma`.**
  Bu repodaki şema sadece `prisma generate` içindir; **`prisma db push` bu repodan ASLA çalışmaz** (package.json'a böyle script eklenmez).
  Yeni model burada açılmaz — önce web şemasında tanımlanır, sonra yansıtılır.
- **Şema drift'i:** eksik/farklı model zararsız olabilir — önce `grep -rn "prisma\.<model>\.\|db\.<model>\." src` ile bot kodunun ona
  dokunmadığını doğrula. Bot bir modele yazıyor ve web'deki bir alan burada yoksa satır o alanın DB `DEFAULT`'unu alır.
  Web şeması değişince: bot kodu o modele dokunuyorsa bu şema güncellenir + `npx prisma generate`. Büyük işlerden sonra iki şema yan yana karşılaştırılır.
- **Dokümantasyon:** bu repoda sadece `CLAUDE.md`. Bot dokümanları `bks-web-system/docs/bot/` (YAPILACAKLAR, TEST). İş bitince md'ler
  **koddan/şemadan okunarak** güncellenir (önce mevcut hâl okunur, emin olunmayan yazılmaz).
- **Git:** push öncesi kısa onay sorusu; force push / history rewrite yasak; commit'e AI imzası / `Co-Authored-By` eklenmez.

## 2. Bot'un Yazmadığı / Dokunmadığı Veri

| Veri | Kural |
|---|---|
| `UserMatchAssignment.paidAt` | ASLA yazılmaz (`upsertUserMatchAssignment` update'i sadece `role`, `nameInSpreadsheet`). Atama silen dedupe yolları (`db-writer.ts` ROW_SHIFTED, `contentkey-consolidator.ts` MOVE/race-dupe) silinen kaydın `paidAt`'ini kalana taşır — **yeni silme yolu da taşımak zorunda** |
| `ParsedMatch.seansSayisi` | ASLA yazılmaz (`db-writer.ts` açık alan listesinde yok) |
| Ceza Sorgulama (`DisciplinaryRecord`, `CoachlessTeamRecord`, `DisciplinarySyncState`) | Ne okunur ne yazılır — senkronu web yapar (bot servis hesabı sadece `drive.readonly`) |
| Atamalar/TBF/Derbi/Venue/ManualDifficulty/öneri tabloları, `exam_sessions`, `ObserverReportRead` | Bot kodu kullanmaz |
| `Announcement.source` | Elle set edilmez; bot `senderId: null` bırakır, DB default'u ("ADMIN") alır. **Yeni otomatik duyuru türü `senderId: null` ile yazılır** (web pop-up'ları `senderId: { not: null }` filtreler) |

**Sadece bot'un yazdıkları:** `match_notification_outbox` (şema web reposunda) · `ParsedMatch.kaynakSekme` / `kaynakSatir`
(`row.number` — gerçek Excel satırı, dizi indeksi değil; web Atamalar sırası buna bağlı).

## 3. Sezon

- `upsertParsedMatches`'e `sezon` olarak **ASLA ham `folderKey`** ("current", "latest-season") verilmez — `getSeasonKeyForFolder(folderKey)`
  (`src/config.ts`) gerçek adı ("2026-2027") verir. Yeni `DRIVE_FOLDERS` anahtarı / özel anahtar türü eklenirse `FOLDER_SEASON_KEYS`'e de eklenir.
- Sezon anahtarı her yerde **`resolveCurrentSeasonKey()`** ile (web ile ortak `SystemSetting.SEASON_START_DATE`/`SEASON_END_DATE`, yoksa
  Ağustos takvimi). `getCurrentSeasonKey()` sadece fallback — doğrudan çağrılmaz.
- **Sezon kesimi:** `src/orchestrator.ts` parse'tan HEMEN SONRA `getSeasonCutoffDate()` ile kesim öncesi maçları atar (web neyi siliyorsa
  bot geri yazmaz). **Filtre bilinçli olarak orchestrator'da**, `db-writer.ts`'te değil — `buildUserAssignments(matches, matchIds)` iki
  listeyi indeksle eşler. Yeni filtre de aynı yere. `tarihDate === null` satırlar yazılır (veri kaybı daha kötü).
- **Aktif sezonun ARŞİV kopyası atlanır:** dosya adı `/AR[ŞS]İ?V/i` + klasör sezonu = güncel sezon → atla + logla.

## 4. Ayrıştırma (`src/lib/match-parser.ts`)

- Sütunlar **başlık metniyle** (`colMap`) eşlenir; tanınmayan başlık = **sessiz veri kaybı**. Yerel Lig: `KATEGORİ` (ör. U16EA) → `kategori`;
  Özel Lig: `ORGANİZASYON` → `kategori`, `KATEGORİ` → `altKategori` (ORGANİZASYON hücresi boşsa sekme adı, KATEGORİ değil); ayrı `GRUP` → `ParsedMatch.grup`.
- **Yeni format geldiğinde başlık TAHMİN EDİLMEZ:** web `scripts/inspect-drive-headers.ts "5.HAFTA"` (salt okuma). Alias değişikliği web
  `lib/match-parser.ts` ile **aynı turda**.
- **Excel hücresinde UTC getter zorunlu** (`cellToString` → `getUTC*`); yerel getter 1899 İstanbul farkıyla (+01:56:56) saati kaydırır. Web
  `match-parser-saat.test.ts` kilitler.
- **Maç adı çıkarılamayan satır yazılmaz** — atlanır, `[PARSER] ... satır atlandı` loglanır. Sayı artıyorsa kaynak başlıkları değişmiştir.
- **`parseTarihDate`** (`db-writer.ts`): `DD.MM.YYYY` + uzun Türkçe ("20 Aralık 2025 Cumartesi", `TURKISH_MONTHS`); yıl 2015–2100 ve
  `(\d{4})(?!\d)` (aralık dışı → `null`). Yeni ay formatı → `TURKISH_MONTHS` genişler.
- **Sayısal saat:** bot `Math.floor`, web `Math.round` (web ayrıştırmadığı için etkisiz, bilinçli).

## 5. TBF/FIBA/Milli — Google Sheets Kaynağı

- Drive'a düşmeyen federasyon/milli maçları iki canlı E-Tablodan: **GÜNCEL** (`TBF_MILLI_CURRENT_SHEET_ID`, haftalık üzerine yazılır) +
  **ARŞİV** (`TBF_MILLI_ARCHIVE_SHEET_ID`, sezon başından GÜNCEL'in önceki gününe). `src/tbf-milli-sync.ts` → `runTbfMilliSync()`, Drive döngüsünden SONRA.
- Kimlik: `src/lib/sheets-source.ts` web'in OAuth'unu kullanır (`GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN`, iki repoda aynı).
- **Parser yeniden yazılmadı:** satırlar bellekte ExcelJS workbook'a yüklenip `parseWorkbook` ile ayrıştırılır; `ligTuru` sheet başlığından
  `"TBF / MİLLİ"`; `kategori` KATEGORİ sütunundan **HAM**.
- Kendi değişim tespiti: sekme parmak izi (`tbf-milli-fingerprint.ts` → `computeTabFingerprint`) `DriveFile.lastProcessedMd5`'teki (sahte dosya
  `sheet:<id>`) izle aynıysa parse/atama/iptal ATLANIR. İz sadece hatasız bitince yazılır (`markDriveFileFingerprint`). `archive-full` /
  `FORCE_SYNC=true` atlamayı kapatır. **Parse/atama mantığı değişirse `TBF_MILLI_FINGERPRINT_VERSION` artırılır.** Kilit anahtarı `"tbf-milli-sheets"`.
- Teşhis: `scripts/dry-run-tbf-milli.ts` (salt okuma).

## 6. Atama ve İptal Kararı (ZORUNLU)

Federasyon kadroyu **kademeli** doldurur; `matchKey` personel içerdiği için her adım yeni satır açar — **aynı `contentKey`'de birden çok aktif satır normaldir.**

- **`contentKey`** = sha256(`contentKeyRaw`); `contentKeyRaw` web `lib/matches/match-utils.ts` → `contentKey` ile BİREBİR (`mac_adi|tarih|saat`,
  iç boşluk tekleştirme, 3x3'te `|#kaynak_satir`). `test/content-key-twin.test.ts` web ikiziyle aynı fixture'lar.
- **Karar tek satıra bakılarak verilmez** — `decideAssignmentOutcomes` (saf, `db-writer.ts`) contentKey'in **tüm aktif satırlarına** bakar.
  Kanonik satırda olan kişi maçtadır, ataması kanoniğe taşınır (`ROW_SHIFTED`), boşalan satır `"Kadro güncellendi"` ile iptal.
- **Kanonik satır = dosyanın ŞU ANKİ hâlinde bulunan satır** (`currentFileMatchKeys`); birden çoksa en kalabalık, eşitse daha yeni (büyük id).
  `upsertParsedMatches` dosyada matchKey'i birebir bulunan iptalli satırın iptalini **geri alır**. Test: `decide-assignment-outcomes.test.ts` → "kanonik satır seçimi".
- `CANCELLED` kararlı atamalar `detectAndMarkCancelledMatches` içinde (ROW_SHIFTED'dan sonra, satır-iptal sayımından önce) **silinir**.
- **Dosyadan kalkan satırlar:** `cancelRowsMissingFromFile` — sadece ataması yok + tarihi bugün/ileri + matchKey dosyada yok. Kalkan sayı gelecek
  aktif satırların yarısını geçerse (`MISSING_ROW_MAX_RATIO`) hiçbir şey yapılmaz. `cancelReason = "Dosyadan kaldırıldı"`; geri gelirse iptal açılır.
- **İsim:** hücre ↔ profil `src/lib/name-match.ts` (web `lib/name-match.ts` ikizi, aynı fixture'lı `name-match.test.ts`) — profilin karşılamadığı
  TEK kelime kalırsa eşleşmez ("AYHAN CEM AKAN" ≠ "Cem Akan"), belirsiz hücre kimseye atanmaz. Karşılaştırma iki yönde de `nameMatches()`
  (fuzzy, sıra bağımsız; `user-matcher.ts` ile simetrik). Bulanık eşikler web `lib/name-fuzzy.ts` ile aynı (0.90 / kısa 0.95 / fark 0.05).
- "Yeni atama mı" kararı **`userId:contentKey`** bazlı.
- **Sigorta** `evaluateCancellationSafety`: iptal adayı ≥25 atama VE dosyanın aktif atamalarının >%40'ı → hiçbir iptal yazılmaz, `logger.error`.
  Eşik düşürülmeden önce normal günlük iade hacmine (5–24) bakılır.
- Reconcile sadece `filesChanged` dosyalarda çalışır; donmuş dosya ikizlerini her sync sonunda `consolidateActiveContentKeyDuplicates()`
  (`contentkey-consolidator.ts`) güvenli birleştirir — bildirim üretmez, belirsiz "gerçek çıkarılma"ya dokunmaz, ilk kurulumda atlanır.

## 7. Bildirimler

- Tipler `MATCH_ASSIGNED`, `MATCH_CHANGED`, `MATCH_CANCELLED`, `MATCH_UPDATED` (`screen: "MATCHES"`). Yeni tip → mobil `badge_service.dart`
  `bumpFromPushType`'a da. Payload (`type`, `screen`, `channel`, `data`) değişirse web + mobil aynı turda.
- **Geçmiş maça bildirim yok:** `src/lib/match-time.ts` → `isMatchStarted(tarih, saat, now)` (İstanbul saati, saat yoksa gün sonu).
  Başlamış maçta `decideAssignmentOutcomes` → `EXPIRED_WINDOW` (atama silinmez), `filterFutureEvents` plandan süzer.
- **Teyit kuyruğu:** Atama anında; İptal / Güncellendi / Değişiklik `match_notification_outbox`'a yazılıp `NOTIFY_CONFIRM_DELAY_MIN` (10) dk
  bekler, `notification-outbox.ts` → `flushDueNotifications` (her tur sonu) DB'den teyit edip gönderir/düşürür (`resolvePending`, saf).
  "Maç İadesi" duyurusu da teyitten sonra. Bekleyen iptal aynı kişinin yeni atamasıyla `planWithPending`'de eşleşir (aynı maç → sessiz, aynı gün → Değişiklik).
- **Kural seti** (`change-notifier.ts`, saf): kişi başına her maç ayrı; aynı takımlar + lig türü yeni tarih/saat → Güncellendi; aynı gün başka maç →
  Değişiklik; farklı gün → İptal + Atama. Güncellendi satırları `squad-change.ts` → `diffMatch` ("A yerine B", hakem koltuk, tarih/saat/salon;
  ilk dolum ve yerine kimse yazılmadan çıkarma bildirim üretmez; maçta kalan herkese).
- **Metin** `notification-text.ts` (başlıkta takım yok, gövdede tüm bilgi + görevliler; masa koltuk adları web `official-roles.ts` → `seatLabels`
  ile SYNC). Koltuk adı sadece grup TAM doluyken (`isGroupFull`), eksikse genel ad.
- **Gönderim** `push-sender.ts` → `sendMatchPush`: HER cihaza klasik (`notification` bloklu) mesaj, `data` `title`+`body` taşır
  (`buildPushMessage`). Sadece veri (data-only) biçimi 2026-11-05'te KALDIRILDI — kapalı uygulama / üretici pil kısıtlamasında
  bildirim sessizce kayboluyordu; geri getirilmez. `android.priority: high`,
  APNs `apns-priority: 10` / `apns-push-type: alert`. `messaging/invalid-argument` ölü token SAYILMAZ (web ikizi de).

## 8. Senkron ve Güvenli Çalıştırma

- cron-job.org `repository_dispatch` dakikada bir; `MIN_SYNC_INTERVAL_SEC = 50` çift işi önler; `sync-current.yml`
  `concurrency: { group: sync-current, cancel-in-progress: false }`. Alt sınır runner açılışı (~40 sn – 3 dk).
- **`NOTIFY_DRY_RUN=1` / workflow `dry_run`:** FAZ 2 kararları + `buildUserAssignments` yazması + push uygulanmaz, loglanır;
  **`ParsedMatch` upsert'i gerçekten çalışır.** `sync-archives-once.yml` `archive-full` modunda önce mutlaka `dry_run: true` ile sayı görülür.
- Testler (`npm test`, gerçek `DATABASE_URL`/`DIRECT_URL` ister). Düşük RAM'de dosya dosya:
  `TS_NODE_TRANSPILE_ONLY=true node -r ./test/register.js --test --test-concurrency=1 test/<dosya>.test.ts` + ayrıca `npx tsc --noEmit`.

## 9. Bakım / Onarım Script'leri (`scripts/`)

Hepsi aynı disiplin: sadece `user_match_assignments` (update/delete) + boşalan `parsed_matches` satırına `cancelledAt`/`cancelReason`;
kanonik satıra ve diğer tablolara dokunmaz; `userId_matchId` unique çift atamayı engeller; her `apply` geri alma logu (JSON) basar.
**Önce `report`, kullanıcı onayıyla `apply`.**

| Script | Hedef |
|---|---|
| `repair-false-cancellations.ts` | Sahte iptal: iptalli eski satır + aktif kardeş |
| `detect-key-mismatch-duplicates.ts` | Salt okuma — isim/tarih değişimi kaynaklı farklı-contentKey ikizi |
| `repair-key-mismatch-duplicates.ts` | Placeholder → gerçek isim stale satırı (`apply` / `apply-with-removals`) |
| `consolidate-active-contentkey-duplicates.ts` | Aynı contentKey'de çok aktif satır (otomatik konsolidasyonun CLI'ı) |
| `repair-salon-rename-duplicates.ts` | Salon adı varyasyonu (`PAIRS` elle) |
| `backfill-contentkey-v2.ts` | contentKey formülü değişince hash'leri yeniler (`report` / `apply`, sadece `contentKey` yazar) |
| `backfill-turkish-tarihdate.ts` | `tarihDate: NULL` satırları doldurur (sadece UPDATE) |
| `dry-run-tbf-milli.ts` | Salt okuma — TBF-Milli sheet parse sonucu |

Yeni mükerrer deseni: önce `contentKey`'i hangi alanın değiştirdiğini bul, hedefli script yaz — **"slot bazlı hepsini birleştir"den kaçın**
(aynı salonda peş peşe maç yöneten ekipler yanlış pozitif üretir).
