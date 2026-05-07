'use client';

import { useState, useRef, DragEvent, ChangeEvent } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { AnchorProvider } from '@coral-xyz/anchor';
import { LAMPORTS_PER_SOL, PublicKey, SendTransactionError, SystemProgram } from '@solana/web3.js';
import { Buffer } from 'buffer';
import Link from 'next/link';
import { getProgram, PROGRAM_ID } from '@/lib/provenanceChainProgram';

async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

type Step = 'idle' | 'hashing' | 'ready' | 'submitting' | 'done' | 'error';

const PAPER_ACCOUNT_SPACE = 1100;
const TRANSACTION_FEE_BUFFER_LAMPORTS = 10_000;

function formatSol(lamports: number): string {
  return `${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
}

async function getSubmitErrorMessage(
  error: unknown,
  connection: ReturnType<typeof useConnection>['connection'],
  minimumLamports: number
): Promise<string> {
  const fallback = error instanceof Error ? error.message : 'Transaction failed.';
  const message = fallback.toLowerCase();

  if (message.includes('attempt to debit an account but found no record of a prior credit')) {
    return `This wallet does not have enough devnet SOL to create the on-chain paper record. Fund the same Phantom wallet with at least ${formatSol(minimumLamports)} on Solana Devnet and try again.`;
  }

  if (message.includes('user rejected')) {
    return 'Transaction approval was cancelled in your wallet.';
  }

  if (!(error instanceof SendTransactionError)) {
    return fallback;
  }

  const logs = await error.getLogs(connection);
  const logSummary = logs?.slice(-3).join(' | ');

  if (logSummary?.toLowerCase().includes('attempt to debit an account but found no record of a prior credit')) {
    return `This wallet does not have enough devnet SOL to create the on-chain paper record. Fund the same Phantom wallet with at least ${formatSol(minimumLamports)} on Solana Devnet and try again.`;
  }

  return logSummary ? `${fallback} Logs: ${logSummary}` : fallback;
}

export default function SubmitPage() {
  const { connection } = useConnection();
  const { connected, publicKey, signAllTransactions, signTransaction } = useWallet();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile]       = useState<File | null>(null);
  const [hash, setHash]       = useState('');
  const [title, setTitle]     = useState('');
  const [authors, setAuthors] = useState('');
  const [step, setStep]       = useState<Step>('idle');
  const [txSig, setTxSig]     = useState('');
  const [error, setError]     = useState('');
  const [dragging, setDragging] = useState(false);

  const processFile = async (f: File) => {
    if (!f.name.endsWith('.pdf')) return;
    setFile(f); setStep('hashing'); setHash('');
    const h = await hashFile(f);
    setHash(h); setStep('ready');
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) processFile(f);
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) processFile(f);
  };

  const handleSubmit = async () => {
    if (!connected || !publicKey || !hash || !title.trim() || !authors.trim()) return;
    setStep('submitting'); setError('');
    try {
      const authorList = authors.split(',').map(a => a.trim()).filter(Boolean);
      if (hash.length !== 64) throw new Error('Hash must be a 64 character SHA-256 hex string.');
      if (title.trim().length > 200) throw new Error('Title must be 200 characters or fewer.');
      if (authorList.length > 10) throw new Error('Maximum 10 authors allowed.');
      if (authorList.some(a => a.length > 64)) throw new Error('Author names must be 64 characters or fewer.');
      if (!signTransaction) throw new Error('Use a Solana wallet that can sign transactions, such as Phantom on Devnet.');

      const minimumLamports = await connection.getMinimumBalanceForRentExemption(PAPER_ACCOUNT_SPACE)
        + TRANSACTION_FEE_BUFFER_LAMPORTS;
      const walletBalance = await connection.getBalance(publicKey);

      if (walletBalance < minimumLamports) {
        throw new Error(
          `This wallet needs at least ${formatSol(minimumLamports)} on Solana Devnet to record a paper. Fund the same Phantom wallet and try again.`
        );
      }

      const wallet = { publicKey, signAllTransactions, signTransaction };
      const provider = new AnchorProvider(connection, wallet as never, { commitment: 'confirmed' });
      const program = getProgram(provider);

      const [paperPDA] = PublicKey.findProgramAddressSync([Buffer.from(hash.substring(0, 32))], PROGRAM_ID);
      
      // Pre-check if the document already exists to avoid ugly RPC errors
      const accountInfo = await connection.getAccountInfo(paperPDA);
      if (accountInfo) {
        throw new Error('This exact document has already been recorded on the blockchain!');
      }

      const tx = await program.methods
        .submitPaper(hash, title.trim(), authorList)
        .accounts({ paper: paperPDA, owner: publicKey, systemProgram: SystemProgram.programId })
        .rpc();

      setTxSig(tx);
      setStep('done');
    } catch (e: unknown) {
      const minimumLamports = await connection.getMinimumBalanceForRentExemption(PAPER_ACCOUNT_SPACE)
        + TRANSACTION_FEE_BUFFER_LAMPORTS;
      const msg = await getSubmitErrorMessage(e, connection, minimumLamports);
      setError(msg);
      setStep('error');
    }
  };

  const reset = () => {
    setFile(null); setHash(''); setTitle(''); setAuthors('');
    setStep('idle'); setTxSig(''); setError('');
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@300;400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { min-height: 100%; }
        body { background: #050505; font-family: 'DM Sans', sans-serif; color: #fff; }

        .page { min-height: 100vh; background: #050505; position: relative; overflow: hidden; }
        .glow-tl {
          position: absolute; top: -20%; left: -10%; width: 50vw; height: 50vw;
          border-radius: 50%; pointer-events: none;
          background: radial-gradient(ellipse, rgba(210,72,8,0.35) 0%, transparent 68%);
        }
        .nav {
          display: flex; align-items: center; justify-content: space-between;
          padding: 1rem 2.25rem; border-bottom: 1px solid rgba(255,255,255,0.05);
          position: relative; z-index: 50;
        }
        .logo {
          font-family: 'Syne', sans-serif; font-weight: 800; font-size: 0.95rem;
          display: flex; align-items: center; gap: 0.4rem; text-decoration: none; color: #fff;
        }
        .logo-dot { width: 7px; height: 7px; border-radius: 50%; background: #F97316; flex-shrink: 0; }
        .back {
          font-size: 0.78rem; color: rgba(255,255,255,0.4); text-decoration: none;
          transition: color .2s;
        }
        .back:hover { color: rgba(255,255,255,0.75); }
        .wallet-adapter-button {
          background: #fff !important; color: #000 !important; border-radius: 999px !important;
          font-family: 'DM Sans', sans-serif !important; font-weight: 500 !important;
          font-size: 0.78rem !important; padding: 0.42rem 1.1rem !important;
          height: auto !important; line-height: 1.4 !important;
        }
        .wallet-adapter-button-start-icon { display: none !important; }

        .body { max-width: 560px; margin: 0 auto; padding: 3rem 1.5rem; position: relative; z-index: 10; }
        .page-title { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 2rem; letter-spacing: -0.03em; margin-bottom: 0.4rem; }
        .page-sub { font-size: 0.85rem; color: rgba(255,255,255,0.38); font-weight: 300; margin-bottom: 2.5rem; line-height: 1.6; }

        .drop {
          border: 1.5px dashed rgba(255,255,255,0.12); border-radius: 16px;
          padding: 2.5rem 1.5rem; text-align: center; cursor: pointer;
          transition: border-color .2s, background .2s; margin-bottom: 1.5rem;
          background: rgba(255,255,255,0.02);
        }
        .drop:hover, .drop.dragging { border-color: rgba(249,115,22,0.5); background: rgba(249,115,22,0.03); }
        .drop-icon { font-size: 2rem; margin-bottom: 0.75rem; opacity: 0.7; }
        .drop-label { font-size: 0.85rem; color: rgba(255,255,255,0.5); font-weight: 300; }
        .drop-label span { color: #F97316; cursor: pointer; }

        .file-pill {
          display: flex; align-items: center; justify-content: space-between;
          background: rgba(249,115,22,0.07); border: 1px solid rgba(249,115,22,0.2);
          border-radius: 10px; padding: 0.75rem 1rem; margin-bottom: 1.25rem;
        }
        .file-name { font-size: 0.82rem; font-weight: 500; }
        .file-size { font-size: 0.72rem; color: rgba(255,255,255,0.4); }

        .hash-box {
          background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
          border-radius: 10px; padding: 0.75rem 1rem; margin-bottom: 1.5rem;
        }
        .hash-label { font-size: 0.68rem; color: rgba(255,255,255,0.3); margin-bottom: 0.3rem; text-transform: uppercase; letter-spacing: 0.08em; }
        .hash-value { font-family: 'Courier New', monospace; font-size: 0.72rem; color: #F97316; word-break: break-all; line-height: 1.5; }
        .hash-spinner { font-size: 0.78rem; color: rgba(255,255,255,0.3); }

        label { display: block; font-size: 0.78rem; color: rgba(255,255,255,0.5); margin-bottom: 0.4rem; }
        input[type=text] {
          width: 100%; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px; padding: 0.7rem 1rem; color: #fff; font-family: 'DM Sans', sans-serif;
          font-size: 0.85rem; outline: none; transition: border-color .2s; margin-bottom: 1.1rem;
        }
        input[type=text]:focus { border-color: rgba(249,115,22,0.5); }
        input[type=text]::placeholder { color: rgba(255,255,255,0.2); }
        .hint { font-size: 0.7rem; color: rgba(255,255,255,0.25); margin-top: -0.7rem; margin-bottom: 1.1rem; }

        .submit-btn {
          width: 100%; background: #F97316; color: #fff; border: none;
          border-radius: 12px; padding: 0.9rem; font-family: 'Syne', sans-serif;
          font-size: 0.95rem; font-weight: 700; cursor: pointer; transition: background .2s, opacity .2s;
        }
        .submit-btn:hover:not(:disabled) { background: #ea580c; }
        .submit-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        .connect-prompt {
          text-align: center; padding: 1.5rem;
          background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
          border-radius: 12px; font-size: 0.82rem; color: rgba(255,255,255,0.4);
        }

        .done-box {
          text-align: center; padding: 3rem 1.5rem;
          background: rgba(34,197,94,0.05); border: 1px solid rgba(34,197,94,0.2); border-radius: 16px;
        }
        .done-icon { font-size: 2.5rem; margin-bottom: 1rem; }
        .done-title { font-family: 'Syne', sans-serif; font-size: 1.4rem; font-weight: 800; margin-bottom: 0.5rem; }
        .done-sub { font-size: 0.82rem; color: rgba(255,255,255,0.4); margin-bottom: 1.5rem; line-height: 1.6; }
        .tx-link { display: inline-block; font-size: 0.72rem; color: #F97316; word-break: break-all; text-decoration: none; margin-bottom: 1.5rem; }
        .tx-link:hover { text-decoration: underline; }
        .btn-again {
          background: transparent; color: rgba(255,255,255,0.5);
          border: 1px solid rgba(255,255,255,0.1); border-radius: 999px;
          padding: 0.5rem 1.3rem; font-family: 'DM Sans', sans-serif;
          font-size: 0.8rem; cursor: pointer; transition: background .2s;
        }
        .btn-again:hover { background: rgba(255,255,255,0.07); }

        .error-box {
          background: rgba(239,68,68,0.07); border: 1px solid rgba(239,68,68,0.25);
          border-radius: 10px; padding: 0.9rem 1rem; margin-bottom: 1rem;
          font-size: 0.8rem; color: #f87171;
        }

        @keyframes spin { to { transform: rotate(360deg); } }
        .spinner {
          display: inline-block; width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,0.2); border-top-color: #fff;
          border-radius: 50%; animation: spin .7s linear infinite; vertical-align: middle; margin-right: 6px;
        }
      `}</style>

      <div className="page">
        <div className="glow-tl" />
        <nav className="nav">
          <Link href="/" className="logo"><span className="logo-dot" />ProvenanceChain</Link>
          <Link href="/" className="back">← Back</Link>
          <WalletMultiButton />
        </nav>

        <div className="body">
          <h1 className="page-title">Record a Paper</h1>
          <p className="page-sub">
            Upload your PDF to generate a SHA-256 fingerprint and commit it to Solana. Your document never leaves your machine.
          </p>

          {step === 'done' ? (
            <div className="done-box">
              <div className="done-icon">✅</div>
              <div className="done-title">Recorded On-Chain</div>
              <p className="done-sub">Your document&apos;s hash has been committed to Solana with an immutable timestamp.</p>
              <a className="tx-link" href={`https://solscan.io/tx/${txSig}?cluster=devnet`} target="_blank" rel="noreferrer">
                View on Solscan →
              </a>
              <br />
              <button className="btn-again" onClick={reset}>Record Another</button>
            </div>
          ) : (
            <>
              {/* hidden file input */}
              <input
                ref={inputRef}
                type="file"
                accept=".pdf"
                style={{ display: 'none' }}
                onChange={onChange}
              />

              {!file ? (
                <div
                  className={`drop ${dragging ? 'dragging' : ''}`}
                  onDrop={onDrop}
                  onDragOver={e => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onClick={() => inputRef.current?.click()}
                >
                  <div className="drop-icon">📄</div>
                  <p className="drop-label">
                    <span>Click to upload</span> or drag & drop<br />PDF files only
                  </p>
                </div>
              ) : (
                <>
                  <div className="file-pill">
                    <span className="file-name">📄 {file.name}</span>
                    <span className="file-size">{(file.size / 1024).toFixed(1)} KB</span>
                  </div>
                  <div className="hash-box">
                    <div className="hash-label">SHA-256 Hash</div>
                    {step === 'hashing'
                      ? <div className="hash-spinner">Computing hash…</div>
                      : <div className="hash-value">{hash}</div>
                    }
                  </div>
                </>
              )}

              {(step === 'ready' || step === 'submitting' || step === 'error') && (
                <>
                  <label>Document Title</label>
                  <input
                    type="text"
                    placeholder="e.g. Malaria Intervention Outcomes in Western Kenya"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    disabled={step === 'submitting'}
                  />
                  <label>Authors</label>
                  <input
                    type="text"
                    placeholder="e.g. Dr. Amina Osei, Dr. James Mwangi"
                    value={authors}
                    onChange={e => setAuthors(e.target.value)}
                    disabled={step === 'submitting'}
                  />
                  <p className="hint">Separate multiple authors with commas</p>
                  <p className="hint">Use Phantom on Solana Devnet and keep a little devnet SOL in the same wallet for rent and fees.</p>

                  {step === 'error' && <div className="error-box">{error}</div>}

                  {connected ? (
                    <button
                      className="submit-btn"
                      onClick={handleSubmit}
                      disabled={step === 'submitting' || !title.trim() || !authors.trim()}
                    >
                      {step === 'submitting'
                        ? <><span className="spinner" />Submitting to Solana…</>
                        : 'Submit Paper On-Chain'
                      }
                    </button>
                  ) : (
                    <div className="connect-prompt">
                      Connect a Solana wallet such as Phantom to submit on Devnet
                      <div style={{ marginTop: '0.75rem' }}><WalletMultiButton /></div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
