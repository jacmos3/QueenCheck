import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViem],
  verify: {
    etherscan: { enabled: false },
    blockscout: { enabled: false },
    sourcify: { enabled: true },
  },
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        preferWasm: true,
        settings: {
          evmVersion: "cancun",
          optimizer: { enabled: true, runs: 500 },
          viaIR: true,
        },
      },
      production: {
        version: "0.8.28",
        preferWasm: true,
        isolated: true,
        toolVersionsInBuildInfo: true,
        settings: {
          evmVersion: "cancun",
          optimizer: { enabled: true, runs: 500 },
          viaIR: true,
        },
      },
    },
  },
  networks: {
    hardhatMainnet: { type: "edr-simulated", chainType: "l1" },
    hardhatOp: { type: "edr-simulated", chainType: "op" },
    baseSepolia: {
      type: "http",
      chainType: "op",
      chainId: 84532,
      url: configVariable("BASE_SEPOLIA_RPC_URL"),
      accounts: [configVariable("QUEENCHECK_DEPLOYER_PRIVATE_KEY")],
    },
  },
  test: { solidity: { fuzz: { runs: 256 } } },
});
