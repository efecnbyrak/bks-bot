import { db } from "../src/db";
import { reconcileAndNotify } from "../src/change-notifier";
import { NewAssignmentInfo } from "../src/user-matcher";
import { CancelledMatchInfo } from "../src/db-writer";

// Uçtan uca bildirim testi — GERÇEK push token'a GERÇEK bildirim gönderir.
// Kullanım:
//   TEST_USER_ID=123 npx ts-node scripts/test-notification-flow.ts assign   -> "Maça Atandınız" bildirimini gönderir, sahte parsedMatch+assignment oluşturur
//   TEST_USER_ID=123 npx ts-node scripts/test-notification-flow.ts cancel  -> az önce oluşturulan atamayı iptal eder, "İptal Edildi" bildirimini gönderir
//   TEST_USER_ID=123 npx ts-node scripts/test-notification-flow.ts change  -> mevcut aktif test maçını iptal edip AYNI ANDA yeni bir maça atar, "Maçınız Değişti" bildirimini test eder
//   TEST_USER_ID=123 npx ts-node scripts/test-notification-flow.ts cleanup -> test verilerini DB'den siler
//
// "assign" ve "cancel" adımları arasında istediğin kadar bekleyebilirsin (örn. 5 dk) —
// her ikisi de ayrı process çalıştırması olduğu için zamanlama tamamen sana bağlı.
// "change" tek başına da çalışır: aktif bir test maçı yoksa önce birini oluşturur.

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
            contentKey: `${TEST_MARKER}_content_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            macAdi,
            tarih: new Date().toLocaleDateString("tr-TR"),
            kategori: "TEST",
            ligTuru: "TEST",
            hakemler: ["TEST KULLANICI"],
            masaGorevlileri: [],
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
        { userId, matchId: match.id, macAdi: match.macAdi, tarih: match.tarih },
    ];

    console.log(`Test maçı oluşturuldu: matchId=${match.id}`);
    console.log("sendAssignmentPush tetikleniyor...");
    await reconcileAndNotify(newAssignments, [], false);
    console.log("Tamamlandı. Telefonuna 'Yeni Maça Atandınız' bildirimi gitmiş olmalı.");
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
        { matchId: oldMatch.id, matchKey: oldMatch.matchKey, macAdi: oldMatch.macAdi, tarih: oldMatch.tarih, affectedUserIds: [userId] },
    ];
    const newAssignments: NewAssignmentInfo[] = [
        { userId, matchId: newMatch.id, macAdi: newMatch.macAdi, tarih: newMatch.tarih },
    ];

    console.log(`Eski maç iptal edildi: matchId=${oldMatch.id} (${oldMatch.macAdi})`);
    console.log(`Yeni maça atandı: matchId=${newMatch.id} (${newMatch.macAdi})`);
    console.log("TEK reconcileAndNotify çağrısıyla 'değişti' mantığı tetikleniyor...");
    await reconcileAndNotify(newAssignments, cancellations, false);
    console.log("Tamamlandı. Telefonuna 'Maçınız Değişti' bildirimi gitmiş olmalı (iptal DEĞİL, atama DEĞİL — sadece değişti).");
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
        { matchId: match.id, matchKey: match.matchKey, macAdi: match.macAdi, tarih: match.tarih, affectedUserIds: [userId] },
    ];

    console.log(`Test maçı iptal edildi: matchId=${match.id}`);
    console.log("sendCancellationPush tetikleniyor...");
    await reconcileAndNotify([], cancellations, false);
    console.log("Tamamlandı. Telefonuna 'Maç İptal Edildi' bildirimi gitmiş olmalı.");
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

    if (!command || !["assign", "cancel", "change", "cleanup"].includes(command)) {
        console.error("Kullanım: TEST_USER_ID=<id> npx ts-node scripts/test-notification-flow.ts <assign|cancel|change|cleanup>");
        process.exit(1);
    }

    if (command !== "cleanup" && (!userId || isNaN(userId))) {
        console.error("TEST_USER_ID env değişkeni geçerli bir sayı olmalı.");
        process.exit(1);
    }

    if (command === "assign") await assign(userId);
    else if (command === "cancel") await cancel(userId);
    else if (command === "change") await change(userId);
    else if (command === "cleanup") await cleanup();

    await db.$disconnect();
}

main().catch(async (err) => {
    console.error("Hata:", err);
    await db.$disconnect();
    process.exit(1);
});
