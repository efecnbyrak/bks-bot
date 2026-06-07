import { PrismaClient } from "@prisma/client";

const globalForPrisma = global as typeof global & { prisma?: PrismaClient };

export const db =
    globalForPrisma.prisma ??
    new PrismaClient({
        datasources: {
            db: { url: process.env.DATABASE_URL },
        },
        log: process.env.LOG_LEVEL === "debug" ? ["query", "error"] : ["error"],
    });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
