/**
 * MVP deploy script placeholder.
 *
 * Intended full flow:
 * 1) Connect node + signer wallet
 * 2) Deploy Tournament2048 with initial values
 * 3) Save deployed contract id for frontend/server
 */

const initialFields = {
  totalRuns: 0,
  totalSubmissions: 0,
  leaderboardTopScore: 0,
  leaderboardTopPlayer: '0x<deployer-address>',
  lastRunIdHash: '0x',
  lastRunSeedHash: '0x',
  lastRunPlayer: '0x<deployer-address>',
  lastRunStartedAt: 0,
  lastRunSubmitted: false,
  lastSubmittedScore: 0,
  lastAttestationHash: '0x'
};

console.log('TODO: implement Alephium deploy with @alephium/web3', initialFields);
