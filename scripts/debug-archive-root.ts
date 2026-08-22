import { google } from "googleapis";
import { ARCHIVE_ROOT_ID } from "../src/config";

async function main() {
    let jsonStr = process.env.GOOGLE_SERVICE_ACCOUNT_JSON!;
    if ((jsonStr.startsWith("'") && jsonStr.endsWith("'")) || (jsonStr.startsWith('"') && jsonStr.endsWith('"'))) {
        jsonStr = jsonStr.substring(1, jsonStr.length - 1);
    }
    let credentials;
    try {
        credentials = JSON.parse(jsonStr);
    } catch {
        credentials = JSON.parse(jsonStr.replace(/\n/g, "\\n").replace(/\r/g, "\\r"));
    }

    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const drive = google.drive({ version: "v3", auth });

    console.log("=== Service account ===", credentials.client_email);
    console.log("=== ARCHIVE_ROOT_ID ===", ARCHIVE_ROOT_ID);

    console.log("\n=== files.get on ARCHIVE_ROOT_ID (no resourceKey) ===");
    try {
        const res = await drive.files.get({
            fileId: ARCHIVE_ROOT_ID,
            fields: "id, name, mimeType, driveId, resourceKey, capabilities",
            supportsAllDrives: true,
        } as any);
        console.log("OK:", JSON.stringify(res.data, null, 2));
    } catch (e: any) {
        console.log("ERROR:", e?.response?.status, e?.response?.data?.error?.message || e?.message);
    }

    console.log("\n=== files.list children of ARCHIVE_ROOT_ID (no corpora) ===");
    try {
        const res = await drive.files.list({
            q: `'${ARCHIVE_ROOT_ID}' in parents and trashed = false`,
            fields: "files(id, name, mimeType)",
            pageSize: 1000,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        } as any);
        console.log("OK, count:", res.data.files?.length ?? 0);
        console.log(JSON.stringify(res.data.files, null, 2));
    } catch (e: any) {
        console.log("ERROR:", e?.response?.status, e?.response?.data?.error?.message || e?.message);
    }

    console.log("\n=== files.list with corpora=allDrives ===");
    try {
        const res = await drive.files.list({
            q: `'${ARCHIVE_ROOT_ID}' in parents and trashed = false`,
            fields: "files(id, name, mimeType)",
            pageSize: 1000,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            corpora: "allDrives",
        } as any);
        console.log("OK, count:", res.data.files?.length ?? 0);
        console.log(JSON.stringify(res.data.files, null, 2));
    } catch (e: any) {
        console.log("ERROR:", e?.response?.status, e?.response?.data?.error?.message || e?.message);
    }

    // Örnek 2026-2027 klasörünü de doğrudan sorgula
    const sampleId = "132cQn2YbFyNKZXCX9rP1f-jjdvsaWPqo";
    console.log(`\n=== files.get on sample 2026-2027 folder (${sampleId}) ===`);
    try {
        const res = await drive.files.get({
            fileId: sampleId,
            fields: "id, name, mimeType, parents, driveId, resourceKey",
            supportsAllDrives: true,
        } as any);
        console.log("OK:", JSON.stringify(res.data, null, 2));
    } catch (e: any) {
        console.log("ERROR:", e?.response?.status, e?.response?.data?.error?.message || e?.message);
    }
}

main().catch(e => {
    console.error("FATAL:", e);
    process.exit(1);
});
