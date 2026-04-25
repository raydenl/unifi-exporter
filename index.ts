import { cleanEnv, str } from 'envalid'
import dotenv from 'dotenv'
import makeFetchCookie from 'fetch-cookie'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
dotenv.config()

const env = cleanEnv(process.env, {
    USER: str(),
    PASSWORD: str(),
    SUFFIX: str(),
    PIHOLE_URL: str(),
    PIHOLE_PASSWORD: str(),
    IGNORE_OLDER_THAN_DAYS: str({ default: '7' }),
    CUSTOM_GROUP_1: str({ default: '' }),
    CUSTOM_GROUP_2: str({ default: '' }),
    CUSTOM_GROUP_3: str({ default: '' }),
    CUSTOM_GROUP_4: str({ default: '' })
})

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
   Main job
   ──────────────────────────────── */

const job = async () => {
    /* UniFi login */
    await fetchCookie('https://192.168.1.1/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: env.USER, password: env.PASSWORD }),
        headers: { 'Content-Type': 'application/json' }
    })

    const res = await fetchCookie(
        'https://192.168.1.1/proxy/network/api/s/default/rest/user'
    )
    const clients = (await res.json()).data

    console.log(`Retrieved ${clients.length} UniFi clients`)

    /* Desired DNS state */
    const desired = new Set<string>()
    const ignoreOlderThan = Number(env.IGNORE_OLDER_THAN_DAYS)

    for (const client of clients) {
        if (!client.name) continue

        const lastSeen = client.last_seen
            ? new Date(client.last_seen * 1000)
            : undefined

        if (
            lastSeen &&
            lastSeen <
            new Date(Date.now() - ignoreOlderThan * 86400000)
        ) {
            continue
        }

        const hostname = client.name
            .replace(/ /g, '-')
            .replace(/['’()]/g, '')
            .toLowerCase()

        const ip =
            client.fixed_ip && client.use_fixedip
                ? client.fixed_ip
                : client.last_ip

        if (ip) {
            desired.add(`${ip}|${hostname}${env.SUFFIX}`)
        }
    }

    /* Custom IP groups */
    const groups = [
        env.CUSTOM_GROUP_1,
        env.CUSTOM_GROUP_2,
        env.CUSTOM_GROUP_3,
        env.CUSTOM_GROUP_4
    ].filter(Boolean)

    for (const g of groups) {
        const [name, range] = g.split(',')
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

        // Skip deletion if domain does NOT end with the managed suffix
        if (!domain.endsWith(env.SUFFIX)) {
            continue
        }

        // Only delete if it's managed AND not desired
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

    ; (async () => {
        console.log(`Job started at ${new Date().toISOString()}`)
        try {
            await job()
        } catch (err) {
            console.error('Job failed', err)
        }
        console.log(`Job finished at ${new Date().toISOString()}`)
    })()