import fs from 'node:fs'

const deploymentPath = new URL('../deployments/.deployments.testnet.json', import.meta.url)
const outPath = new URL('../contracts/beta-contract.json', import.meta.url)

const raw = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))
const deployment = Array.isArray(raw) ? raw.at(-1) : raw
const c = deployment?.contracts?.Tournament2048
if (!c?.contractInstance?.contractId) {
  throw new Error('Tournament2048 deployment not found')
}

const artifact = {
  network: 'testnet',
  deployedAt: new Date().toISOString(),
  contractId: c.contractInstance.contractId,
  address: c.contractInstance.address,
  groupIndex: c.contractInstance.groupIndex,
  deployTxId: c.txId,
  deployerAddress: deployment.deployerAddress,
  codeHash: c.codeHash
}

fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n')
console.log(`Wrote ${outPath.pathname}`)
