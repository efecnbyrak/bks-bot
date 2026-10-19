import { db } from "../src/db";
async function main() {
  const ids = [276134, 276135, 230439];
  const assigns = await db.userMatchAssignment.findMany({
    where: { matchId: { in: ids } },
    select: { id: true, userId: true, matchId: true },
  });
  console.log("TEST maçlarına bağlı atama sayısı:", assigns.length, JSON.stringify(assigns));
  await db.$disconnect();
}
main();
