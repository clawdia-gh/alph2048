import fs from 'node:fs'
import { NodeProvider, web3, DUST_AMOUNT, MINIMAL_CONTRACT_DEPOSIT } from '@alephium/web3'
import { PrivateKeyWallet, deriveSecp256K1PrivateKey } from '@alephium/web3-wallet'
import { Tournament2048 } from '../artifacts/ts'

function loadLatestDeployment() {
  const raw = JSON.parse(fs.readFileSync('deployments/.deployments.testnet.json', 'utf8'))
  const list = Array.isArray(raw) ? raw : [raw]
  const last = list[list.length - 1]
  const c = last?.contracts?.Tournament2048
  if (!c?.contractInstance?.address || !c?.contractInstance?.contractId) {
    throw new Error('Tournament2048 deployment not found in deployments/.deployments.testnet.json')
  }
  return {
    contractAddress: c.contractInstance.address,
    contractId: c.contractInstance.contractId,
    deployTxId: c.txId || null
  }
}

const { contractAddress, contractId, deployTxId } = loadLatestDeployment()
const nodeUrl = process.env.TESTNET_NODE_URL || process.env.NODE_URL || 'https://node.testnet.alephium.org'
web3.setCurrentNodeProvider(new NodeProvider(nodeUrl))

const mnemonic = (process.env.ALPH_MNEMONIC || '').replace(/^"|"$/g, '')
if (!mnemonic) throw new Error('ALPH_MNEMONIC missing')
const privateKey = deriveSecp256K1PrivateKey(mnemonic, Number(process.env.SMOKE_KEY_INDEX || 1))
const signer = new PrivateKeyWallet({ privateKey, nodeProvider: web3.getCurrentNodeProvider() })

const mkHash = (v: string) => Buffer.from(v).toString('hex').padEnd(64, '0').slice(0, 64)
const runIdHash = mkHash(`beta-${Date.now()}`)
const seedHash = mkHash(`seed-${Date.now()}`)
const attestationHash = mkHash(`att-${Date.now()}`)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const contract = Tournament2048.at(contractAddress)
  const state = await contract.fetchState()
  const entryFee = state.fields.currentEntryFee
  const startTx = await contract.transact.startRun({
    signer,
    args: { runIdHash, seedHash, payment: entryFee },
    attoAlphAmount: entryFee + MINIMAL_CONTRACT_DEPOSIT + 5n * DUST_AMOUNT
  })

  // Wait for the start tx to propagate; then retry submit if node still lags.
  await sleep(6000)

  let submitTx: any = null
  let lastError: any = null
  for (let i = 0; i < 8; i++) {
    try {
      submitTx = await contract.transact.submitScore({
        signer,
        args: { runIdHash, score: 2048n, attestationHash },
        attoAlphAmount: 5n * DUST_AMOUNT
      })
      break
    } catch (e: any) {
      lastError = e
      const msg = String(e?.message || e)
      if (msg.includes('Error Code: 1')) {
        await sleep(2000)
        continue
      }
      throw e
    }
  }
  if (!submitTx) throw lastError || new Error('submitScore failed after retries')

  const out = {
    network: 'testnet',
    nodeUrl,
    contractId,
    contractAddress,
    deployTxId,
    runIdHash,
    seedHash,
    attestationHash,
    startRunTxId: startTx.txId,
    submitScoreTxId: submitTx.txId,
    signer: signer.address
  }

  fs.writeFileSync('contracts/beta-smoke-transactions.json', JSON.stringify(out, null, 2) + '\n')
  console.log(JSON.stringify(out, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
