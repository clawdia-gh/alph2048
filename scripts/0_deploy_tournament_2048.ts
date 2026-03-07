import { Deployer, DeployFunction, Network } from '@alephium/cli'
import { Contract, ContractFactory, ContractInstance } from '@alephium/web3'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tournamentArtifact = require('../artifacts/Tournament2048.ral.json')

class Tournament2048Instance extends ContractInstance {}

class Tournament2048Factory extends ContractFactory<Tournament2048Instance, any> {
  at(address: string): Tournament2048Instance {
    return new Tournament2048Instance(address)
  }
}

const Tournament2048 = new Tournament2048Factory(Contract.fromJson(tournamentArtifact))

const ONE_ALPH = 1_000_000_000_000_000_000n
const ONE_DAY_MS = 86_400_000n
const DEFAULT_MIGRATION_RECIPIENT = '1AfBFvSU92Sp1GTgFQKD4LQN91vXj22GijqVztpC56ozA'

const deployTournament2048: DeployFunction<any> = async (
  deployer: Deployer,
  _network: Network<any>
): Promise<void> => {
  const deployerAddress = deployer.account.address

  const result = await deployer.deployContract(Tournament2048, {
    initialFields: {
      baseEntryFee: ONE_ALPH,
      entryGrowthNumerator: 11n,
      entryGrowthDenominator: 10n,
      inactivityResetWindowMs: ONE_DAY_MS,
      payoutBps: 5000n,
      carryBps: 5000n,

      currentEntryFee: ONE_ALPH,
      pot: 0n,
      roundIndex: 0n,
      lastActivityAt: 0n,

      totalRuns: 0n,
      totalSubmissions: 0n,
      leaderboardTopScore: 0n,
      leaderboardTopPlayer: deployerAddress,

      owner: deployerAddress,
      migrationRecipient: DEFAULT_MIGRATION_RECIPIENT,
      migrationMode: false
    }
  })

  console.log('Tournament2048 contract id: ' + result.contractInstance.contractId)
  console.log('Tournament2048 contract address: ' + result.contractInstance.address)
  console.log('Tournament2048 deploy tx id: ' + result.txId)
}

export default deployTournament2048
