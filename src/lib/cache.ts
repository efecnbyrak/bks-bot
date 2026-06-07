export interface CacheItem<T> {
    data: T;
    timestamp: number;
}

const globalCache = global as typeof global & {
    __matchCache?: Map<string, CacheItem<any>>;
};

if (!globalCache.__matchCache) {
    globalCache.__matchCache = new Map<string, CacheItem<any>>();
}

export const matchCache = globalCache.__matchCache;

const MAX_CACHE_ENTRIES = 100;

export async function getCachedData<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttl: number = 60 * 60 * 1000
): Promise<T> {
    const cached = matchCache.get(key);
    const now = Date.now();

    if (cached && (now - cached.timestamp < ttl)) {
        return cached.data;
    }

    const data = await fetcher();

    if (matchCache.size >= MAX_CACHE_ENTRIES) {
        let oldestKey = '';
        let oldestTime = Infinity;
        for (const [k, v] of matchCache) {
            if (v.timestamp < oldestTime) {
                oldestTime = v.timestamp;
                oldestKey = k;
            }
        }
        if (oldestKey) matchCache.delete(oldestKey);
    }

    matchCache.set(key, { data, timestamp: now });

    return data;
}
