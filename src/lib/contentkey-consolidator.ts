import { db } from "../db";
import { nameMatches } from "./match-parser";
import { logger } from "../logger";

/**
 * KONSOLİDASYON — "aynı maç, birden fazla AKTİF ParsedMatch satırı" (aynı contentKey).
 *
 * ARKA PLAN (B6): Federasyon bir maçın kadrosunu kademeli doldurunca (`matchKey` personeli
 * içerdiği için) her adımda YENİ bir ParsedMatch satırı açılıyor. `detectAndMarkCancelledMatches`
 * (`src/db-writer.ts`) bu ikizleri kanonik satıra toplayıp boşalanı iptal ediyor — AMA yalnızca
 * `filesChanged` olan dosyalar için, o dosya her sync'te işlenirken (`src/orchestrator.ts`
 * `toProcess` döngüsü). Bir dosya donarsa (örn. drive 901 "1.HAFTA_R1") o dosyanın ikizleri
 * HİÇ birleşmiyor → kullanıcı "Maçlarım"da aynı maçı 2-3 kez görüyor, web dedup gizlese bile
 * DB'de kalıntı büyüyor.
 *
 * Bu modül, `src/index.ts`'te her sync'in SONUNDA (tüm klasörler işlendikten,
 * `reconcileAndNotify`'dan SONRA) tüm DB'yi tarayıp güvenli birleştirmeyi yapar. BİLDİRİM
 * ÜRETMEZ — atama zaten kullanıcıda kalıyor, sadece hangi ParsedMatch satırına bağlı olduğu
 * değişiyor. Ayrıca aynı mantık `scripts/consolidate-active-contentkey-duplicates.ts` CLI'ında
 * elle çalıştırılabilir (report / apply / apply-with-removals).
 *
 * KAPSAM: Sadece aynı contentKey'e sahip, birden fazla aktif satır olan gruplar. Kanonik =
 * kadrosu en dolu satır (eşitlikte createdAt en yeni — bot'un `decideAssignmentOutcomes`
 * mantığıyla aynı). Kanonik-dışı satırlardaki atamalar:
 *   - kullanıcının kanonikte zaten ataması varsa            -> kanonik-dışı atama SİLİNİR (dupe)
 *   - kişi kanonik kadroda ismen VARSA                       -> atama kanoniğe TAŞINIR
 *   - kişi kanonik kadroda YOK ama başka bir aktif kardeşte  -> atama SİLİNİR (o kardeşte duruyor)
 *   - kişi HİÇBİR aktif kardeşte yok                          -> BELİRSİZ (gerçek çıkarılma)
 *                                                              otomatik akış DOKUNMAZ;
 *                                                              yalnızca CLI apply-with-removals siler
 *
 * GÜVENLİK: Sadece `user_match_assignments.matchId`/silme ve boşalan kaynak satırların
 * `cancelledAt`/`cancelReason`'ı. Kanonik satırın alanlarına (kadro/isim/tarih), uygunluk
 * formu / kullanıcı profili / duyuru tablolarına HİÇ dokunmaz. `userId_matchId` unique guard'ı
 * çift atama üretmeyi imkânsız kılar. Otomatik akış BELİRSİZ atamalara ASLA dokunmaz.
 */

export const CANCEL_REASON = "Aynı maçın mükerrer aktif kaydı — otomatik birleştirme";
export const CANCEL_REASON_REMOVAL = "Güncel kadroda yok — mükerrer stale kayıt temizliği";

// NOTIFY_DRY_RUN=1 → hiçbir DB yazması yapılmaz; kararlar sadece loglanır/döndürülür.
// Bot'un geri kalanıyla (change-notifier, db-writer) aynı konvansiyon.
const ENV_DRY_RUN = process.env.NOTIFY_DRY_RUN === "1";

// ============================================================
// SAF PLANLAMA (DB'siz, test edilebilir)
// ============================================================

export interface ConsolidatorRow {
    id: number;
    contentKey: string;
    macAdi: string;
    tarih: string;
    saat: string | null;
    salon: string | null;
    createdAt: Date;
    hakemler: string[];
    masaGorevlileri: string[];
    saglikcilar: string[];
    istatistikciler: string[];
    gozlemciler: string[];
    sahaKomiserleri: string[];
}

export interface ConsolidatorAssignment {
    id: number;
    userId: number;
    matchId: number;
    nameInSpreadsheet: string;
    firstName?: string;
    lastName?: string;
}

export type MoveAction = "MOVE" | "DELETE_DUPE" | "DELETE_ON_SIBLING";

export interface MovePlan {
    assignmentId: number;
    userId: number;
    nameInSpreadsheet: string;
    fromRowId: number;
    action: MoveAction;
}

export interface AmbiguousAssignment {
    assignmentId: number;
    userId: number;
    nameInSpreadsheet: string;
    fromRowId: number;
}

export interface GroupPlan {
    contentKey: string;
    macAdi: string;
    tarih: string;
    saat: string | null;
    salon: string | null;
    canonicalRowId: number;
    rowIds: number[];
    moves: MovePlan[];
    // Belirsiz = gerçek çıkarılma: kişi kanonik kadroda YOK ve hiçbir aktif kardeşte YOK.
    // Otomatik akış ve CLI `apply` DOKUNMAZ; yalnızca CLI `apply-with-removals` siler.
    ambiguous: AmbiguousAssignment[];
}

function personCount(r: ConsolidatorRow): number {
    return r.hakemler.length + r.masaGorevlileri.length + r.saglikcilar.length +
        r.istatistikciler.length + r.gozlemciler.length + r.sahaKomiserleri.length;
}

function everyoneIn(r: ConsolidatorRow): string[] {
    return [...r.hakemler, ...r.masaGorevlileri, ...r.saglikcilar,
        ...r.istatistikciler, ...r.gozlemciler, ...r.sahaKomiserleri];
}

function personIsInRow(a: ConsolidatorAssignment, r: ConsolidatorRow): boolean {
    const target = a.nameInSpreadsheet.trim().toLowerCase();
    const everyone = everyoneIn(r);
    if (everyone.some(n => n.trim().toLowerCase() === target)) return true;
    if (a.firstName && a.lastName) {
        return everyone.some(n => nameMatches(n, a.firstName!, a.lastName!));
    }
    return false;
}

// Kadrosu en dolu satır; eşitlikte createdAt en yeni (federasyonun son güncellediği satır).
function pickCanonical(rows: ConsolidatorRow[]): ConsolidatorRow {
    return rows.reduce((best, r) => {
        const bp = personCount(best), rp = personCount(r);
        if (rp !== bp) return rp > bp ? r : best;
        return r.createdAt > best.createdAt ? r : best;
    });
}

/**
 * SAF: contentKey'e göre grupla, her grup için kanonik seç, kanonik-dışı atamaları sınıflandır.
 * `assignmentsByRowId` = ParsedMatch.id → o satırdaki atamalar. DB'ye hiç dokunmaz.
 */
export function planConsolidation(
    rows: ConsolidatorRow[],
    assignmentsByRowId: Map<number, ConsolidatorAssignment[]>
): GroupPlan[] {
    const byContentKey = new Map<string, ConsolidatorRow[]>();
    for (const r of rows) {
        const arr = byContentKey.get(r.contentKey) ?? [];
        arr.push(r);
        byContentKey.set(r.contentKey, arr);
    }

    const plans: GroupPlan[] = [];

    for (const [ck, groupRows] of byContentKey) {
        if (groupRows.length < 2) continue;

        const canonical = pickCanonical(groupRows);
        const rowIds = groupRows.map(r => r.id);

        const assignments: ConsolidatorAssignment[] = [];
        for (const rid of rowIds) {
            for (const a of assignmentsByRowId.get(rid) ?? []) assignments.push(a);
        }
        if (assignments.length === 0) continue;

        const canonicalUserIds = new Set(
            assignments.filter(a => a.matchId === canonical.id).map(a => a.userId)
        );
        const otherRows = groupRows.filter(r => r.id !== canonical.id);

        const moves: MovePlan[] = [];
        const ambiguous: AmbiguousAssignment[] = [];

        for (const a of assignments) {
            if (a.matchId === canonical.id) continue;

            if (canonicalUserIds.has(a.userId)) {
                // Kullanıcının kanonikte zaten ataması var → bu kanonik-dışı atama saf dupe.
                moves.push({ assignmentId: a.id, userId: a.userId, nameInSpreadsheet: a.nameInSpreadsheet, fromRowId: a.matchId, action: "DELETE_DUPE" });
                continue;
            }
            if (personIsInRow(a, canonical)) {
                // Kişi kanonik (son) kadroda var → atamayı kanoniğe taşı.
                moves.push({ assignmentId: a.id, userId: a.userId, nameInSpreadsheet: a.nameInSpreadsheet, fromRowId: a.matchId, action: "MOVE" });
                continue;
            }
            // Kişi kanonikte yok. Aynı maçın BAŞKA bir aktif satırında (kardeş) duruyor mu?
            const onSibling = otherRows.some(r => r.id !== a.matchId && personIsInRow(a, r));
            if (onSibling) {
                moves.push({ assignmentId: a.id, userId: a.userId, nameInSpreadsheet: a.nameInSpreadsheet, fromRowId: a.matchId, action: "DELETE_ON_SIBLING" });
                continue;
            }
            // Hiçbir aktif kardeşte yok → gerçek çıkarılma. Otomatik akış DOKUNMAZ.
            ambiguous.push({ assignmentId: a.id, userId: a.userId, nameInSpreadsheet: a.nameInSpreadsheet, fromRowId: a.matchId });
        }

        if (moves.length === 0 && ambiguous.length === 0) continue;

        plans.push({
            contentKey: ck, macAdi: canonical.macAdi, tarih: canonical.tarih,
            saat: canonical.saat, salon: canonical.salon,
            canonicalRowId: canonical.id, rowIds, moves, ambiguous,
        });
    }

    return plans;
}

// ============================================================
// DB OKUMA
// ============================================================

export async function loadConsolidationPlans(): Promise<GroupPlan[]> {
    const rows = (await db.parsedMatch.findMany({
        where: { cancelledAt: null, contentKey: { not: null } },
        select: {
            id: true, contentKey: true, macAdi: true, tarih: true, saat: true, salon: true, createdAt: true,
            hakemler: true, masaGorevlileri: true, saglikcilar: true,
            istatistikciler: true, gozlemciler: true, sahaKomiserleri: true,
        },
    })) as unknown as ConsolidatorRow[];

    // Aynı contentKey'den >1 satırı olan grupların satır id'leri
    const byCk = new Map<string, number[]>();
    for (const r of rows) {
        const arr = byCk.get(r.contentKey) ?? [];
        arr.push(r.id);
        byCk.set(r.contentKey, arr);
    }
    const multiRowIds = [...byCk.values()].filter(ids => ids.length >= 2).flat();
    if (multiRowIds.length === 0) return [];

    const rawAssignments = await db.userMatchAssignment.findMany({
        where: { matchId: { in: multiRowIds } },
        select: {
            id: true, userId: true, matchId: true, nameInSpreadsheet: true,
            user: {
                select: {
                    referee: { select: { firstName: true, lastName: true } },
                    official: { select: { firstName: true, lastName: true } },
                },
            },
        },
    });

    const assignmentsByRowId = new Map<number, ConsolidatorAssignment[]>();
    for (const r of rawAssignments) {
        const a: ConsolidatorAssignment = {
            id: r.id, userId: r.userId, matchId: r.matchId, nameInSpreadsheet: r.nameInSpreadsheet,
            firstName: r.user?.referee?.firstName ?? r.user?.official?.firstName ?? undefined,
            lastName: r.user?.referee?.lastName ?? r.user?.official?.lastName ?? undefined,
        };
        const arr = assignmentsByRowId.get(r.matchId) ?? [];
        arr.push(a);
        assignmentsByRowId.set(r.matchId, arr);
    }

    const multiRows = rows.filter(r => (byCk.get(r.contentKey)?.length ?? 0) >= 2);
    return planConsolidation(multiRows, assignmentsByRowId);
}

// ============================================================
// DB UYGULAMA
// ============================================================

export interface ConsolidationUndoEntry {
    assignmentId: number;
    userId: number;
    oldMatchId: number;
    newMatchId: number | null;
    action: string;
}

export interface ConsolidationResult {
    groups: number;
    moved: number;
    deletedDupe: number;
    deletedSibling: number;
    deletedRemoval: number;
    rowsCancelledMerge: number;
    rowsCancelledRemoval: number;
    undoLog: ConsolidationUndoEntry[];
    dryRun: boolean;
}

/**
 * Konsolidasyonu uygular.
 *   - withRemovals=false (varsayılan, otomatik akış): sadece MOVE / DELETE_DUPE / DELETE_ON_SIBLING.
 *     BELİRSİZ atamalara DOKUNMAZ.
 *   - withRemovals=true (yalnızca CLI): belirsiz (gerçek çıkarılma) atamaları da siler.
 *   - dryRun: DB'ye hiç yazmaz, ne yapılacağını döndürür. (NOTIFY_DRY_RUN=1 ile de tetiklenir.)
 */
export async function consolidateActiveContentKeyDuplicates(opts: {
    withRemovals?: boolean;
    dryRun?: boolean;
    log?: boolean;
} = {}): Promise<ConsolidationResult> {
    const withRemovals = opts.withRemovals ?? false;
    const dryRun = opts.dryRun ?? ENV_DRY_RUN;
    const doLog = opts.log ?? true;

    const plans = await loadConsolidationPlans();

    const undoLog: ConsolidationUndoEntry[] = [];
    const touchedRowIds = new Set<number>();
    const removalRowIds = new Set<number>();
    let moved = 0, deletedDupe = 0, deletedSibling = 0, deletedRemoval = 0;

    for (const p of plans) {
        for (const mv of p.moves) {
            touchedRowIds.add(mv.fromRowId);

            if (mv.action === "MOVE") {
                if (!dryRun) {
                    // Hedefte aynı userId_matchId var mı? (teorik guard — canonicalUserIds zaten eledi)
                    const dupe = await db.userMatchAssignment.findUnique({
                        where: { userId_matchId: { userId: mv.userId, matchId: p.canonicalRowId } },
                        select: { id: true },
                    });
                    if (dupe && dupe.id !== mv.assignmentId) {
                        await db.userMatchAssignment.delete({ where: { id: mv.assignmentId } });
                        undoLog.push({ assignmentId: mv.assignmentId, userId: mv.userId, oldMatchId: mv.fromRowId, newMatchId: null, action: "DELETED (race dupe)" });
                    } else {
                        await db.userMatchAssignment.update({
                            where: { id: mv.assignmentId },
                            data: { matchId: p.canonicalRowId },
                        });
                        undoLog.push({ assignmentId: mv.assignmentId, userId: mv.userId, oldMatchId: mv.fromRowId, newMatchId: p.canonicalRowId, action: "MOVED" });
                    }
                } else {
                    undoLog.push({ assignmentId: mv.assignmentId, userId: mv.userId, oldMatchId: mv.fromRowId, newMatchId: p.canonicalRowId, action: "MOVED" });
                }
                moved++;
            } else {
                // DELETE_DUPE veya DELETE_ON_SIBLING
                if (!dryRun) {
                    await db.userMatchAssignment.delete({ where: { id: mv.assignmentId } });
                }
                undoLog.push({ assignmentId: mv.assignmentId, userId: mv.userId, oldMatchId: mv.fromRowId, newMatchId: null, action: mv.action });
                if (mv.action === "DELETE_DUPE") deletedDupe++;
                else deletedSibling++;
            }
        }

        // Yalnızca CLI apply-with-removals: belirsiz (gerçek çıkarılma) atamaları sil.
        if (withRemovals) {
            for (const amb of p.ambiguous) {
                if (!dryRun) {
                    await db.userMatchAssignment.delete({ where: { id: amb.assignmentId } });
                }
                undoLog.push({ assignmentId: amb.assignmentId, userId: amb.userId, oldMatchId: amb.fromRowId, newMatchId: null, action: "DELETED (genuine removal)" });
                removalRowIds.add(amb.fromRowId);
                deletedRemoval++;
            }
        }
    }

    // Kanonik-dışı, dokunulan satırlardan üzerinde artık hiç atama kalmayanları iptal işaretle.
    // Bir kanonik-DIŞI satırın TÜM atamaları plan'da yer alır (moves + ambiguous). Satır ancak
    // her ataması taşındı/silindi ise boşalır. `withRemovals=false` iken ambiguous atamalar
    // yerinde kaldığı için o satır boşalmaz → iptal edilmez.
    let rowsCancelledMerge = 0, rowsCancelledRemoval = 0;
    const allTouched = new Set<number>([...touchedRowIds, ...removalRowIds]);
    for (const rowId of allTouched) {
        let remaining: number;
        if (dryRun) {
            // Bu satırdaki, plan tarafından kaldırılMAYAN atama sayısı = yerinde kalan ambiguous'lar
            // (withRemovals=false ise). moves her zaman kaldırılır.
            const ambLeftHere = withRemovals
                ? 0
                : plans.flatMap(p => p.ambiguous).filter(a => a.fromRowId === rowId).length;
            remaining = ambLeftHere;
        } else {
            remaining = await db.userMatchAssignment.count({ where: { matchId: rowId } });
        }
        if (remaining !== 0) continue;

        const onlyRemoval = removalRowIds.has(rowId) && !touchedRowIds.has(rowId);
        if (!dryRun) {
            await db.parsedMatch.update({
                where: { id: rowId },
                data: { cancelledAt: new Date(), cancelReason: onlyRemoval ? CANCEL_REASON_REMOVAL : CANCEL_REASON },
            });
        }
        if (onlyRemoval) rowsCancelledRemoval++;
        else rowsCancelledMerge++;
    }

    const result: ConsolidationResult = {
        groups: plans.length,
        moved, deletedDupe, deletedSibling, deletedRemoval,
        rowsCancelledMerge, rowsCancelledRemoval,
        undoLog, dryRun,
    };

    if (doLog && (plans.length > 0 || undoLog.length > 0)) {
        logger.info(dryRun ? "contentKey konsolidasyonu (DRY_RUN — DB'ye yazılmadı)" : "contentKey konsolidasyonu tamamlandı", {
            grup: result.groups,
            tasinan: result.moved,
            silinenDupe: result.deletedDupe,
            silinenKardes: result.deletedSibling,
            silinenCikarilma: result.deletedRemoval,
            iptalSatirBirlestirme: result.rowsCancelledMerge,
            iptalSatirCikarilma: result.rowsCancelledRemoval,
        });
    } else if (doLog) {
        logger.info(dryRun ? "contentKey konsolidasyonu (DRY_RUN) — mükerrer yok" : "contentKey konsolidasyonu — mükerrer yok");
    }

    return result;
}
