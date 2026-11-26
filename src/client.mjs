import { RSABSSA } from '@cloudflare/blindrsa-ts'
import { auditPayload, credentialMessage, encode, fromHex, hex, leafPayload } from '../shared/election.mjs'

const suite = RSABSSA.SHA384.PSS.Randomized()
const credentialKey = (election) => crypto.subtle.importKey(
  'jwk', election.credentialKey, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify'],
)

export async function api(route, { body, adminKey, signal } = {}) {
  const response = await fetch('/api' + route, {
    signal,
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(adminKey ? { Authorization: `Bearer ${adminKey}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!(response.headers.get('Content-Type') ?? '').includes('application/json')) {
    throw new Error(`The election service could not respond (HTTP ${response.status}). Please retry in a few seconds.`)
  }
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? 'The request could not be completed.')
  return data
}

export async function prepareCredential(election) {
  const serial = hex(crypto.getRandomValues(new Uint8Array(32)))
  const prepared = suite.prepare(credentialMessage(election.id, election.seat, serial))
  const { blindedMsg, inv } = await suite.blind(await credentialKey(election), prepared)
  return { serial, prepared: hex(prepared), blinded: hex(blindedMsg), inverse: hex(inv) }
}

export async function finalizeCredential(election, pending, blindedSignature) {
  const prepared = fromHex(pending.prepared)
  const signature = await suite.finalize(await credentialKey(election), prepared, fromHex(blindedSignature), fromHex(pending.inverse))
  return { serial: pending.serial, prefix: hex(prepared.slice(0, 32)), signature: hex(signature) }
}

export async function encryptedBallot(election, candidate, credential) {
  const publicKey = await crypto.subtle.importKey(
    'jwk', election.ballotKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'],
  )
  const plaintext = encode(JSON.stringify(['votesecure-ballot-v1', election.id, election.seat, candidate]))
  const ciphertext = hex(new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, plaintext)))
  return { ...credential, seat: election.seat, ciphertext }
}

export async function expectedReceipt(election, ciphertext) {
  const bytes = await crypto.subtle.digest('SHA-256', leafPayload(election.id, election.seat, ciphertext))
  return hex(new Uint8Array(bytes))
}

export async function verifyAudit(election, audit) {
  if (audit.snapshot.electionId !== election.id || audit.snapshot.seat !== election.seat) return false
  const key = await crypto.subtle.importKey('jwk', election.auditKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromHex(audit.signature), auditPayload(audit.snapshot))
}

