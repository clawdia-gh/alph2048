#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_BASE_URL = 'https://alph2048daily.aigames.alehpium.org'
const baseUrl = (process.env.BETA_BASE_URL || process.argv[2] || DEFAULT_BASE_URL).replace(/\/$/, '')
const expectedPath = path.resolve(process.cwd(), 'contracts', 'beta-contract.json')

function fail(message, details) {
  console.error(`❌ ${message}`)
  if (details) console.error(details)
  process.exit(1)
}

function ok(message) {
  console.log(`✅ ${message}`)
}

let expected
try {
  expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'))
} catch (err) {
  fail(`Could not read ${expectedPath}`, err?.message)
}

const expectedContractId = String(expected.contractId || '').trim()
if (!expectedContractId) fail('contracts/beta-contract.json is missing contractId')

const healthUrl = `${baseUrl}/api/health`
const economyUrl = `${baseUrl}/api/economy`

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // no-op
  }
  return { res, text, json }
}

const health = await getJson(healthUrl)
if (!health.res.ok) fail(`Health endpoint failed (${health.res.status})`, health.text)
if (!health.json) fail('Health endpoint did not return valid JSON', health.text)

if (health.json.channel !== 'beta') {
  fail(`Expected channel=beta, got ${health.json.channel}`)
}

if (health.json.contractId !== expectedContractId) {
  fail('Contract mismatch between beta service and local beta-contract.json', `expected=${expectedContractId}\nactual=${health.json.contractId}`)
}

ok(`health is live at ${healthUrl}`)
ok(`beta contract id matches (${expectedContractId.slice(0, 10)}...)`)

const economy = await getJson(economyUrl)
if (!economy.res.ok) fail(`Economy endpoint failed (${economy.res.status})`, economy.text)
if (!economy.json) fail('Economy endpoint did not return valid JSON', economy.text)

if (economy.json.contractId !== expectedContractId) {
  fail('Economy endpoint contractId mismatch', `expected=${expectedContractId}\nactual=${economy.json.contractId}`)
}

ok(`economy endpoint reachable at ${economyUrl}`)
console.log('PASS beta health/binding check')
