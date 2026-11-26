import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { RSABSSA } from '@cloudflare/blindrsa-ts'

export const suite = RSABSSA.SHA384.PSS.Randomized()

async function exportPair(pair) {
  return {
    publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey),
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
  }
}

export async function loadKeys(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'election-keys.json')
  const readKeys = async () => JSON.parse(await readFile(path, 'utf8'))
  try {
    return await readKeys()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const rsa = { modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1) }
  const [credential, ballot, audit] = await Promise.all([
    suite.generateKey(rsa),
    crypto.subtle.generateKey({ ...rsa, name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt', 'decrypt']),
    crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']),
  ])
  const keys = {
    credential: await exportPair(credential),
    ballot: await exportPair(ballot),
    audit: await exportPair(audit),
  }
  const temporary = join(directory, `keys-${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(keys), { flag: 'wx', mode: 0o600 })
  try {
    await link(temporary, path)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  } finally {
    await unlink(temporary)
  }
  return readKeys()
}

