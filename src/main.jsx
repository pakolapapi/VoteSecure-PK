import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { isHex, isReceiptCode } from '../shared/election.mjs'
import { MerkleTree } from '../shared/merkle.mjs'
import { api, encryptedBallot, expectedReceipt, finalizeCredential, prepareCredential, verifyAudit } from './client.mjs'
import { readReceiptFile } from './receipt.mjs'
import './styles.css'

const tabs = [['home', 'Home'], ['vote', 'Cast ballot'], ['audit', 'Results & audit'], ['admin', 'Election admin'], ['account', 'Account']]
const navIcons = {
  home: 'M3 10.5 12 3l9 7.5V21h-6v-7H9v7H3Z',
  vote: 'm7 7 6-5 6 7-6 5ZM6 12H4l-2 6v3h20v-3l-2-6h-2M6 17h12',
  audit: 'M3 20h18M6 16v-5m6 5V4m6 12V8',
  admin: 'M12 2 4 5v6c0 5 4 8 8 11 4-3 8-6 8-11V5ZM9 11l2 2 4-4',
  account: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
}
const constituencyLabel = (seat) => seat.replace('-DEMO-', '-')
const ballotStorageKey = (election, workspace, name) => `votesecure:${election.id}:${workspace}:${name}`
const readBallotState = (key) => JSON.parse(sessionStorage.getItem(key) ?? 'null')

function useAction() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function run(action) {
    setBusy(true)
    setMessage('')
    try {
      await action()
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy(false)
    }
  }
  return { busy, message, run, clearMessage: () => setMessage('') }
}

const symbolPaths = {
  'Cedar tree': 'M12 2.5 6.5 9h3L5 14h4l-5 5h16l-5-5h4l-4.5-5h3L12 2.5ZM12 19v3',
  Sailboat: 'M12 3 5 14h7V3Zm2 5 5 6h-5m-11 3h18l-3 4H6l-3-4Z',
  Anchor: 'M12 7v14M8 11h8m-12 4v2c0 2.8 3.6 4 8 4s8-1.2 8-4v-2m-18 2 2-2 2 2m12 0 2-2 2 2M14 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
}

function CandidateSymbol({ candidate }) {
  const path = symbolPaths[candidate.symbol]
  return (
    <span className="candidate-mark" data-symbol={candidate.symbol} aria-hidden="true">
      {path ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
          <path d={path} />
        </svg>
      ) : candidate.mark}
    </span>
  )
}

function ResultsTable({ candidates, results }) {
  return (
    <table className="results-table">
      <thead><tr><th scope="col">Candidate</th><th scope="col">Votes</th></tr></thead>
      <tbody>
        {results.map(({ id, votes }) => {
          const candidate = candidates.find((item) => item.id === id)
          return (
            <tr key={id}>
              <th scope="row">
                {candidate ? (
                  <span className="result-candidate">
                    <CandidateSymbol candidate={candidate} />
                    <span>{candidate.name}<small>{candidate.symbol}</small></span>
                  </span>
                ) : id}
              </th>
              <td>{votes.toLocaleString('en-PK')}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function ErrorNotice({ message }) {
  return message && <p className="notice error" role="alert">{message}</p>
}

function Receipt({ election, value, onAudit }) {
  return (
    <div className="receipt" aria-live="polite">
      <div className="receipt-heading">
        <span className="receipt-icon" aria-hidden="true">✓</span>
        <div><h2>Ballot recorded</h2><p>Constituency {constituencyLabel(election.seat)}</p></div>
      </div>
      <div className="receipt-body">
        <p>Save your receipt to verify ballot inclusion after polls close.</p>
        <p className="receipt-label" id="ballot-receipt-label">Receipt code</p>
        <code className={isReceiptCode(value) ? 'digest receipt-code' : 'digest'} aria-labelledby="ballot-receipt-label">{value}</code>
        <form className="actions" method="post" action="/api/ballot-receipt" rel="noopener">
          <input type="hidden" name="electionId" value={election.id} />
          <input type="hidden" name="receipt" value={value} />
          <button type="submit">Download PDF receipt</button>
          <button type="submit" className="secondary" name="view" value="inline" formTarget="_blank">Open PDF</button>
          <button type="button" className="secondary" onClick={onAudit}>Go to audit</button>
        </form>
      </div>
    </div>
  )
}

function Voting({ election, onAudit, onAccount }) {
  const [session, setSession] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    api('/voter-account', { signal: controller.signal }).then(setSession).catch((failure) => {
      if (!controller.signal.aborted) setError(failure.message)
    })
    return () => controller.abort()
  }, [])

  if (error) return <section className="panel"><ErrorNotice message={error} /></section>
  if (!session) return <section className="panel"><p role="status">Checking your account…</p></section>
  if (!session.account) return (
    <section className="panel">
      <h2>Sign in to cast your ballot</h2>
      <p className="intro">Sign in or create a verified VoteSecure account to vote in this academic election.</p>
      <button type="button" onClick={onAccount}>Open account</button>
    </section>
  )

  const workspace = session.account.ballotWorkspace
  return <Ballot key={workspace} election={election} workspace={workspace} onAudit={onAudit} />
}

function Ballot({ election, workspace, onAudit }) {
  const issuanceKey = ballotStorageKey(election, workspace, 'issuance')
  const pendingKey = ballotStorageKey(election, workspace, 'pending-ballot')
  const receiptKey = ballotStorageKey(election, workspace, 'receipt')
  const [pendingBallot, setPendingBallot] = useState(() => readBallotState(pendingKey))
  const [receipt, setReceipt] = useState(() => readBallotState(receiptKey))
  const [choice, setChoice] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const action = useAction()
  const step = receipt ? 3 : reviewing || pendingBallot ? 2 : 1

  function cast(event) {
    event.preventDefault()
    if (!pendingBallot && !reviewing) {
      setReviewing(true)
      return
    }

    action.run(async () => {
      let ballot = pendingBallot
      if (!ballot) {
        const issuance = readBallotState(issuanceKey) ?? await prepareCredential(election)
        sessionStorage.setItem(issuanceKey, JSON.stringify(issuance))
        const { signature } = await api('/identity/credentials', { body: { electionId: election.id, workspace, blinded: issuance.blinded } })
        const credential = await finalizeCredential(election, issuance, signature)
        ballot = await encryptedBallot(election, choice, credential)
        sessionStorage.setItem(pendingKey, JSON.stringify(ballot))
        setPendingBallot(ballot)
      }
      const data = await api('/ballots', { body: ballot })
      if (data.receipt !== await expectedReceipt(election, ballot.ciphertext)) throw new Error('The server receipt did not match your encrypted ballot.')
      const displayReceipt = isReceiptCode(data.receiptCode) ? data.receiptCode : data.receipt
      sessionStorage.setItem(receiptKey, JSON.stringify(displayReceipt))
      sessionStorage.removeItem(pendingKey)
      sessionStorage.removeItem(issuanceKey)
      setReceipt(displayReceipt)
      setPendingBallot(null)
    })
  }

  return (
    <div className="voting-grid">
      <aside className="journey">
        <h2>Voting process</h2>
        <ol>
          {[['Choose a candidate', 'Select one candidate on the ballot.'], ['Confirm your ballot', 'Review and submit your selection.'], ['Save your receipt', 'Verify inclusion after polls close.']].map(([label, description], index) => (
            <li key={label} className={step === index + 1 ? 'current' : ''} aria-current={step === index + 1 ? 'step' : undefined}>
              <span className="step-number" aria-hidden="true">{step > index + 1 ? '✓' : index + 1}</span>
              <span><strong>{label}</strong><small>{description}</small></span>
            </li>
          ))}
        </ol>
      </aside>

      <section className="panel" aria-label="Voting">
        {receipt ? <Receipt election={election} value={receipt} onAudit={() => onAudit(receipt)} /> :
          election.status === 'closed' && !pendingBallot ? (
            <div className="empty-state"><h2>Polls are closed</h2><p>View the published count or verify an existing receipt.</p>
              <button type="button" onClick={onAudit}>View results &amp; audit</button></div>
          ) : (
            <form onSubmit={cast}>
              <h2>{pendingBallot ? 'Recover ballot receipt' : reviewing ? 'Review your ballot' : 'Choose one candidate'}</h2>
              {pendingBallot ? <p className="intro">Resend the same encrypted submission to recover its receipt.</p> : reviewing ? (
                <p className="intro">You selected <strong>{election.candidates.find(({ id }) => id === choice)?.name}</strong>. Confirm to encrypt and submit your ballot for {constituencyLabel(election.seat)}.</p>
              ) : (
                <>
                  <p className="intro">Your choice is final after you submit it.</p>
                  <fieldset><legend className="visually-hidden">Candidates</legend>
                    {election.candidates.map((candidate) => (
                      <label key={candidate.id} className="candidate">
                        <CandidateSymbol candidate={candidate} />
                        <span><strong>{candidate.name}</strong><small>{candidate.group} · {candidate.symbol}</small></span>
                        <input type="radio" name="candidate" value={candidate.id} checked={choice === candidate.id}
                          disabled={action.busy} onChange={() => setChoice(candidate.id)} required />
                      </label>
                    ))}
                  </fieldset>
                </>
              )}
              <ErrorNotice message={action.message} />
              <div className="actions"><button disabled={action.busy || (!choice && !pendingBallot)}>{action.busy ? 'Submitting…' : pendingBallot ? 'Retry submission' : reviewing ? 'Confirm and cast ballot' : 'Review selection'}</button>
                {reviewing && !pendingBallot && <button type="button" className="secondary" disabled={action.busy} onClick={() => setReviewing(false)}>Change selection</button>}
              </div>
            </form>
          )}
      </section>
    </div>
  )
}

function usePublishedAudit(election) {
  const [audit, setAudit] = useState(null)
  const [loadError, setLoadError] = useState('')
  useEffect(() => {
    if (election.status !== 'closed') return
    const controller = new AbortController()
    async function load() {
      try {
        const document = await api('/audit', { signal: controller.signal })
        if (!await verifyAudit(election, document)) throw new Error('The publication signature could not be verified.')
        if (!controller.signal.aborted) {
          setLoadError('')
          setAudit(document)
        }
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error.message)
      }
    }
    load()
    return () => controller.abort()
  }, [election])
  return { audit, loadError }
}

function Audit({ election, ballotReceipt }) {
  const { audit, loadError } = usePublishedAudit(election)
  const [receipt, setReceipt] = useState(() => ballotReceipt || readBallotState(`votesecure:${election.id}:receipt`) || readBallotState(`votesecure:${election.id}:last-receipt`) || '')
  const [verified, setVerified] = useState('')
  const action = useAction()
  useEffect(() => {
    if (ballotReceipt || election.status !== 'closed') return
    const controller = new AbortController()
    api('/voter-account', { signal: controller.signal }).then(({ account }) => {
      if (!account || controller.signal.aborted) return
      const saved = readBallotState(ballotStorageKey(election, account.ballotWorkspace, 'receipt'))
      if (saved) setReceipt((current) => current || saved)
    }).catch(() => {
      // People can still paste or upload a receipt without an active session.
    })
    return () => controller.abort()
  }, [ballotReceipt, election.id, election.status])

  async function check(event) {
    event.preventDefault()
    const input = receipt.replace(/\s/g, '')
    const shortCode = input.toUpperCase()
    const candidateReceipt = isReceiptCode(shortCode) ? shortCode : input.toLowerCase()
    setVerified('')
    action.run(async () => {
      const short = isReceiptCode(candidateReceipt)
      if (!short && !isHex(candidateReceipt, 32)) throw new Error('Enter the six-letter code from your voting receipt.')
      const data = await api('/audit/receipts/' + candidateReceipt)
      const returnedCode = short ? data.receiptCode : data.receipt
      if (returnedCode !== candidateReceipt || !isHex(data.receipt, 32) ||
        !await MerkleTree.verify(data.receipt, data.proof, audit.snapshot.root)) {
        throw new Error('The receipt proof did not match the published ledger.')
      }
      setVerified(candidateReceipt)
    })
  }

  if (election.status === 'open') return (
    <section className="panel empty-state"><h2>Results open after polls close</h2>
      <p>Keep your receipt code. The tally and receipt verification will be available here after the election closes.</p></section>
  )
  if (loadError) return <section className="panel"><ErrorNotice message={loadError} /></section>
  if (!audit) return <section className="panel"><p role="status">Checking the signed results…</p></section>
  const { snapshot } = audit
  return (
    <div className="audit-grid">
      <section className="panel">
        <h2>Published results</h2>
        <p className="intro">{snapshot.ballots} recorded · {snapshot.invalid} invalid · Publication signature verified</p>
        <ResultsTable candidates={election.candidates} results={snapshot.results} />
        <p className="root-label">Published Merkle root</p><code className="digest">{snapshot.root}</code>
        <div className="actions"><a className="button secondary" href="/api/audit/export">Download audit data</a></div>
      </section>
      <section className="panel">
        <form onSubmit={check}>
          <h2>Verify receipt</h2>
          <p className="intro">Check whether your encrypted ballot is in the published ledger.</p>
          <label htmlFor="receipt">Receipt code</label>
          <input id="receipt" value={receipt} placeholder="Six letters" required spellCheck="false" autoComplete="off"
            onChange={(event) => { setReceipt(event.target.value); setVerified('') }} />
          <label htmlFor="receipt-file">Or upload your receipt (PDF or text)</label>
          <input id="receipt-file" type="file" accept=".pdf,application/pdf,.txt,text/plain" onChange={(event) => {
            const file = event.target.files?.[0]
            if (!file) return
            action.run(async () => {
              setVerified('')
              setReceipt(await readReceiptFile(file))
            })
            event.target.value = ''
          }} />
          <p className="intro">Inclusion confirms your encrypted ballot appears in the ledger. Independently checking the candidate tally requires additional evidence.</p>
          <ErrorNotice message={action.message} />
          {verified && <p className="notice success" role="status">Verified. Your encrypted ballot is in the published ledger.</p>}
          <div className="actions"><button disabled={action.busy}>{action.busy ? 'Verifying…' : 'Verify inclusion'}</button></div>
        </form>
      </section>
    </div>
  )
}

function Admin({ election, onClosed, onReset }) {
  const [key, setKey] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const action = useAction()
  const [confirmation, setConfirmation] = useState('')
  function reset(event) {
    event.preventDefault()
    action.run(async () => {
      await api('/admin/reset', { body: { electionId: election.id, confirmation }, adminKey: key })
      onReset()
    })
  }
  function close(event) {
    event.preventDefault()
    action.run(async () => {
      await api('/admin/close', { body: { electionId: election.id }, adminKey: key })
      setKey('')
      setConfirmed(false)
      onClosed()
    })
  }
  return (
    <section className="panel admin-panel">
      <h2>Election administration</h2>
      <label htmlFor="admin-key">Election admin key</label>
      <input id="admin-key" type="password" autoComplete="off" value={key} required onChange={(event) => setKey(event.target.value)} />
      {election.status === 'closed' ? <p className="notice success" role="status">Polls are closed. The signed results are available in the audit view.</p> : (
        <form onSubmit={close}>
          <p className="intro">Closing is final for this run. It ends ballot intake and publishes the signed tally and receipt proofs.</p>
          <label className="checkbox"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} required /> Confirm that the polls should close.</label>
          <div className="actions"><button disabled={action.busy || !key || !confirmed}>{action.busy ? 'Publishing…' : 'Close polls and publish'}</button></div>
        </form>
      )}
      <form className="account-switch" onSubmit={reset}>
        <h3>Reset election and accounts</h3>
        <p className="intro">This permanently deletes ballots, receipts, results, voter registrations and active sessions. Polls reopen and everyone must sign up again.</p>
        <label htmlFor="reset-confirmation">Type RESET to confirm</label>
        <input id="reset-confirmation" autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
        <div className="actions"><button className="secondary" disabled={action.busy || !key || confirmation !== 'RESET'}>Reset election and accounts</button></div>
      </form>
      <ErrorNotice message={action.message} />
    </section>
  )
}

function StartupLoader() {
  return (
    <main className="startup-loader" aria-busy="true" aria-label="Loading VoteSecure PK">
      <div className="loader-orbit" aria-hidden="true" />
      <div className="loader-content">
        <div className="ballot-animation" aria-hidden="true">
          <div className="loader-paper"><span /></div>
          <div className="loader-slot" />
          <div className="loader-box"><span /></div>
        </div>
        <p className="loader-brand">VoteSecure <span>PK</span></p>
        <p className="loader-message" role="status">Opening your election portal</p>
        <div className="loader-track" aria-hidden="true"><span /></div>
      </div>
    </main>
  )
}

const candidatePriorities = {
  cedar: ['Safer walking routes near schools', 'Better access to neighbourhood clinics'],
  river: ['More reliable bus service', 'Flood preparation for low-lying streets'],
  harbor: ['Apprenticeships for young residents', 'Stronger waste collection and recycling'],
}

function PublishedOutcome({ election }) {
  const { audit, loadError } = usePublishedAudit(election)
  if (loadError) return <section className="panel"><ErrorNotice message={loadError} /></section>
  if (!audit) return <section className="panel"><p role="status">Checking the signed results…</p></section>

  const results = audit.snapshot.results
  const mostVotes = Math.max(0, ...results.map(({ votes }) => votes))
  const leaders = results.filter(({ votes }) => votes === mostVotes)
  const names = leaders.map(({ id }) => election.candidates.find((candidate) => candidate.id === id)?.name ?? id)
  const title = mostVotes === 0 ? 'No winner' : leaders.length === 1 ? 'Winner' : 'Tie for first place'

  return (
    <section className="panel published-outcome" aria-labelledby="outcome-heading">
      <div className="outcome-summary">
        <div className="outcome-heading">
          <p>Published election result</p>
          <h2 id="outcome-heading">{title}</h2>
        </div>
        {mostVotes === 0 ? <p>No valid votes were cast.</p> : (
          <div className="outcome-details">
            <p className="outcome-names">{new Intl.ListFormat('en').format(names)}</p>
            <p>{mostVotes.toLocaleString('en-PK')} {mostVotes === 1 ? 'vote' : 'votes'}{leaders.length > 1 ? ' each' : ''}</p>
          </div>
        )}
      </div>
      <ResultsTable candidates={election.candidates} results={[...results].sort((a, b) => b.votes - a.votes)} />
    </section>
  )
}

function Home({ election }) {
  return (
    <>
      {election.status === 'closed' && <PublishedOutcome election={election} />}
      <section className="candidate-section" aria-labelledby="candidate-heading">
        <div className="showcase-heading">
          <div><h2 id="candidate-heading">Meet the candidates</h2><p>Explore the fictional candidates and their priorities for this constituency.</p></div>
        </div>
        <div className="showcase-candidates">
          {election.candidates.map((candidate) => (
            <article className="panel showcase-candidate" key={candidate.id}>
              <CandidateSymbol candidate={candidate} />
              <div className="candidate-identity"><h3>{candidate.name}</h3><p>{candidate.group} · {candidate.symbol}</p></div>
              <ul>{candidatePriorities[candidate.id]?.map((priority) => <li key={priority}>{priority}</li>)}</ul>
            </article>
          ))}
        </div>
      </section>
      <section className="panel walkthrough">
        <h2>How voting works</h2>
        <ol>
          <li>Sign in to your verified VoteSecure account.</li>
          <li>Review your candidate selection and cast an encrypted ballot.</li>
          <li>Save your receipt. Once polls close, check it against the published ledger.</li>
        </ol>
      </section>
    </>
  )
}

function ThemeButton({ dark, toggle }) {
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode'
  return (
    <button type="button" className="theme-toggle" aria-label={label} title={label} onClick={toggle}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {dark ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M19 5l-1.5 1.5m-11 11L5 19" /></>
          : <path d="M20.8 14.3A9 9 0 0 1 9.7 3.2a9 9 0 1 0 11.1 11.1Z" />}
      </svg>
    </button>
  )
}

function VoterAccount({ onVote, onAuthenticated }) {
  const [session, setSession] = useState(null)
  const [loadingError, setLoadingError] = useState('')
  const [mode, setMode] = useState('signup')
  const signup = mode === 'signup'
  const reset = mode === 'reset'
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [email, setEmail] = useState('')
  const [cnic, setCnic] = useState('')
  const [mobile, setMobile] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [waiting, setWaiting] = useState(false)
  const action = useAction()

  useEffect(() => {
    const controller = new AbortController()
    api('/voter-account', { signal: controller.signal }).then(setSession).catch(() => {
      if (!controller.signal.aborted) setLoadingError('Could not load your account. Reopen Account to retry.')
    })
    return () => controller.abort()
  }, [])

  function submit(event) {
    event.preventDefault()
    action.run(async () => {
      if (mode === 'login') {
        await api('/voter-account', { body: { action: 'login', email, password, remember } })
        onAuthenticated()
        return
      }
      if (!waiting) {
        if (signup && ([...password].length < 12 || [...password].length > 128)) {
          throw new Error('Choose a password with 12 to 128 characters.')
        }
        const body = signup ? { action: 'signup', email, cnic, name, mobile } : { action: 'reset', email }
        await api('/voter-account', { body })
        setWaiting(true)
        setCnic('')
        setName('')
        setMobile('')
        return
      }
      await api('/voter-account', { body: { action: 'confirm', code, password, remember } })
      onAuthenticated()
    })
  }

  function logout() {
    action.run(async () => {
      setSession(await api('/voter-account', { body: { action: 'logout' } }))
      setPassword('')
      setMode('login')
    })
  }

  function changeMode(next) {
    setMode(next)
    setWaiting(false)
    setCode('')
    setPassword('')
    action.clearMessage()
  }

  return (
    <section className="panel account-panel">
      <h1>{session?.account ? 'Your VoteSecure account' : waiting ? 'Check your email' : signup ? 'Create a voter account' : reset ? 'Set or reset your password' : 'Sign in to VoteSecure PK'}</h1>
      {session?.account ? (
        <>
          <p className="intro">Signed in as {session.account.name}.</p>
          <div className="actions"><button type="button" onClick={onVote}>Open voting</button>
            <button type="button" className="secondary" disabled={action.busy} onClick={logout}>Sign out</button></div>
        </>
      ) : (
        <>
          {session?.enabled === false && <p role="status" className="intro">Email verification is temporarily unavailable.</p>}
          {!session && !loadingError && <p role="status">Checking account availability…</p>}
          <form key={mode} onSubmit={submit}>
            <fieldset disabled={!session?.enabled || action.busy}>
              <legend className="visually-hidden">{waiting ? 'Email verification' : 'Account details'}</legend>
              {waiting ? (
                <>
                  <p className="intro">If the request is eligible, an eight-digit code will arrive at <strong>{email}</strong>. The code expires in 10 minutes.</p>
                  <label htmlFor="account-code">Email code</label>
                  <input id="account-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" maxLength={8}
                    required value={code} onChange={(event) => setCode(event.target.value)} />
                </>
              ) : (
                <>
                  <p className="intro">{signup ? 'Create a password and verify your email to open your account.' : reset ? 'We’ll send a code so you can set a password for your verified email.' : 'Sign in with your verified email and password.'}</p>
                  <label htmlFor="account-email">Email address</label>
                  <input id="account-email" type="email" autoComplete="email" maxLength={254} required
                    value={email} onChange={(event) => setEmail(event.target.value)} />
                  {signup && <>
                    <label htmlFor="account-cnic">CNIC</label>
                    <input id="account-cnic" inputMode="numeric" autoComplete="off" maxLength={24} required
                      value={cnic} onChange={(event) => setCnic(event.target.value)} />
                    <label htmlFor="account-name">Full name</label>
                    <input id="account-name" autoComplete="name" maxLength={100} required value={name}
                      onChange={(event) => setName(event.target.value)} />
                    <label htmlFor="account-mobile">Mobile number</label>
                    <input id="account-mobile" type="tel" autoComplete="tel" maxLength={30} required placeholder="03XX XXXXXXX"
                      value={mobile} onChange={(event) => setMobile(event.target.value)} />
                  </>}
                </>
              )}
              {((signup && !waiting) || (reset && waiting) || mode === 'login') && <>
                <label htmlFor="account-password">{mode === 'login' ? 'Password' : 'Create password'}</label>
                <input id="account-password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required minLength={mode === 'login' ? undefined : 12} maxLength={256} value={password}
                  onChange={(event) => setPassword(event.target.value)} aria-describedby={mode === 'login' ? undefined : 'password-rules'} />
                {mode !== 'login' && <p id="password-rules" className="intro">Use 12 to 128 characters.</p>}
              </>}
              {(waiting || mode === 'login') && <label className="checkbox">
                <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> Remember me on this device
              </label>}
            </fieldset>
            <div className="actions">
              <button disabled={!session?.enabled || action.busy}>
                {action.busy ? 'Please wait…' : waiting ? signup ? 'Verify and sign in' : 'Save password and sign in'
                  : signup ? 'Send verification email' : reset ? 'Send password setup code' : 'Sign in'}
              </button>
              {waiting && <button type="button" className="secondary" disabled={action.busy}
                onClick={() => changeMode(mode)}>Start over</button>}
            </div>
          </form>
          {!waiting && <div className="actions account-switch">
            <button type="button" className="secondary" disabled={action.busy}
              onClick={() => changeMode(mode === 'login' ? 'signup' : 'login')}>
              {signup ? 'Already registered? Sign in' : reset ? 'Back to sign in' : 'Create an account'}
            </button>
            {mode === 'login' && <button type="button" className="secondary" disabled={action.busy}
              onClick={() => changeMode('reset')}>Set or reset password</button>}
          </div>}
        </>
      )}
      <ErrorNotice message={action.message || loadingError} />
    </section>
  )
}

function App() {
  const [tab, setTab] = useState('home')
  const [auditReceipt, setAuditReceipt] = useState('')
  const [election, setElection] = useState(null)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(true)
  const [dark, setDark] = useState(() => localStorage.getItem('votesecure:theme') !== 'light')
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#edf5ef')
  }, [dark])
  function toggleTheme() {
    const next = !dark
    localStorage.setItem('votesecure:theme', next ? 'dark' : 'light')
    setDark(next)
  }
  function navigate(next, receipt = '') {
    setAuditReceipt(receipt)
    setTab(next)
    window.scrollTo(0, 0)
    refresh()
  }
  async function refresh() {
    try {
      setElection(await api('/election'))
      setError('')
    } catch (failure) {
      setError(failure.message)
    }
  }
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const timeout = setTimeout(() => controller.abort(), 15000)
    const minimumDuration = new Promise((resolve) => setTimeout(resolve, 1600))
    async function start() {
      try {
        const [data] = await Promise.all([
          api('/election', { signal: controller.signal }),
          minimumDuration,
        ])
        if (active) setElection(data)
      } catch (failure) {
        await minimumDuration
        if (active) setError(controller.signal.aborted
          ? 'The connection timed out. Check that the API is running, then retry.'
          : failure.message)
      } finally {
        clearTimeout(timeout)
        if (active) setStarting(false)
      }
    }
    start()
    return () => {
      active = false
      clearTimeout(timeout)
      controller.abort()
    }
  }, [])

  if (starting) return <StartupLoader />

  return (
    <>
      <header className="masthead"><div className="header-inner">
        <a href="#main" className="brand" onClick={() => navigate('home')}><span className="brand-mark" aria-hidden="true">✓</span><span>VoteSecure <b>PK</b></span></a>
        <nav aria-label="Election navigation">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined}
              onClick={() => navigate(id)} aria-label={label}>
              <svg className="nav-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"><path d={navIcons[id]} /></svg>
              <span className="nav-full">{label}</span><span className="nav-short" aria-hidden="true">{{ vote: 'Vote', audit: 'Audit', admin: 'Admin' }[id] ?? label}</span></button>
          ))}
        </nav>
        <ThemeButton dark={dark} toggle={toggleTheme} />
      </div></header>
      <main id="main" className={tab === 'home' && election?.status === 'closed' ? 'shell home-closed' : 'shell'}>
        {tab !== 'account' && <section className={tab === 'home' ? 'hero hero-home' : 'hero hero-compact'}>
          <div className="hero-copy">
            <p className="eyebrow">Academic election portal</p>
            <h1>{election?.name ?? 'Constituency election'}</h1>
            <div className="hero-meta">
              <span>Constituency <strong>{election ? constituencyLabel(election.seat) : 'Karachi'}</strong></span>
              {election && <span className={`status ${election.status}`}><i aria-hidden="true" />{election.status === 'open' ? 'Polls open' : 'Polls closed'}</span>}
            </div>
            {tab === 'home' && election?.status === 'open' && <button type="button" className="hero-action" onClick={() => navigate('vote')}>
              Start voting
            </button>}
          </div>
          <div className="ballot-art" aria-hidden="true">
            <div className="ballot-slip"><i /><i /><i /></div>
            <div className="ballot-box"><span>✓</span></div>
          </div>
        </section>}
        {error && <section className="panel"><ErrorNotice message={error} /><button type="button" onClick={refresh}>Retry connection</button></section>}
        {!election && !error && <p role="status">Loading election…</p>}
        {tab === 'account' && <VoterAccount onVote={() => navigate('vote')} onAuthenticated={() => navigate('home')} />}
        {election && tab === 'home' && <Home election={election} />}
        {election && tab === 'vote' && <Voting key={election.id} election={election} onAccount={() => navigate('account')} onAudit={(receipt) => navigate('audit', receipt)} />}
        {election && tab === 'audit' && <Audit key={election.id} election={election} ballotReceipt={auditReceipt} />}
        {election && tab === 'admin' && <Admin key={election.id} election={election} onClosed={() => navigate('audit')} onReset={() => navigate('home')} />}
      </main>
      <footer className="shell footer"><span>Pakistan Digital Electoral Voting and Verification Platform</span><span>Academic prototype</span></footer>
    </>
  )
}

createRoot(document.getElementById('root')).render(<App />)

