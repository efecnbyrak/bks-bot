import crypto from "crypto";
import { db } from "../src/db";
import { reconcileAndNotify, flushDueNotifications } from "../src/notification-outbox";
import { NewAssignmentInfo } from "../src/user-matcher";
import { CancelledMatchInfo, ShiftedAssignmentInfo, parsedRowToMatchData } from "../src/db-writer";
import { MatchData } from "../src/lib/match-parser";
import { formatDayTR } from "../src/lib/notification-text";

// Uçtan uca bildirim testi — GERÇEK push token'a GERÇEK bildirim gönderir ve gerçek
// sistemle AYNI yolu izler (planWithPending → Atama anında, diğerleri teyit kuyruğu →
// flushDueNotifications). Mesajlar canlıdakiyle birebir aynı biçimde gelir.
//
// Kullanım (sırayla çalıştırılması önerilir):
//   TEST_USER_ID=9 npx ts-node scripts/test-notification-flow.ts assign      → 🔔 Maç Atamanız Geldi!            (anında)
//   TEST_USER_ID=9 npx ts-node scripts/test-notification-flow.ts update      → 📝 Maçınız Güncellendi             ("Yardımcı Hakem: A yerine B geldi")
//   TEST_USER_ID=9 npx ts-node scripts/test-notification-flow.ts reschedule  → 📝 Maçınız Güncellendi             ("📅 Tarih: … → …", "⏰ Saat: … → …")
//   TEST_USER_ID=9 npx ts-node scripts/test-notification-flow.ts change      → 🔄 Atamanızda Değişiklik Var        (aynı gün başka maç)
//   TEST_USER_ID=9 npx ts-node scripts/test-notification-flow.ts cancel      → ❌ Maç Atamanız İptal Edildi
//   TEST_USER_ID=9 npx ts-node scripts/test-notification-flow.ts glitch      → HİÇ bildirim gelmemeli (yarım düzenleme: çıkarıldı + geri yazıldı)
//   npx ts-node scripts/test-notification-flow.ts cleanup                    → test maçlarını ve test "Maç İadesi" duyurularını siler
//
// Test maçları SADECE `kaynakDosya = TEST_MARKER` satırlarıdır; gerçek maçlara, atamalara ve
// "ödendi" işaretlerine hiçbir komut dokunmaz. Görevli isimleri kurgusaldır ("DENEME" soyadı),
// gerçek bir kişiyle (telefon rehberi eşleşmesi) karışmasın diye. `tarihDate` bilinçli olarak
// boş bırakılır: Ek Ödeme dağıtımı (`tarihDate ≤ şimdi`) test maçını asla saymaz.
// Teyit kuyruğunda bekleme olmasın diye SADECE test kullanıcısının kayıtları hemen işletilir
// (canlı kuyruktaki diğer kayıtlar erkene alınmaz).

const TEST_MARKER = "__TEST_NOTIFICATION_FLOW__";

// Canlıdaki bir Yerel Lig maçının birebir biçimi. İlk hakem koltuğuna test kullanıcısının
// kendi adı yazılır (gerçekte de atama ismin listede olmasıyla kurulur).
const MATCH_A = "DENEME SPOR (A) - ÖRNEK BASKET";
const MATCH_B = "YILDIZ DENEME SK - ÖRNEK KOLEJİ (B)";
const LIG = "Yerel Lig";
const KATEGORI = "U14EB";
const SALON = "DENEME SPOR SALONU";
const SAAT = "18:00";
const OTHERS = {
    yardimci: "AHMET DENEME",
    yeniYardimci: "MURAT DENEME",
    masa: ["AYŞE DENEME", "MEHMET DENEME", "ELİF DENEME"],
    istatistik: ["CAN DENEME"],
    saglik: ["ZEYNEP DENEME"],
    gozlemci: ["HASAN DENEME"],
    komiser: ["SELİN DENEME"],
};

// dd.MM.yyyy — "maç başladı" kuralı (geçmiş maça bildirim yok) testi düşürmesin diye ileri tarih.
function dayFromNow(days: number): string {
    const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
}

interface TestUser { userId: number; name: string; isReferee: boolean }

// Test kullanıcısının profil adı — hakemse Baş Hakem, görevliyse Sayı Görevlisi koltuğuna yazılır.
async function loadUser(userId: number): Promise<TestUser> {
    const u = await db.user.findUnique({
        where: { id: userId },
        select: {
            referee: { select: { firstName: true, lastName: true } },
            official: { select: { firstName: true, lastName: true } },
        },
    });
    const p = u?.referee ?? u?.official;
    if (!p) throw new Error(`userId=${userId} için hakem/görevli profili bulunamadı`);
    return { userId, name: `${p.firstName} ${p.lastName}`.toLocaleUpperCase("tr"), isReferee: !!u?.referee };
}

interface Squad { hakemler: string[]; masa: string[] }

function squadFor(user: TestUser, yardimci = OTHERS.yardimci): Squad {
    return user.isReferee
        ? { hakemler: [user.name, yardimci], masa: OTHERS.masa }
        : { hakemler: [OTHERS.yardimci, yardimci === OTHERS.yardimci ? OTHERS.yeniYardimci : yardimci], masa: [user.name, ...OTHERS.masa.slice(1)] };
}

async function createMatch(user: TestUser, opts: { macAdi: string; tarih: string; saat: string; squad: Squad }) {
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
            // contentKey kolonu VarChar(32) — worker'ın computeContentKey'i gibi sha256'nın ilk 32 karakteri
            contentKey: crypto.createHash("sha256")
                .update(`${TEST_MARKER}|${opts.macAdi}|${opts.tarih}|${opts.saat}|${Math.random()}`)
                .digest("hex").substring(0, 32),
            macAdi: opts.macAdi,
            tarih: opts.tarih,
            saat: opts.saat,
            salon: SALON,
            kategori: KATEGORI,
            ligTuru: LIG,
            hakemler: opts.squad.hakemler,
            masaGorevlileri: opts.squad.masa,
            saglikcilar: OTHERS.saglik,
            istatistikciler: OTHERS.istatistik,
            gozlemciler: OTHERS.gozlemci,
            sahaKomiserleri: OTHERS.komiser,
            kaynakDosya: TEST_MARKER,
            driveFileId: driveFile.id,
        },
    });

    await db.userMatchAssignment.create({
        data: { userId: user.userId, matchId: match.id, role: user.isReferee ? "hakem" : "masa", nameInSpreadsheet: user.name },
    });
    return match;
}

type Row = Awaited<ReturnType<typeof createMatch>>;

// En son aktif test maçı; yoksa yarın 18:00'e bir tane kurar (her komut tek başına çalışabilsin).
async function activeMatchOrCreate(user: TestUser): Promise<Row> {
    const m = await db.parsedMatch.findFirst({
        where: { kaynakDosya: TEST_MARKER, cancelledAt: null, userAssignments: { some: { userId: user.userId } } },
        orderBy: { id: "desc" },
    });
    if (m) return m;
    console.log("Aktif test maçı yok, önce bir tane oluşturuluyor (sessiz)...");
    return createMatch(user, { macAdi: MATCH_A, tarih: dayFromNow(1), saat: SAAT, squad: squadFor(user) });
}

const data = (r: Row): MatchData => parsedRowToMatchData(r);

function asAssignment(user: TestUser, r: Row): NewAssignmentInfo {
    return { userId: user.userId, matchId: r.id, macAdi: r.macAdi, tarih: r.tarih, saat: r.saat, contentKey: r.contentKey, matchData: data(r) };
}

function asCancellation(user: TestUser, r: Row): CancelledMatchInfo {
    return {
        matchId: r.id, matchKey: r.matchKey, macAdi: r.macAdi, tarih: r.tarih, saat: r.saat,
        affectedUserIds: [user.userId], contentKey: r.contentKey, matchData: data(r),
    };
}

// Gerçek sistemde iptal edilen satır cancelledAt alır ve kişinin ataması silinir — aynısı.
async function removeFromMatch(user: TestUser, r: Row, reason: string) {
    await db.userMatchAssignment.deleteMany({ where: { userId: user.userId, matchId: r.id } });
    await db.parsedMatch.update({ where: { id: r.id }, data: { cancelledAt: new Date(), cancelReason: reason } });
}

async function confirmNow(userId: number) {
    const n = await db.matchNotificationOutbox.updateMany({ where: { userId, status: "PENDING" }, data: { dueAt: new Date() } });
    console.log(`Teyit kuyruğu: test kullanıcısının ${n.count} bekleyen kaydı hemen işleniyor (canlıda 10 dk bekler)...`);
    await flushDueNotifications();
}

async function assign(user: TestUser) {
    const r = await createMatch(user, { macAdi: MATCH_A, tarih: dayFromNow(1), saat: SAAT, squad: squadFor(user) });
    console.log(`Maç kuruldu: ${r.macAdi} · ${formatDayTR(r.tarih)} ${r.saat}`);
    await reconcileAndNotify([asAssignment(user, r)], [], false);
    console.log("Beklenen: 🔔 Maç Atamanız Geldi! (anında)");
}

async function update(user: TestUser) {
    const r = await activeMatchOrCreate(user);
    const oldData = data(r);
    // Federasyon Yardımcı Hakemi değiştirdi: DB satırı da güncellenir (teyit farkı güncel satırdan hesaplar).
    const yardimci = r.hakemler.includes(OTHERS.yeniYardimci) ? OTHERS.yardimci : OTHERS.yeniYardimci;
    const newSquad = squadFor(user, yardimci);
    const updated = await db.parsedMatch.update({ where: { id: r.id }, data: { hakemler: newSquad.hakemler } });
    const shifted: ShiftedAssignmentInfo[] = [{
        userId: user.userId, macAdi: r.macAdi, tarih: r.tarih, saat: r.saat, contentKey: r.contentKey,
        oldMatchData: oldData, newMatchData: data(updated),
    }];
    await reconcileAndNotify([], [], false, shifted);
    await confirmNow(user.userId);
    console.log(`Beklenen: 📝 Maçınız Güncellendi — "Yardımcı Hakem: ${oldData.hakemler[1]} yerine ${newSquad.hakemler[1]} geldi"`);
}

async function reschedule(user: TestUser) {
    const r = await activeMatchOrCreate(user);
    // Aynı maç (aynı takımlar) başka güne ve saate alındı: gerçekte contentKey değişir →
    // eski satır iptal + yeni satıra atama gelir, sistem bunu "Güncellendi" sayar.
    const newSaat = r.saat === "20:00" ? SAAT : "20:00";
    const newTarih = dayFromNow(r.tarih === dayFromNow(1) ? 2 : 1);
    await removeFromMatch(user, r, "Test: tarih/saat değişti");
    const n = await createMatch(user, {
        macAdi: r.macAdi, tarih: newTarih, saat: newSaat,
        squad: { hakemler: r.hakemler, masa: r.masaGorevlileri },
    });
    await reconcileAndNotify([asAssignment(user, n)], [asCancellation(user, r)], false);
    await confirmNow(user.userId);
    console.log(`Beklenen: 📝 Maçınız Güncellendi — "📅 Tarih: ${formatDayTR(r.tarih)} → ${formatDayTR(newTarih)}", "⏰ Saat: ${r.saat} → ${newSaat}"`);
}

async function change(user: TestUser) {
    const r = await activeMatchOrCreate(user);
    // Aynı GÜN farklı bir maça kaydırıldı → Değişiklik.
    const other = r.macAdi === MATCH_A ? MATCH_B : MATCH_A;
    await removeFromMatch(user, r, "Test: başka maça değiştirildi");
    const n = await createMatch(user, { macAdi: other, tarih: r.tarih, saat: r.saat === SAAT ? "20:00" : SAAT, squad: squadFor(user) });
    await reconcileAndNotify([asAssignment(user, n)], [asCancellation(user, r)], false);
    await confirmNow(user.userId);
    console.log(`Beklenen: 🔄 Atamanızda Değişiklik Var — yeni maç ${other}, eski maç ${r.macAdi}`);
}

async function cancel(user: TestUser) {
    const r = await activeMatchOrCreate(user);
    await removeFromMatch(user, r, "Test iptali");
    await reconcileAndNotify([], [asCancellation(user, r)], false);
    await confirmNow(user.userId);
    console.log("Beklenen: ❌ Maç Atamanız İptal Edildi (+ Duyurular'da test 'Maç İadesi' kaydı, cleanup siler)");
}

async function glitch(user: TestUser) {
    const r = await activeMatchOrCreate(user);
    // 29 Ekim senaryosu: federasyon düzenlerken isim bir an silindi (iptal kuyruğa girer)...
    await db.userMatchAssignment.deleteMany({ where: { userId: user.userId, matchId: r.id } });
    await reconcileAndNotify([], [asCancellation(user, r)], false);
    // ...birkaç dakika sonra aynı maça geri yazıldı (yeni atama olarak gelir).
    await db.userMatchAssignment.create({
        data: { userId: user.userId, matchId: r.id, role: user.isReferee ? "hakem" : "masa", nameInSpreadsheet: user.name },
    });
    await reconcileAndNotify([asAssignment(user, r)], [], false);
    await confirmNow(user.userId);
    const last = await db.matchNotificationOutbox.findFirst({
        where: { userId: user.userId }, orderBy: { id: "desc" }, select: { status: true, dropReason: true },
    });
    console.log(`Kuyruk sonucu: ${last?.status} — ${last?.dropReason ?? ""}`);
    console.log("Beklenen: HİÇ bildirim gelmemeli (kayıt DROPPED, 'Aynı turda yeniden atandı')");
}

async function cleanup() {
    const files = await db.driveFile.findMany({ where: { fileName: TEST_MARKER } });
    for (const f of files) {
        await db.parsedMatch.deleteMany({ where: { driveFileId: f.id } });
        await db.driveFile.delete({ where: { id: f.id } });
    }
    // İptal testlerinin ürettiği otomatik "Maç İadesi" duyuruları (sadece test maç adları).
    const ann = await db.announcement.deleteMany({
        where: {
            senderId: null,
            subject: { in: [MATCH_A, MATCH_B, "TEST A vs TEST B", "TEST G vs TEST H"].map(m => `Maç İadesi: ${m}`) },
        },
    });
    console.log(`Temizlendi: ${files.length} test dosyası (+ maç/atamalar), ${ann.count} test duyurusu.`);
}

const COMMANDS = ["assign", "update", "reschedule", "change", "cancel", "glitch", "cleanup"] as const;
type Command = (typeof COMMANDS)[number];

async function main() {
    const command = process.argv[2] as Command;
    if (!COMMANDS.includes(command)) {
        console.error(`Kullanım: TEST_USER_ID=<id> npx ts-node scripts/test-notification-flow.ts <${COMMANDS.join("|")}>`);
        process.exit(1);
    }
    if (command === "cleanup") {
        await cleanup();
    } else {
        const userId = parseInt(process.env.TEST_USER_ID || "", 10);
        if (!userId || isNaN(userId)) {
            console.error("TEST_USER_ID env değişkeni geçerli bir sayı olmalı.");
            process.exit(1);
        }
        const user = await loadUser(userId);
        console.log(`Test kullanıcısı: ${user.name} (userId=${userId})`);
        const run = { assign, update, reschedule, change, cancel, glitch }[command];
        await run(user);
    }
    await db.$disconnect();
}

main().catch(async (err) => {
    console.error("Hata:", err);
    await db.$disconnect();
    process.exit(1);
});
