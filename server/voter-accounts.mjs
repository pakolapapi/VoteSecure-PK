import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const route = '/voter-account'
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const challengeAge = 10 * 60 * 1000
const sessionAge = 8 * 60 * 60 * 1000
const rememberedAge = 30 * 24 * 60 * 60 * 1000
const derivePassword = promisify(scrypt)
const scryptOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }
const validPassword = (password) => typeof password === 'string' && [...password].length >= 12 && [...password].length <= 128

async function encodePassword(password, salt) {
  const digest = await derivePassword(password, salt, 64, scryptOptions)
  return salt + ':' + digest.toString('hex')
}
const randomToken = () => randomBytes(32).toString('base64url')
const hashToken = (token) => createHash('sha256').update(token).digest('hex')

export function normalizePakistanMobile(input) {
  if (typeof input !== 'string' || input.length > 30) return null
  const compact = input.replace(/[\s()-]/g, '')
  const local = compact.replace(/^(?:\+92|0092|92|0)/, '')
  return /^3\d{9}$/.test(local) ? '+92' + local : null
}

function normalizeAccountCnic(value) {
  if (typeof value !== 'string' || value.length > 24) return null
  const cnic = value.replace(/[-\s]/g, '')
  return /^[1-9]\d{12}$/.test(cnic) ? cnic : null
}

function readToken(req, name) {
  const token = req.get('cookie')?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(name + '='))?.slice(name.length + 1)
  return tokenPattern.test(token ?? '') ? hashToken(token) : null
}

export function registerVoterAccounts(api, db, env = process.env, sendFetch = fetch) {
  const { ACCOUNT_ORIGIN, ACCOUNT_DATA_KEY, RESEND_API_KEY, ACCOUNT_EMAIL_FROM } = env
  const brevoApiKey = env.BREVO_API_KEY?.trim()
  const brevoSender = normalizeEmail(env.BREVO_SENDER_EMAIL?.trim())
  const useBrevo = Boolean(brevoApiKey && brevoSender)
  const key = Buffer.from(ACCOUNT_DATA_KEY ?? '', 'base64url')
  const origin = URL.canParse(ACCOUNT_ORIGIN ?? '') ? new URL(ACCOUNT_ORIGIN) : null
  const secure = origin?.protocol === 'https:'
  const local = origin?.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname) && env.VERCEL !== '1'
  const enabled = Boolean(origin && origin.origin === ACCOUNT_ORIGIN && (secure || local) && key.length === 32 && (useBrevo || (RESEND_API_KEY && ACCOUNT_EMAIL_FROM)))
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: Boolean(secure), path: '/' }
  const challengeCookie = secure ? '__Host-votesecure_email_check' : 'votesecure_email_check'
  const sessionCookie = secure ? '__Host-votesecure_email_session' : 'votesecure_email_session'
  const indexKey = createHmac('sha256', key).update('account-index-v1').digest()
  const encryptionKey = createHmac('sha256', key).update('account-name-v1').digest()

  function lookup(kind, value) {
    return createHmac('sha256', indexKey).update(kind + ':' + value).digest('hex')
  }

  function ballotWorkspace(cnicHash) {
    return lookup('ballot-workspace', cnicHash)
  }

  async function checkVotingAccount(req, connection) {
    const token = readToken(req, sessionCookie)
    if (!enabled || !token) return { status: 401, error: 'Sign in to your VoteSecure account to vote.' }
    const { rows: [session] } = await connection.query(`
      SELECT cnic_hash FROM mobile_accounts.sessions
      WHERE token_hash = $1 AND expires_at > now() FOR SHARE`, [token])
    if (!session) return { status: 401, error: 'Your session has expired. Sign in again to vote.' }
    return { cnicHash: session.cnic_hash, workspace: ballotWorkspace(session.cnic_hash) }
  }

  async function checkRegisteredCnic(req, value, connection) {
    const session = await checkVotingAccount(req, connection)
    if (session.error) return session
    const cnic = normalizeAccountCnic(value)
    if (!cnic) return { status: 400, error: 'Enter the 13-digit CNIC you used to register your account.' }
    const cnicHash = lookup('cnic', cnic)
    if (!timingSafeEqual(Buffer.from(session.cnicHash, 'hex'), Buffer.from(cnicHash, 'hex'))) {
      return { status: 403, error: 'That CNIC does not match your signed-in account.' }
    }
    return { cnicHash }
  }

  function encryptName(name, cnicHash) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
    cipher.setAAD(Buffer.from(cnicHash))
    const encrypted = Buffer.concat([cipher.update(name, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  }

  function decryptName(value, cnicHash) {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12))
    decipher.setAAD(Buffer.from(cnicHash))
    decipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
  }


  api.get(route, async (req, res) => {
    const token = readToken(req, sessionCookie)
    if (!enabled || !token) return res.json({ enabled, account: null })
    const { rows: [account] } = await db.pool.query(`
      SELECT a.cnic_hash, a.encrypted_name FROM mobile_accounts.sessions AS s
      JOIN mobile_accounts.users AS a USING (cnic_hash)
      WHERE s.token_hash = $1 AND s.expires_at > now()`, [token])
    res.json({ enabled, account: account ? { name: decryptName(account.encrypted_name, account.cnic_hash), ballotWorkspace: ballotWorkspace(account.cnic_hash) } : null })
  })

  async function allowRequests(client, limits) {
    for (const [bucket, seconds, limit] of limits) {
      const result = await client.query(`
        INSERT INTO mobile_accounts.email_limits (bucket, expires_at, sends)
        VALUES ($1, to_timestamp((floor(extract(epoch FROM now()) / $2) + 1) * $2), 1)
        ON CONFLICT (bucket, expires_at) DO UPDATE SET sends = email_limits.sends + 1
        WHERE email_limits.sends < $3`, [bucket, seconds, limit])
      if (!result.rowCount) return false
    }
    return true
  }

  async function createSession(client, priorSession, cnicHash, encryptedName, remember) {
    const token = randomToken()
    if (priorSession) await client.query('DELETE FROM mobile_accounts.sessions WHERE token_hash = $1', [priorSession])
    await client.query('INSERT INTO mobile_accounts.sessions (token_hash, cnic_hash, expires_at) VALUES ($1, $2, $3)',
      [hashToken(token), cnicHash, new Date(Date.now() + (remember ? rememberedAge : sessionAge))])
    return { token, name: decryptName(encryptedName, cnicHash) }
  }

  function signIn(res, session, remember) {
    res.cookie(sessionCookie, session.token, remember ? { ...cookieOptions, maxAge: rememberedAge } : cookieOptions)
    return res.json({ enabled, account: { name: session.name } })
  }

  function normalizeEmail(value) {
    const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
    return email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null
  }

  async function passwordLogin(req, res) {
    const email = normalizeEmail(req.body.email)
    const { password } = req.body
    if (!email || !validPassword(password)) return res.status(400).json({ error: 'Enter your email and password.' })
    const emailHash = lookup('email', email)
    const allowed = await db.transaction(async (client) => {
      await client.query('DELETE FROM mobile_accounts.email_limits WHERE expires_at <= now()')
      return allowRequests(client, [['password-global', 60, 120], ['password:' + emailHash, 900, 8]])
    })
    if (!allowed) return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' })
    const { rows: [identity] } = await db.pool.query('SELECT password_hash FROM mobile_accounts.email_identities WHERE email_hash = $1', [emailHash])
    const stored = identity?.password_hash
    const salt = stored?.split(':')[0] ?? lookup('password-padding', emailHash).slice(0, 32)
    const candidate = await encodePassword(password, salt)
    if (!stored || !timingSafeEqual(Buffer.from(stored), Buffer.from(candidate))) {
      return res.status(401).json({ error: 'Email or password did not match. Use Set or reset password if you signed up with an email code.' })
    }
    const remember = req.body.remember === true
    const session = await db.transaction(async (client) => {
      const { rows: [user] } = await client.query(`
        SELECT a.cnic_hash, a.encrypted_name FROM mobile_accounts.users a
        JOIN mobile_accounts.email_identities e USING (cnic_hash)
        WHERE e.email_hash = $1 AND e.password_hash = $2 FOR SHARE OF e`, [emailHash, stored])
      return user && createSession(client, readToken(req, sessionCookie), user.cnic_hash, user.encrypted_name, remember)
    })
    if (!session) return res.status(401).json({ error: 'The password changed. Sign in again.' })
    return signIn(res, session, remember)
  }

  async function sendCode(email, code, signup) {
    const subject = signup ? 'Verify your VoteSecure PK email' : 'Set or reset your VoteSecure PK password'
    const text = `Your VoteSecure PK code is ${code}. It expires in 10 minutes. If you did not request this email, you can ignore it.`
    const url = useBrevo ? 'https://api.brevo.com/v3/smtp/email' : 'https://api.resend.com/emails'
    const auth = useBrevo ? { 'api-key': brevoApiKey } : { Authorization: 'Bearer ' + RESEND_API_KEY }
    const message = useBrevo
      ? { sender: { email: brevoSender, name: 'VoteSecure PK' }, to: [{ email }], subject,
          textContent: text, htmlContent: `<p>${text}</p>` }
      : { from: ACCOUNT_EMAIL_FROM, to: [email], subject, text }
    try {
      const response = await sendFetch(url, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      })
      return response.ok
    } catch {
      return false
    }
  }

  async function start(req, res) {
    const { action, email: rawEmail, cnic: rawCnic, name: rawName, mobile: rawMobile } = req.body
    const signup = action === 'signup'
    const email = normalizeEmail(rawEmail)
    const cnic = normalizeAccountCnic(rawCnic)
    const mobile = normalizePakistanMobile(rawMobile)
    const name = typeof rawName === 'string' ? rawName.trim().normalize('NFC') : ''
    if (!email) {
      return res.status(400).json({ error: 'Enter a valid email address.' })
    }
    if (signup && (!cnic || !mobile ||
      !/\p{L}/u.test(name) || name.length > 100 || /\p{Cc}/u.test(name))) {
      return res.status(400).json({ error: 'Enter your name, a 13-digit CNIC and a Pakistani mobile number.' })
    }
    const emailHash = lookup('email', email)
    const cnicHash = signup ? lookup('cnic', cnic) : null
    const mobileHash = signup ? lookup('mobile', mobile) : null
    const token = randomToken()
    const tokenHash = hashToken(token)
    const code = String(randomInt(100_000_000)).padStart(8, '0')
    const allowed = await db.transaction(async (client) => {
      await client.query('DELETE FROM mobile_accounts.email_challenges WHERE expires_at <= now()')
      await client.query('DELETE FROM mobile_accounts.email_limits WHERE expires_at <= now()')
      await client.query('DELETE FROM mobile_accounts.sessions WHERE expires_at <= now()')
      if (!await allowRequests(client, [['daily', 86400, 90], [emailHash, 900, 4]])) return false
      const previous = readToken(req, challengeCookie)
      if (previous) await client.query('DELETE FROM mobile_accounts.email_challenges WHERE token_hash = $1', [previous])
      return true
    })
    if (!allowed) return res.status(429).json({ error: 'Too many code requests. Try again later.' })
    const { rows: [identity] } = await db.pool.query('SELECT cnic_hash FROM mobile_accounts.email_identities WHERE email_hash = $1', [emailHash])
    if (signup || identity) {
      await db.pool.query(`
        INSERT INTO mobile_accounts.email_challenges
          (token_hash, email_hash, cnic_hash, mobile_hash, encrypted_name, code_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tokenHash, emailHash, signup ? cnicHash : identity.cnic_hash, mobileHash,
        signup ? encryptName(name, cnicHash) : null, lookup('email-code', tokenHash + ':' + code),
        new Date(Date.now() + challengeAge)])
      if (!await sendCode(email, code, signup)) {
        await db.pool.query('DELETE FROM mobile_accounts.email_challenges WHERE token_hash = $1', [tokenHash])
        return res.status(503).json({ error: 'The verification email could not be sent. Try again later.' })
      }
    }
    res.cookie(challengeCookie, token, { ...cookieOptions, maxAge: challengeAge })
    res.status(202).json({ pending: true })
  }

  async function confirm(req, res) {
    const token = readToken(req, challengeCookie)
    const { code, password } = req.body
    if (!token || typeof code !== 'string' || !/^\d{8}$/.test(code)) {
      return res.status(400).json({ error: 'Enter the eight-digit code from your email.' })
    }
    if (!validPassword(password)) return res.status(400).json({ error: 'Choose a password with 12 to 128 characters.' })
    const remember = req.body.remember === true
    const result = await db.transaction(async (client) => {
      const { rows: [pending] } = await client.query(`
        UPDATE mobile_accounts.email_challenges SET attempts = attempts + 1
        WHERE token_hash = $1 AND expires_at > now() AND attempts < 5 RETURNING *`, [token])
      if (!pending || !timingSafeEqual(Buffer.from(pending.code_hash), Buffer.from(lookup('email-code', token + ':' + code)))) return null
      await client.query('DELETE FROM mobile_accounts.email_challenges WHERE token_hash = $1', [token])
      const { cnic_hash: cnicHash, mobile_hash: mobileHash, encrypted_name: encryptedName, email_hash: emailHash } = pending
      if (encryptedName) {
        const { rowCount } = await client.query('SELECT 1 FROM mobile_accounts.email_identities WHERE email_hash = $1', [emailHash])
        if (rowCount) return { conflict: true }
      }
      const passwordHash = await encodePassword(password, randomBytes(16).toString('hex'))
      if (encryptedName) {
        // A uniqueness conflict rolls back both inserts, preserving any existing account.
        await client.query('INSERT INTO mobile_accounts.users (cnic_hash, mobile_hash, encrypted_name) VALUES ($1, $2, $3)',
          [cnicHash, mobileHash, encryptedName])
        await client.query('INSERT INTO mobile_accounts.email_identities (email_hash, cnic_hash, password_hash) VALUES ($1, $2, $3)',
          [emailHash, cnicHash, passwordHash])
      } else {
        const updated = await client.query('UPDATE mobile_accounts.email_identities SET password_hash = $1 WHERE email_hash = $2 AND cnic_hash = $3',
          [passwordHash, emailHash, cnicHash])
        if (!updated.rowCount) return null
        await client.query('DELETE FROM mobile_accounts.sessions WHERE cnic_hash = $1', [cnicHash])
      }
      const { rows: [user] } = await client.query(`
        SELECT a.encrypted_name FROM mobile_accounts.users a JOIN mobile_accounts.email_identities e USING (cnic_hash)
        WHERE a.cnic_hash = $1 AND e.email_hash = $2`, [cnicHash, emailHash])
      if (!user) return null
      return createSession(client, readToken(req, sessionCookie), cnicHash, user.encrypted_name, remember)
    }).catch((error) => {
      if (error.code === '23505') return { conflict: true }
      throw error
    })
    if (!result) return res.status(401).json({ error: 'The code was invalid or expired. Request a new code if needed.' })
    res.clearCookie(challengeCookie, cookieOptions)
    if (result.conflict) return res.status(409).json({ error: 'An account already exists with this email, CNIC, or mobile number. Sign in or use Set or reset password.' })
    return signIn(res, result, remember)
  }

  api.post(route, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Email verification is awaiting configuration.' })
    if (req.get('origin') !== origin.origin) return res.status(403).json({ error: 'Open VoteSecure PK to continue.' })
    const action = req.body?.action
    if (action === 'signup' || action === 'reset') return start(req, res)
    if (action === 'login') return passwordLogin(req, res)
    if (action === 'confirm') return confirm(req, res)
    if (action !== 'logout') return res.status(400).json({ error: 'Unknown account action.' })
    const token = readToken(req, sessionCookie)
    if (token) await db.pool.query('DELETE FROM mobile_accounts.sessions WHERE token_hash = $1', [token])
    res.clearCookie(sessionCookie, cookieOptions)
    res.json({ enabled, account: null })
  })

  return { checkRegisteredCnic, checkVotingAccount }
}
