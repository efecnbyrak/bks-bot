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
- **`NOTIFY_DRY_RUN=1`**: FAZ 2 kararları (atama taşıma, satır iptali, push gönderimi)
  uygulanmaz, sadece loglanır. `upsertParsedMatches` / `buildUserAssignments` normal çalışır.
  `sync-current.yml` `workflow_dispatch` → `dry_run` seçeneğiyle manuel tetiklenebilir
  (cron turları etkilenmez).
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
| `detect-key-mismatch-duplicates.ts` | Salt okuma — isim/tarih değişimi kaynaklı farklı-contentKey ikizi | — |
| `repair-key-mismatch-duplicates.ts` | Farklı contentKey (placeholder isim → gerçek isim) stale satır. `apply` / `apply-with-removals` (belirsiz = gerçek kadro değişimi de siler) | `Anahtar uyuşmazlığı (isim/tarih değişimi) — otomatik onarım` / `Güncel kadroda yok — mükerrer stale kayıt temizliği` |
| `consolidate-active-contentkey-duplicates.ts` | Aynı contentKey, birden fazla AKTİF satır (donmuş dosya ikizi). Asıl mantık `src/lib/contentkey-consolidator.ts`'te (bot her sync sonunda otomatik çalıştırır — B6). Bu CLI sarmalayıcı: `report` / `apply` / `apply-with-removals` | `Aynı maçın mükerrer aktif kaydı — otomatik birleştirme` / `Güncel kadroda yok — mükerrer stale kayıt temizliği` |
| `repair-salon-rename-duplicates.ts` | Salon adı varyasyonu (`PAIRS` dizisinde elle enumerate edilmiş çiftler) | `Salon adı varyasyonu — mükerrer stale kayıt temizliği` |

Yeni bir mükerrer deseni çıkarsa: önce hangi alanın `contentKey`'i değiştirdiğini tespit et
(mac_adi / tarih / saat / salon), sonra ilgili script'i genişlet veya yeni bir hedefli
script yaz — **genel bir "slot bazlı hepsini birleştir" yaklaşımından kaçın** (aynı salonda
peş peşe maç yöneten ekipler yüksek kadro örtüşmesi üretir, yanlış pozitif riski yüksek).

## Git Push Kuralları

- Push öncesi kullanıcıya kısa bir onay sorusu sor.
- Force push / history rewrite kesinlikle yasak.
- Commit mesajlarına AI imzası eklemek konusunda kullanıcıya sor — `bks-web-system` reposunda
  bu açıkça yasaklı (proje kuralı), bu repoda aksi belirtilmediği sürece aynı kural geçerli
  sayılmalı.
