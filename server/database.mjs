import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { additionalDemoVoters, demoVoters, ELECTION } from '../shared/election.mjs'
import { hashPin } from './core.mjs'

export function database(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: 3,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 5000,
    maxLifetimeSeconds: 300,
    keepAlive: true,
  })
  pool.on('error', (error) => console.error('Idle database connection:', error.code ?? error.name))

  async function transaction(callback) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await callback(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async function initialize(keyFingerprint) {
    const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8')
    await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(6210712026)')
      // Apply schema upgrades in the same transaction before accepting ballots.
      await client.query(sql)
      await client.query('INSERT INTO ballot.elections (id, seat, cutoff, key_fingerprint) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [
        ELECTION.id, ELECTION.seat, ELECTION.cutoff, keyFingerprint,
      ])
      const { rows: [existing] } = await client.query(
        'SELECT key_fingerprint FROM ballot.elections WHERE COALESCE(series_id, id) = $1', [ELECTION.id],
      )
      if (existing.key_fingerprint !== keyFingerprint) {
        throw new Error('This election database requires its original key file. Restore that file or use a new demo database.')
      }
      for (const voter of [...demoVoters, ...additionalDemoVoters]) {
        await client.query(`
          INSERT INTO identity.voters (cnic, pin_hash, dob, citizen, cnic_issued, registered, resident, legally_eligible, seat)
          VALUES ($1, $2, $3, true, true, $4, true, true, $5) ON CONFLICT DO NOTHING`,
        [voter.cnic, hashPin(voter.cnic, voter.pin), voter.dob, voter.registered ?? true, voter.seat])
      }
    })
  }

  return { pool, transaction, initialize }
}

