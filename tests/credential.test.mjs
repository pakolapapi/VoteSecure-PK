import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RSABSSA } from '@cloudflare/blindrsa-ts'
import { prepareCredential, finalizeCredential } from '../src/client.mjs'
import { preparedCredentialMessage, ELECTION, fromHex, hex } from '../shared/election.mjs'

test('browser-issued credential verifies with the ballot endpoint byte representation', async () => {
  const suite = RSABSSA.SHA384.PSS.Randomized()
  const keys = await suite.generateKey({ modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1) })
  const election = { ...ELECTION, credentialKey: await crypto.subtle.exportKey('jwk', keys.publicKey) }
  const pending = await prepareCredential(election)
  const blindSignature = await suite.blindSign(keys.privateKey, fromHex(pending.blinded))
  const credential = await finalizeCredential(election, pending, hex(blindSignature))
  const { prefix, serial, signature } = credential
  const id = election.id
  const seat = election.seat
  const message = preparedCredentialMessage(id, seat, serial, prefix)
  assert.equal(await suite.verify(keys.publicKey, fromHex(signature), message), true)
  message[message.length - 1] ^= 1
  assert.equal(await suite.verify(keys.publicKey, fromHex(signature), message), false)
})
