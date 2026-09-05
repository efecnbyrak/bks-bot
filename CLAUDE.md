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

## MD Dosyalarını Güncel Tutma Kuralı (ZORUNLU)

Bir görev/değişiklik tamamlandıktan sonra bu repodaki ilgili `.md` dosyaları (bu
CLAUDE.md dahil) **kontrol edilip güncel tutulmalı**. Bu kontrol tahmine değil,
sistemden (kod, şema, git durumu) gerçekten okunan bilgiye dayanmalı:

- Yapılan değişiklik CLAUDE.md'deki bir kuralı/varsayımı geçersiz kıldıysa veya
  yeni bir kural gerektiriyorsa (örn. yeni bir şema senkron noktası, yeni bir
  paylaşılan alan/model) — CLAUDE.md güncellenir.
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
   aynı değişiklik döngüsünde gözden geçirilmeli.
4. Periyodik olarak (örn. büyük bir özellik tamamlandığında) iki `schema.prisma` dosyası yan
   yana açılıp model/alan/index listesi karşılaştırılmalı.

## Git Push Kuralları

- Push öncesi kullanıcıya kısa bir onay sorusu sor.
- Force push / history rewrite kesinlikle yasak.
- Commit mesajlarına AI imzası eklemek konusunda kullanıcıya sor — `bks-web-system` reposunda
  bu açıkça yasaklı (proje kuralı), bu repoda aksi belirtilmediği sürece aynı kural geçerli
  sayılmalı.
