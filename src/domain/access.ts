// Who is asking, for browser requests. Cloudflare Access sits in front of Limeade and signs every request
// with a JWT (Cf-Access-Jwt-Assertion header, CF_Authorization cookie). We check its signature against the
// team's public keys, the issuer, the app's AUD tag and expiry, then the email.

import { createPublicKey, verify, type KeyObject } from 'node:crypto'

const CERTS_TTL_MS = 60 * 60 * 1000
const REFETCH_GAP_MS = 30 * 1000

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))

export function teamOrigin(team: string): string {
  const t = String(team ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!t) return ''
  return `https://${t.includes('.') ? t : `${t}.cloudflareaccess.com`}`
}

export interface AccessCheck {
  /** The allowed email in a request's Access token, or null. */
  emailFor(headers: Record<string, string | string[] | undefined>): Promise<string | null>
}

export function createAccessCheck(o: {
  team: string
  aud: string
  emails: readonly string[]
  fetchCerts: (url: string) => Promise<{ keys?: any[] }>
  now?: () => number
}): AccessCheck {
  const issuer = teamOrigin(o.team)
  const allowed = new Set(o.emails.map((e) => e.toLowerCase()))
  const now = o.now ?? Date.now
  let keys = new Map<string, KeyObject>()
  let fetchedAt = 0

  async function keyFor(kid: string) {
    const stale = now() - fetchedAt > CERTS_TTL_MS
    if ((stale || !keys.has(kid)) && now() - fetchedAt > REFETCH_GAP_MS) {
      const { keys: jwks = [] } = await o.fetchCerts(`${issuer}/cdn-cgi/access/certs`)
      keys = new Map(jwks.filter((k) => k.kid && k.kty === 'RSA').map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]))
      fetchedAt = now()
    }
    return keys.get(kid)
  }

  async function emailFrom(token: string | undefined): Promise<string | null> {
    if (!issuer || !o.aud || !token) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    let header: any
    let payload: any
    try {
      header = b64json(parts[0]!)
      payload = b64json(parts[1]!)
    } catch {
      return null
    }
    if (header.alg !== 'RS256') return null
    const key = await keyFor(header.kid).catch(() => undefined)
    if (!key) return null
    const ok = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, 'base64url'))
    if (!ok) return null
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    const t = now() / 1000
    if (payload.iss !== issuer || !auds.includes(o.aud) || !(payload.exp > t) || (payload.nbf && payload.nbf > t + 60)) return null
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null
    return email && allowed.has(email) ? email : null
  }

  return {
    async emailFor(headers) {
      const cookie = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(String(headers.cookie ?? ''))?.[1]
      const header = headers['cf-access-jwt-assertion']
      return emailFrom((Array.isArray(header) ? header[0] : header) || cookie)
    },
  }
}
