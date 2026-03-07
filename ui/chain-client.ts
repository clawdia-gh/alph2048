import { getDefaultAlephiumWallet } from '@alephium/get-extension-wallet'
import { WalletConnectProvider } from '@alephium/walletconnect-provider'
import WalletConnectQRCodeModal from '@alephium/walletconnect-qrcode-modal'
import { DUST_AMOUNT, MINIMAL_CONTRACT_DEPOSIT, NodeProvider, addressFromContractId, web3 } from '@alephium/web3'
import { Tournament2048 } from '../artifacts/ts/Tournament2048'

const TESTNET_NODES = [
  'https://node.testnet.alephium.org',
  'https://alephium-testnet.api.onfinality.io/public'
]

// Same WalletConnect project id used in ChainReaction's Alephium web3-react setup.
const WALLET_CONNECT_PROJECT_ID = '6e2562e43678dd68a9070a62b6d52207'

const toByteVec = (value: string) => String(value || '').replace(/^0x/, '')

function ensureProvider() {
  try {
    const existing = web3.getCurrentNodeProvider()
    if (existing) return existing
  } catch {
    // expected when provider is not initialized yet
  }
  const np = new NodeProvider(TESTNET_NODES[0])
  web3.setCurrentNodeProvider(np)
  return np
}

function ensureWalletNodeProvider(wallet: any) {
  const provider = ensureProvider()
  try {
    if (wallet && typeof wallet.setNodeProvider === 'function') {
      wallet.setNodeProvider(provider)
    }
  } catch {
    // non-fatal; some providers may not expose setter
  }

  try {
    if (wallet && !wallet.nodeProvider) {
      wallet.nodeProvider = provider
    }
  } catch {
    // non-fatal
  }
}

const toAtto = (alph: number) => BigInt(Math.round(alph * 1e18))
const attoToAlph = (atto: bigint) => Number(atto) / 1e18
const normalizeAtto = (v: bigint | string | number) => {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') return BigInt(Math.trunc(v))
  return BigInt(v)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function normalizeAccount(raw: any) {
  if (!raw) return null
  if (typeof raw === 'string') return { address: raw }
  if (Array.isArray(raw)) {
    const first = raw[0]
    if (!first) return null
    if (typeof first === 'string') return { address: first }
    if (first?.address) return { address: first.address, group: first.group }
  }
  if (raw?.address) return { address: raw.address, group: raw.group }
  if (raw?.account?.address) return { address: raw.account.address, group: raw.account.group }
  return null
}

export async function resolveAddressGroup(address: string, wallet?: any): Promise<number | null> {
  if (!address) return null

  try {
    if (wallet && typeof wallet.getAccounts === 'function') {
      const accounts = await wallet.getAccounts()
      const found = Array.isArray(accounts)
        ? accounts.find((a: any) => String(a?.address || '').toLowerCase() === String(address).toLowerCase())
        : null
      if (found?.group !== undefined && found?.group !== null) return Number(found.group)
    }
  } catch {
    // ignore and fallback to node lookup
  }

  try {
    const provider = ensureProvider() as any
    const result = await provider.addresses.getAddressesAddressGroup(address)
    const group = result?.group
    return group !== undefined && group !== null ? Number(group) : null
  } catch {
    return null
  }
}

async function connectViaWalletConnect(mode: 'qr' | 'desktop') {
  const w = window as any

  const wc = await WalletConnectProvider.init({
    projectId: WALLET_CONNECT_PROJECT_ID,
    networkId: 'testnet',
    addressGroup: 0,
    // Explicitly avoid deprecated forwarding methods; use SDK node/explorer providers instead.
    methods: [
      'alph_signAndSubmitTransferTx',
      'alph_signAndSubmitDeployContractTx',
      'alph_signAndSubmitExecuteScriptTx',
      'alph_signAndSubmitUnsignedTx',
      'alph_signAndSubmitChainedTx',
      'alph_signUnsignedTx',
      'alph_signMessage'
    ],
    onDisconnected: async () => {
      try { delete w.__alphWallet } catch {}
      try { delete w.__alphAccount } catch {}
    }
  } as any)

  wc.on('displayUri', (uri: string) => {
    if (mode === 'desktop') {
      try { window.open(`alephium://wc?uri=${uri}`) } catch {}
      return
    }
    WalletConnectQRCodeModal.open(uri, () => {
      try { WalletConnectQRCodeModal.close() } catch {}
    })
  })

  await wc.connect()
  try { WalletConnectQRCodeModal.close() } catch {}

  let account: any = null
  try {
    if (typeof wc.getSelectedAccount === 'function') {
      account = normalizeAccount(await wc.getSelectedAccount())
    }
  } catch {
    account = normalizeAccount((wc as any).account)
  }

  if (!account?.address) return null
  if (account.group === undefined || account.group === null) {
    account.group = await resolveAddressGroup(account.address, wc)
  }

  w.__alphWallet = wc
  w.__alphAccount = account
  return { wallet: wc, account }
}

export async function connectWalletConnect() {
  return connectViaWalletConnect('qr')
}

export async function connectDesktopWallet() {
  return connectViaWalletConnect('desktop')
}

export async function disconnectExtensionWallet() {
  const w = window as any
  const wallet = w.__alphWallet
  try {
    if (wallet && typeof wallet.disconnect === 'function') await wallet.disconnect()
    else if (wallet && typeof wallet.lock === 'function') await wallet.lock()
  } catch {
    // best effort only
  }
  try { WalletConnectQRCodeModal.close() } catch {}
  try { delete w.__alphWallet } catch {}
  try { delete w.__alphAccount } catch {}
  return true
}

export async function connectExtensionWallet() {
  const w = window as any

  // Reuse already connected provider session (extension/desktop/walletconnect) when present.
  if (w.__alphWallet && w.__alphAccount?.address) {
    const wallet = w.__alphWallet
    const account = normalizeAccount(w.__alphAccount)
    if (account?.address) {
      if (account.group === undefined || account.group === null) {
        account.group = await resolveAddressGroup(account.address, wallet)
      }
      return { wallet, account }
    }
  }

  const wallet = await getDefaultAlephiumWallet()
  if (!wallet) return null

  ensureWalletNodeProvider(wallet)
  let account: any = null

  try {
    if (typeof wallet.enableIfConnected === 'function') {
      account = normalizeAccount(await wallet.enableIfConnected({ networkId: 'testnet', addressGroup: 0 } as any))
    }
  } catch {
    // fallback below
  }

  if (!account?.address) {
    try {
      account = normalizeAccount(await wallet.enable({ networkId: 'testnet', addressGroup: 0 } as any))
    } catch {
      account = normalizeAccount(await wallet.enable())
    }
  }

  if (!account?.address) return null
  if (account.group === undefined || account.group === null) {
    account.group = await resolveAddressGroup(account.address, wallet)
  }
  w.__alphWallet = wallet
  w.__alphAccount = account
  return { wallet, account }
}

export async function connectWalletAuto() {
  try {
    const ext = await connectExtensionWallet()
    if (ext?.account?.address) return ext
  } catch {
    // ignore and fallback
  }
  return connectWalletConnect()
}

export async function readTournamentState(contractId: string) {
  ensureProvider()
  const contract = Tournament2048.at(addressFromContractId(contractId))
  const state = await contract.fetchState()
  const fields = state.fields

  return {
    currentEntryFeeAtto: fields.currentEntryFee,
    currentEntryFeeAlph: attoToAlph(fields.currentEntryFee),
    potAtto: fields.pot,
    potAlph: attoToAlph(fields.pot),
    topScore: Number(fields.leaderboardTopScore),
    topHolder: fields.leaderboardTopPlayer,
    resetAtMs: Number(fields.lastActivityAt + fields.inactivityResetWindowMs),
    lastActivityAtMs: Number(fields.lastActivityAt),
    roundIndex: Number(fields.roundIndex)
  }
}

export async function startRunTx({ contractId, runIdHash, seedHash, entryFeeAtto }: { contractId: string, runIdHash: string, seedHash: string, entryFeeAtto: bigint | string | number }) {
  ensureProvider()
  const connected = await connectWalletAuto()
  if (!connected) throw new Error('ALEPHIUM_WALLET_NOT_AVAILABLE')

  ensureWalletNodeProvider(connected.wallet)
  const contract = Tournament2048.at(addressFromContractId(contractId))
  const attoFee = normalizeAtto(entryFeeAtto)
  const tx = await contract.transact.startRun({
    signer: connected.wallet,
    args: { runIdHash: toByteVec(runIdHash), seedHash: toByteVec(seedHash), payment: attoFee },
    // payment + map-entry deposit + execution dust buffer
    attoAlphAmount: attoFee + MINIMAL_CONTRACT_DEPOSIT + 5n * DUST_AMOUNT
  })

  return { txId: tx.txId, wallet: connected.account.address }
}

export async function getRunState(contractId: string, runIdHash: string) {
  ensureProvider()
  const contract = Tournament2048.at(addressFromContractId(contractId))
  const rs = await contract.view.getRunState({ args: { runIdHash: toByteVec(runIdHash) } })
  const returns = rs?.returns || []
  return {
    found: returns[0] === true,
    player: returns[1] || null,
    seedHash: returns[2] || null,
    startedAt: returns[3] || 0n,
    submitted: returns[4] === true,
    submittedScore: returns[5] || 0n,
    attestationHash: returns[6] || null
  }
}

export async function submitScoreTx({ contractId, runIdHash, score, attestationHash }: { contractId: string, runIdHash: string, score: number, attestationHash: string }) {
  ensureProvider()
  const connected = await connectWalletAuto()
  if (!connected) throw new Error('ALEPHIUM_WALLET_NOT_AVAILABLE')

  ensureWalletNodeProvider(connected.wallet)
  const contract = Tournament2048.at(addressFromContractId(contractId))
  const runId = toByteVec(runIdHash)

  // Guard against brief testnet propagation lag: wait until run receipt is visible.
  let latestRunState: any = null
  for (let i = 0; i < 6; i++) {
    try {
      const rs = await contract.view.getRunState({ args: { runIdHash: runId } })
      latestRunState = rs
      if (rs?.returns?.[0] === true) break
    } catch {
      // ignore and retry
    }
    await sleep(1200)
  }

  const exists = latestRunState?.returns?.[0] === true
  if (!exists) {
    throw new Error('RUN_NOT_FOUND_ON_CHAIN: start run was not found on this contract (restart run)')
  }

  const owner = String(latestRunState?.returns?.[1] || '').toLowerCase()
  const signer = String(connected.account.address || '').toLowerCase()
  if (owner && signer && owner !== signer) {
    throw new Error('RUN_OWNER_MISMATCH: run was started by a different wallet address')
  }

  const tx = await contract.transact.submitScore({
    signer: connected.wallet,
    args: { runIdHash: runId, score: BigInt(score), attestationHash: toByteVec(attestationHash) },
    attoAlphAmount: 5n * DUST_AMOUNT
  })

  return { txId: tx.txId, wallet: connected.account.address }
}
