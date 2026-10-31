import crypto from "crypto";
import { db } from "../src/db";
import { reconcileAndNotify, flushDueNotifications } from "../src/notification-outbox";
import { formatDayTR } from "../src/lib/notification-text";
import { NewAssignmentInfo } from "../src/user-matcher";
import { CancelledMatchInfo, ShiftedAssignmentInfo } from "../src/db-writer";
import { MatchData } from "../src/lib/match-parser";

// Test maçının sabit bilgileri — bildirim metninde maç detayının (kategori, salon,
// görevliler) nasıl göründüğünü telefonda kontrol edebilmek için dolu tutuluyor.
// Tarih YARIN: "maç başladı" kuralı (geçmiş maça bildirim yok) testi düşürmesin.
const TEST_SAAT = "18:00";
const TEST_SALON = "TEST SALONU";
const TEST_KATEGORI = "U14EB";
const TEST_HAKEMLER = ["TEST KULLANICI", "TEST ESKİ HAKEM"];
const TEST_MASA = ["TEST SAYI", "TEST SAAT", "TEST ŞUT SAATİ"];

function testTarih(): string {
    const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

function stubMatchData(macAdi: string, tarih: string, hakemler: string[] = TEST_HAKEMLER): MatchData {
    return {
        mac_adi: macAdi, tarih, saat: TEST_SAAT, salon: TEST_SALON,
        kategori: TEST_KATEGORI, ligTuru: "TEST",
        hakemler, masa_gorevlileri: TEST_MASA, saglikcilar: [],
        istatistikciler: [], gozlemciler: [], sahaKomiserleri: [],
        kaynak_dosya: TEST_MARKER,
    };
}

// İptal / Güncellendi / Değişiklik artık teyit kuyruğunda 10 dk bekliyor. Testte
// beklememek için SADECE bu test kullanıcısının bekleyen kayıtlarını şimdiye çekip
// kuyruğu işletiyoruz — canlı kuyruktaki diğer kayıtlar erkene alınmaz.
async function confirmNow(userId: number) {
    const n = await db.matchNotificationOutbox.updateMany({
        where: { userId, status: "PENDING" },
        data: { dueAt: new Date() },
    });
    console.log(`Teyit kuyruğu: test kullanıcısının ${n.count} bekleyen kaydı hemen işleniyor...`);
    await flushDueNotifications();
}

// Uçtan uca bildirim testi — GERÇEK push token'a GERÇEK bildirim gönderir.
// Kullanım:
//   TEST_USER_ID=123 npx ts-node scripts/test-notification-flow.ts assign   -> "Maça Atandınız" bildirimini gönderir, sahte parsedMatch+assignment oluşturur
//   TEST_USER_ID=123 npx ts-node scripts/test-notification-flow.ts cancel  -> az önce oluşturulan atamayı iptal eder, "İptal Edildi" bildirimini gönderir
//   TEST_USER_ID=123 npx ts-node scripts/test-notification-flow.ts change  -> mevcut aktif test maçını iptal edip AYNI ANDA yeni bir maça atar, "Maçınız Değişti" bildirimini test eder
//   TEST_USER_ID=123 npx ts-node scripts/test-notification-flow.ts update  -> kullanıcı AYNI maçta kalır, sadece kadrosu değişir (ROW_SHIFTED), "Maçınız Güncellendi" bildirimini test eder
//   TEST_USER_ID=123 npx ts-node scripts/test-notification-flow.ts cleanup -> test verilerini DB'den siler
//
// "assign" ve "cancel" adımları arasında istediğin kadar bekleyebilirsin (örn. 5 dk) —
// her ikisi de ayrı process çalıştırması olduğu için zamanlama tamamen sana bağlı.
// "change" ve "update" tek başına da çalışır: aktif bir test maçı yoksa önce birini oluşturur.

const TEST_MARKER = "__TEST_NOTIFICATION_FLOW__";

async function createTestMatchAndAssignment(userId: number, macAdi: string) {
    const driveFile = await db.driveFile.create({
        data: {
            driveFileId: `${TEST_MARKER}_FILE_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            driveFolderKey: "current",
            fileName: TEST_MARKER,
            mimeType: "test",
            isActive: true,
        },
    });

    const match = await db.parsedMatch.create({
        data: {
            matchKey: `${TEST_MARKER}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            // contentKey kolonu @db.VarChar(32) — worker'ın computeContentKey'i gibi
            // sha256'nın ilk 32 karakteri kullanılır (aksi halde P2000 "value too long")
            contentKey: crypto
                .createHash("sha256")
                .update(`${TEST_MARKER}|${macAdi}|${Date.now()}|${Math.random()}`)
                .digest("hex")
                .substring(0, 32),
            macAdi,
            tarih: testTarih(),
            saat: TEST_SAAT,
            salon: TEST_SALON,
            kategori: TEST_KATEGORI,
            ligTuru: "TEST",
            hakemler: TEST_HAKEMLER,
            masaGorevlileri: TEST_MASA,
            saglikcilar: [],
            istatistikciler: [],
            gozlemciler: [],
            sahaKomiserleri: [],
            kaynakDosya: TEST_MARKER,
            driveFileId: driveFile.id,
        },
    });

    await db.userMatchAssignment.create({
        data: {
            userId,
            matchId: match.id,
            role: "hakem",
            nameInSpreadsheet: "TEST KULLANICI",
        },
    });

    return match;
}

async function assign(userId: number) {
    const match = await createTestMatchAndAssignment(userId, "TEST A vs TEST B");

    const newAssignments: NewAssignmentInfo[] = [
        {
            userId, matchId: match.id, macAdi: match.macAdi, tarih: match.tarih,
            contentKey: match.contentKey, matchData: stubMatchData(match.macAdi, match.tarih),
        },
    ];

    console.log(`Test maçı oluşturuldu: matchId=${match.id}`);
    console.log(`Atama bildirimi tetikleniyor (maç günü: ${formatDayTR(match.tarih)})...`);
    await reconcileAndNotify(newAssignments, [], false);
    console.log("Tamamlandı. Telefonuna '🔔 Maç Atamanız Geldi!' bildirimi anında gitmiş olmalı.");
}

async function change(userId: number) {
    // Kullanıcının hâlâ aktif bir test ataması var mı — yoksa önce bir tane oluştur
    // (kullanıcı "assign" çalıştırmadan direkt "change" çağırırsa da test çalışsın diye).
    let oldMatch = await db.parsedMatch.findFirst({
        where: { kaynakDosya: TEST_MARKER, cancelledAt: null },
        orderBy: { createdAt: "desc" },
    });

    if (!oldMatch) {
        console.log("Aktif test maçı yok, önce eski maç (TEST A vs TEST B) oluşturuluyor...");
        oldMatch = await createTestMatchAndAssignment(userId, "TEST A vs TEST B");
    }

    // Eski maçı iptal et
    await db.parsedMatch.update({
        where: { id: oldMatch.id },
        data: { cancelledAt: new Date(), cancelReason: "Test: başka maça değiştirildi" },
    });

    // Aynı anda yeni bir maça ata — federasyonun "17:00'da A vs B'ye koydu, 17:30'da
    // G vs H'ye taşıdı" senaryosunu simüle eder.
    const newMatch = await createTestMatchAndAssignment(userId, "TEST G vs TEST H");

    const cancellations: CancelledMatchInfo[] = [
        {
            matchId: oldMatch.id, matchKey: oldMatch.matchKey, macAdi: oldMatch.macAdi,
            tarih: oldMatch.tarih, saat: oldMatch.saat, affectedUserIds: [userId], contentKey: oldMatch.contentKey,
            matchData: stubMatchData(oldMatch.macAdi, oldMatch.tarih),
        },
    ];
    const newAssignments: NewAssignmentInfo[] = [
        {
            userId, matchId: newMatch.id, macAdi: newMatch.macAdi, tarih: newMatch.tarih,
            contentKey: newMatch.contentKey, matchData: stubMatchData(newMatch.macAdi, newMatch.tarih),
        },
    ];

    console.log(`Eski maç iptal edildi: matchId=${oldMatch.id} (${oldMatch.macAdi})`);
    console.log(`Yeni maça atandı: matchId=${newMatch.id} (${newMatch.macAdi})`);
    console.log("TEK reconcileAndNotify çağrısıyla 'değişti' mantığı tetikleniyor...");
    await reconcileAndNotify(newAssignments, cancellations, false);
    await confirmNow(userId);
    console.log("Tamamlandı. Telefonuna '🔄 Atamanızda Değişiklik Var' bildirimi gitmiş olmalı (iptal DEĞİL, atama DEĞİL).");
}

async function update(userId: number) {
    // Kullanıcının hâlâ aktif bir test ataması var mı — yoksa önce bir tane oluştur
    // (change() ile aynı desen: "update" tek başına da çalışsın diye).
    let match = await db.parsedMatch.findFirst({
        where: { kaynakDosya: TEST_MARKER, cancelledAt: null },
        orderBy: { createdAt: "desc" },
    });

    if (!match) {
        console.log("Aktif test maçı yok, önce oluşturuluyor (TEST A vs TEST B)...");
        match = await createTestMatchAndAssignment(userId, "TEST A vs TEST B");
    }

    // Gerçek ROW_SHIFTED senaryosu: kullanıcı AYNI maçta kalıyor, sadece Yardımcı Hakem
    // değişiyor ("TEST ESKİ HAKEM yerine TEST YENİ HAKEM geldi"). Boş yere ekleme artık
    // bildirim üretmediği için senaryo bir DEĞİŞİM olmak zorunda. Teyit adımı farkı DB'nin
    // güncel satırından yeniden hesapladığı için satırın kadrosu da güncellenir.
    const newHakemler = ["TEST KULLANICI", "TEST YENİ HAKEM"];
    await db.parsedMatch.update({ where: { id: match.id }, data: { hakemler: newHakemler } });
    const oldMatchData = stubMatchData(match.macAdi, match.tarih, TEST_HAKEMLER);
    const newMatchData = stubMatchData(match.macAdi, match.tarih, newHakemler);

    const shifted: ShiftedAssignmentInfo[] = [
        {
            userId, macAdi: match.macAdi, tarih: match.tarih, contentKey: match.contentKey,
            oldMatchData, newMatchData,
        },
    ];

    console.log(`Mevcut test maçı kadrosu güncelleniyor: matchId=${match.id} (${match.macAdi})`);
    console.log("TEK reconcileAndNotify çağrısıyla ROW_SHIFTED mantığı tetikleniyor...");
    await reconcileAndNotify([], [], false, shifted);
    await confirmNow(userId);
    console.log("Tamamlandı. Telefonuna '📝 Maçınız Güncellendi' bildirimi gitmiş olmalı (Yardımcı Hakem: TEST ESKİ HAKEM yerine TEST YENİ HAKEM geldi).");
}

async function cancel(userId: number) {
    const match = await db.parsedMatch.findFirst({
        where: { kaynakDosya: TEST_MARKER, cancelledAt: null },
        orderBy: { createdAt: "desc" },
    });

    if (!match) {
        console.error("Aktif bir test maçı bulunamadı. Önce 'assign' komutunu çalıştır.");
        process.exit(1);
    }

    await db.parsedMatch.update({
        where: { id: match.id },
        data: { cancelledAt: new Date(), cancelReason: "Test iptali" },
    });

    const cancellations: CancelledMatchInfo[] = [
        {
            matchId: match.id, matchKey: match.matchKey, macAdi: match.macAdi,
            tarih: match.tarih, saat: match.saat, affectedUserIds: [userId], contentKey: match.contentKey,
            matchData: stubMatchData(match.macAdi, match.tarih),
        },
    ];

    console.log(`Test maçı iptal edildi: matchId=${match.id}`);
    console.log("İptal bildirimi kuyruğa yazılıyor...");
    await reconcileAndNotify([], cancellations, false);
    await confirmNow(userId);
    console.log("Tamamlandı. Telefonuna '❌ Maç Atamanız İptal Edildi' bildirimi gitmiş olmalı.");
}

async function cleanup() {
    const files = await db.driveFile.findMany({ where: { fileName: TEST_MARKER } });
    for (const f of files) {
        await db.parsedMatch.deleteMany({ where: { driveFileId: f.id } });
        await db.driveFile.delete({ where: { id: f.id } });
    }
    console.log(`Temizlendi: ${files.length} test dosyası ve ilişkili maç/atama kayıtları silindi.`);
}

async function main() {
    const command = process.argv[2];
    const userId = parseInt(process.env.TEST_USER_ID || "", 10);

    if (!command || !["assign", "cancel", "change", "update", "cleanup"].includes(command)) {
        console.error("Kullanım: TEST_USER_ID=<id> npx ts-node scripts/test-notification-flow.ts <assign|cancel|change|update|cleanup>");
        process.exit(1);
    }

    if (command !== "cleanup" && (!userId || isNaN(userId))) {
        console.error("TEST_USER_ID env değişkeni geçerli bir sayı olmalı.");
        process.exit(1);
    }

    if (command === "assign") await assign(userId);
    else if (command === "cancel") await cancel(userId);
    else if (command === "change") await change(userId);
    else if (command === "update") await update(userId);
    else if (command === "cleanup") await cleanup();

    await db.$disconnect();
}

main().catch(async (err) => {
    console.error("Hata:", err);
    await db.$disconnect();
    process.exit(1);
});
