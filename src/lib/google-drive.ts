import { google } from "googleapis";

let authClient: any = null;
let driveClient: any = null;

async function getDrive() {
    if (driveClient) return driveClient;

    let jsonStr = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!jsonStr) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON ayarlanmamış.");

    try {
        if ((jsonStr.startsWith("'") && jsonStr.endsWith("'")) ||
            (jsonStr.startsWith('"') && jsonStr.endsWith('"'))) {
            jsonStr = jsonStr.substring(1, jsonStr.length - 1);
        }

        let credentials;
        try {
            credentials = JSON.parse(jsonStr);
        } catch (initialError: any) {
            if (initialError.message.includes("control character") || initialError.message.includes("newline") || initialError.message.includes("Unexpected token")) {
                const escaped = jsonStr.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
                credentials = JSON.parse(escaped);
            } else {
                throw initialError;
            }
        }

        authClient = new google.auth.GoogleAuth({
            credentials,
            scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        });

        driveClient = google.drive({ version: "v3", auth: authClient });
        return driveClient;
    } catch (e: any) {
        console.error("[DRIVE] JSON Parse Error:", e.message);
        throw new Error(`Google API Yetkilendirme Hatası: ${e.message}`);
    }
}

export interface DriveSpreadsheet {
    id: string;
    name: string;
    mimeType: string;
    resourceKey?: string;
    md5Checksum?: string;
    modifiedTime?: string;
}

/**
 * Parses "ID?resourcekey=KEY" or a full Drive URL into { id, resourceKey }
 */
export function parseDriveId(str: string): { id: string, resourceKey?: string } {
    if (!str) return { id: "" };

    const globalResourceKey = process.env.GOOGLE_DRIVE_RESOURCE_KEY;

    if (str.includes("drive.google.com")) {
        try {
            const url = new URL(str);
            const segments = url.pathname.split("/");
            let id = "";
            const folderIdx = segments.indexOf("folders");
            if (folderIdx !== -1 && segments[folderIdx + 1]) {
                id = segments[folderIdx + 1];
            } else {
                const dIdx = segments.indexOf("d");
                if (dIdx !== -1 && segments[dIdx + 1]) {
                    id = segments[dIdx + 1];
                }
            }
            const rk = url.searchParams.get("resourcekey");
            return { id, resourceKey: rk || globalResourceKey || undefined };
        } catch (e) { /* fallback */ }
    }

    const [id, query] = str.split("?");
    let resourceKey = globalResourceKey || undefined;

    if (query && query.includes("resourcekey=")) {
        const rk = new URLSearchParams(query).get("resourcekey");
        if (rk) resourceKey = rk;
    }

    return { id, resourceKey };
}

/**
 * Find spreadsheet files in folders.
 * maxDepth=0 means only direct children (no subfolder recursion).
 * maxDepth=1 means one level of subfolders, etc.
 * maxDepth=-1 means unlimited (full recursion).
 *
 * Extended vs BKS original: includes md5Checksum and modifiedTime in file listings
 * for change detection without additional API calls.
 */
export async function findAllSpreadsheets(
    folderIds: string[],
    maxDepth: number = -1
): Promise<{ files: DriveSpreadsheet[], errors: string[] }> {
    const drive = await getDrive();
    const results: DriveSpreadsheet[] = [];
    const errors: string[] = [];
    const visited = new Set<string>();

    async function scanFolder(folderIdOrUrl: string, currentDepth: number) {
        if (!folderIdOrUrl) return;
        const { id: folderId, resourceKey } = parseDriveId(folderIdOrUrl);
        if (!folderId || visited.has(folderId)) return;
        visited.add(folderId);

        try {
            const headers: any = {};
            if (resourceKey) {
                headers["X-Goog-Drive-Resource-Keys"] = `${folderId}/${resourceKey}`;
            }

            const item: any = await drive.files.get({
                fileId: folderId,
                fields: "id, name, mimeType, shortcutDetails, resourceKey",
                supportsAllDrives: true,
            }, { headers } as any);

            const data = item.data;
            let actualMimeType = data.mimeType;
            let actualId = data.id;
            let actualRK = data.resourceKey || resourceKey;

            if (actualMimeType === "application/vnd.google-apps.shortcut" && data.shortcutDetails) {
                actualMimeType = data.shortcutDetails.targetMimeType;
                actualId = data.shortcutDetails.targetId;
                actualRK = data.shortcutDetails.targetResourceKey || actualRK;
            }

            if (
                actualMimeType === "application/vnd.google-apps.spreadsheet" ||
                actualMimeType?.includes("spreadsheet") ||
                actualMimeType?.includes("excel") ||
                data.name?.endsWith(".xlsx") ||
                data.name?.endsWith(".xls")
            ) {
                results.push({
                    id: actualId!,
                    name: data.name!,
                    mimeType: actualMimeType!,
                    resourceKey: actualRK,
                    md5Checksum: data.md5Checksum,
                    modifiedTime: data.modifiedTime,
                });
                return;
            }

            if (actualMimeType !== "application/vnd.google-apps.folder") return;

            let pageToken: string | undefined = undefined;
            do {
                const response: any = await drive.files.list({
                    q: `'${actualId}' in parents and trashed = false`,
                    // md5Checksum and modifiedTime included for change detection
                    fields: "nextPageToken, files(id, name, mimeType, shortcutDetails, resourceKey, md5Checksum, modifiedTime)",
                    pageSize: 1000,
                    pageToken: pageToken,
                    supportsAllDrives: true,
                    includeItemsFromAllDrives: true,
                }, { headers } as any);

                if (response.data.files) {
                    for (const file of response.data.files) {
                        let childMimeType = file.mimeType;
                        let childId = file.id;
                        let childRK = file.resourceKey || actualRK;

                        if (childMimeType === "application/vnd.google-apps.shortcut" && file.shortcutDetails) {
                            childMimeType = file.shortcutDetails.targetMimeType;
                            childId = file.shortcutDetails.targetId;
                            childRK = file.shortcutDetails.targetResourceKey || childRK;
                        }

                        if (childMimeType === "application/vnd.google-apps.folder") {
                            if (maxDepth === -1 || currentDepth < maxDepth) {
                                const nextInput = childRK ? `${childId}?resourcekey=${childRK}` : childId;
                                await scanFolder(nextInput!, currentDepth + 1);
                            }
                        } else if (
                            childMimeType === "application/vnd.google-apps.spreadsheet" ||
                            childMimeType?.includes("spreadsheet") ||
                            childMimeType?.includes("excel") ||
                            file.name?.endsWith(".xlsx") ||
                            file.name?.endsWith(".xls")
                        ) {
                            results.push({
                                id: childId!,
                                name: file.name!,
                                mimeType: childMimeType!,
                                resourceKey: childRK,
                                md5Checksum: file.md5Checksum,
                                modifiedTime: file.modifiedTime,
                            });
                        }
                    }
                }
                pageToken = response.data.nextPageToken || undefined;
            } while (pageToken);

        } catch (e: any) {
            console.error(`[DRIVE] Error scanning ID ${folderId}:`, e?.message);
            const msg = e?.response?.data?.error?.message || e?.message || "Bilinmeyen hata";
            errors.push(`Klasör '${folderId}' okunamadı: ${msg}`);
        }
    }

    await Promise.all(folderIds.map(fid => scanFolder(fid, 0)));

    return { files: results, errors };
}

/**
 * Download a spreadsheet as xlsx Buffer
 */
export async function downloadAsXlsx(fileId: string, mimeType: string, resourceKey?: string): Promise<Buffer> {
    const drive = await getDrive();

    const headers: any = {};
    if (resourceKey) {
        headers["X-Goog-Drive-Resource-Keys"] = `${fileId}/${resourceKey}`;
    }

    if (mimeType === "application/vnd.google-apps.spreadsheet") {
        const response = await drive.files.export(
            { fileId, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
            { responseType: "arraybuffer", headers } as any
        );
        return Buffer.from(response.data as ArrayBuffer);
    }

    const response = await drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true } as any,
        { responseType: "arraybuffer", headers } as any
    );
    return Buffer.from(response.data as ArrayBuffer);
}
