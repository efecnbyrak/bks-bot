import { db } from "../src/db";
import crypto from "crypto";
function oldKey(macAdi: string, tarih: string, saat: string | null, salon: string | null): string {
    const norm = (s: string) => (s ?? "").trim().toLowerCase();
    const raw = `${norm(macAdi)}|${norm(tarih)}|${norm(saat ?? "")}|${norm(salon ?? "")}`;
    return crypto.createHash("sha256").update(raw).digest("hex").substring(0, 32);
}
function newKey(macAdi: string, tarih: string, saat: string | null): string {
    const norm = (s: string) => (s ?? "").trim().toLowerCase();
    const raw = `${norm(macAdi)}|${norm(tarih)}|${norm(saat ?? "")}`;
    return crypto.createHash("sha256").update(raw).digest("hex").substring(0, 32);
}
async function main() {
  const rows = await db.parsedMatch.findMany({
    where: { cancelledAt: null },
    select: { id: true, contentKey: true, macAdi: true, tarih: true, saat: true, salon: true },
  });
  let nullCount = 0;
  const unexpected: typeof rows = [];
  for (const r of rows) {
    const nk = newKey(r.macAdi, r.tarih, r.saat);
    if (r.contentKey === nk) continue;
    if (r.contentKey === null) { nullCount++; continue; }
    const ok = oldKey(r.macAdi, r.tarih, r.saat, r.salon);
    if (r.contentKey !== ok) unexpected.push(r);
  }
  console.log("contentKey NULL olan (güncellenecek 355 içinde):", nullCount);
  console.log("Beklenmeyen satırlar:", unexpected.length);
  for (const r of unexpected) {
    console.log(JSON.stringify(r));
  }
  await db.$disconnect();
}
main();
