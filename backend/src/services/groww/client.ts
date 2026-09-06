import { getAccessToken, invalidateAccessToken, GROWW_BASE_URL } from './auth';

/** Authed GET against the Groww Trade API, with one retry after invalidating
 * the cached token on a 401 (covers server-side revocation our own expiry
 * math didn't know about). */
export async function growwGet(path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(`${GROWW_BASE_URL}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const doFetch = async () => {
        const token = await getAccessToken();
        return fetch(url.toString(), {
            headers: {
                Authorization: `Bearer ${token}`,
                'X-API-VERSION': '1.0',
                Accept: 'application/json',
            },
        });
    };

    let res = await doFetch();
    if (res.status === 401) {
        await invalidateAccessToken();
        res = await doFetch();
    }

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Groww API ${path} -> ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    if (data.status && data.status !== 'SUCCESS') {
        throw new Error(`Groww API ${path} returned status=${data.status}: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return data.payload;
}
