import { cleanEnv, num, str } from 'envalid'
import dotenv from 'dotenv'
import makeFetchCookie from 'fetch-cookie'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
dotenv.config()

const env = cleanEnv(process.env, {
    UNIFI_USER: str(),
    UNIFI_PASSWORD: str(),
    UNIFI_URL: str({ default: 'https://192.168.1.1' }),
    PIHOLE_URL: str(),
    PIHOLE_PASSWORD: str(),
    IGNORE_OLDER_THAN_DAYS: num({ default: 7 }),
    SUFFIX: str(),
})

function isCustomGroupEntry(
    entry: [string, string | undefined]
): entry is [string, string] {
    const [key, value] = entry
    return (
        /^CUSTOM_GROUP_\d+$/.test(key) &&
        typeof value === 'string' &&
        value.trim() !== ''
    )
}

const customGroups = Object.entries(process.env)
    .filter(isCustomGroupEntry)
    .sort(
        (a, b) =>
            Number(a[0].split('_').pop() ?? 0) -
            Number(b[0].split('_').pop() ?? 0)
    )
    .map(([, value]) => value.trim())

const fetchCookie = makeFetchCookie(fetch)

/* ────────────────────────────────
   Pi‑hole API helpers
   ──────────────────────────────── */

let piholeAuth: { sid: string; csrf: string }

async function piholeLogin() {
    const res = await fetch(`${env.PIHOLE_URL}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: env.PIHOLE_PASSWORD })
    })

    if (!res.ok) {
        const body = await res.text()
        throw new Error(`Pi-hole auth failed with ${res.status}: ${body}`)
    }

    const json = await res.json()
    piholeAuth = {
        sid: json.session.sid,
        csrf: json.session.csrf
    }
}

function piholeFetch(path: string, options: any = {}) {
    return fetch(`${env.PIHOLE_URL}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': piholeAuth.csrf,
            'Cookie': `sid=${piholeAuth.sid}`,
            ...(options.headers ?? {})
        }
    })
}

async function getPiholeHosts(): Promise<Set<string>> {
    const res = await piholeFetch('/api/config/dns/hosts')
    const json = await res.json()

    const hosts: string[] = json?.config?.dns?.hosts ?? []

    return new Set(
        hosts.map(line => {
            const [ip, domain] = line.trim().split(/\s+/)
            return `${ip}|${domain}`
        })
    )
}

async function addHost(ip: string, domain: string) {
    const key = `${ip} ${domain}`
    const res = await piholeFetch(
        `/api/config/dns/hosts/${encodeURIComponent(key)}`,
        { method: 'PUT' }
    )

    if (!res.ok && ![400, 409].includes(res.status)) {
        throw new Error(`Failed to add ${key}`)
    }
}

async function deleteHost(ip: string, domain: string) {
    const key = `${ip} ${domain}`
    const res = await piholeFetch(
        `/api/config/dns/hosts/${encodeURIComponent(key)}`,
        { method: 'DELETE' }
    )

    if (!res.ok && res.status !== 400) {
        throw new Error(`Failed to delete ${key}`)
    }
}

/* ────────────────────────────────
   UniFi helpers
   ──────────────────────────────── */

async function unifiGet(path: string) {
    const res = await fetchCookie(`${env.UNIFI_URL}${path}`)
    const json = await res.json()
    return json.data ?? []
}

/* ────────────────────────────────
   IP range helper
   ──────────────────────────────── */

function expandIpRange(range: string): string[] {
    const [start, end] = range.split('-')

    const ipToNum = (ip: string) =>
        ip.split('.').reduce((a, o) => a * 256 + Number(o), 0)

    const numToIp = (num: number) =>
        [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join(
            '.'
        )

    const result = []
    for (let n = ipToNum(start); n <= ipToNum(end); n++) {
        result.push(numToIp(n))
    }
    return result
}

/* ────────────────────────────────
   Hostname normalisation
   ──────────────────────────────── */

function normaliseHostname(name: string): string {
    return name
        .replace(/ /g, '-')
        .replace(/['’()]/g, '')
        .toLowerCase()
}

/* ────────────────────────────────
   Main job
   ──────────────────────────────── */

const job = async () => {
    /* UniFi login */
    await fetchCookie(`${env.UNIFI_URL}/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({
            username: env.UNIFI_USER,
            password: env.UNIFI_PASSWORD
        }),
        headers: { 'Content-Type': 'application/json' }
    })

    /* Fetch UniFi datasets */
    const clients = await unifiGet('/proxy/network/api/s/default/rest/user')
    const staClients = await unifiGet('/proxy/network/api/s/default/stat/sta')

    console.log(
        `Retrieved ${clients.length} UniFi clients + ${staClients.length} STA clients`
    )

    /* Build STA hostname → IP map */
    const staIpMap = new Map<string, string>()

    for (const sta of staClients) {
        if (!sta.name || !sta.ip) continue
        const hostname = normaliseHostname(sta.name)
        staIpMap.set(hostname, sta.ip)
    }

    /* Desired DNS state */
    const desired = new Set<string>()

    for (const client of clients) {
        if (!client.name) continue

        const hostname = normaliseHostname(client.name)

        const unifiIp = client.ip
        const staIp = staIpMap.get(hostname)

        const finalIp = staIp || unifiIp
        if (!finalIp) continue

        desired.add(`${finalIp}|${hostname}${env.SUFFIX}`)
    }

    /* Custom IP groups */
    for (const g of customGroups) {
        const [name, range] = g.split(',').map(part => part.trim())
        if (!name || !range) continue

        for (const ip of expandIpRange(range)) {
            desired.add(`${ip}|${name}${env.SUFFIX}`)
        }
    }

    /* Pi‑hole reconciliation */
    await piholeLogin()
    const existing = await getPiholeHosts()

    for (const entry of existing) {
        const [ip, domain] = entry.split('|')

        if (!domain.endsWith(env.SUFFIX)) continue
        if (!desired.has(entry)) {
            await deleteHost(ip, domain)
        }
    }

    for (const entry of desired) {
        if (!existing.has(entry)) {
            const [ip, domain] = entry.split('|')
            await addHost(ip, domain)
        }
    }

    console.log(
        `Reconciled DNS: ${desired.size} desired / ${existing.size} existing`
    )
}

/* ──────────────────────────────── */

;(async () => {
    console.log(`Job started at ${new Date().toISOString()}`)
    try {
        await job()
    } catch (err) {
        console.error('Job failed', err)
    }
    console.log(`Job finished at ${new Date().toISOString()}`)
})()
