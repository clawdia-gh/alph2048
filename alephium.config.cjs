const configuration = {
  networks: {
    devnet: {
      nodeUrl: process.env.DEVNET_NODE_URL || 'http://127.0.0.1:22973',
      privateKeys: ['a642942e67258589cd2b1822c631506632db5a12aabcf413604e785300d762a5'],
      settings: { gameChannel: process.env.GAME_CHANNEL || 'beta' }
    },
    testnet: {
      nodeUrl: process.env.TESTNET_NODE_URL || process.env.NODE_URL || 'https://node.testnet.alephium.org',
      privateKeys: process.env.PRIVATE_KEYS ? process.env.PRIVATE_KEYS.split(',') : [],
      settings: { gameChannel: process.env.GAME_CHANNEL || 'beta' }
    },
    mainnet: {
      nodeUrl: process.env.MAINNET_NODE_URL || process.env.NODE_URL || 'https://node.mainnet.alephium.org',
      privateKeys: process.env.PRIVATE_KEYS ? process.env.PRIVATE_KEYS.split(',') : [],
      settings: { gameChannel: process.env.GAME_CHANNEL || 'prod' }
    }
  }
}

module.exports = configuration
module.exports.default = configuration
