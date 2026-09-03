import { readFile } from 'node:fs/promises';

const contracts = [
  ['ChessRulesEngine', 'artifacts/contracts/chess/ChessRulesEngine.sol/ChessRulesEngine.json'],
  ['QueenCheckGame', 'artifacts/contracts/QueenCheckGame.sol/QueenCheckGame.json'],
  ['QueenCheckRenderer', 'artifacts/contracts/QueenCheckRenderer.sol/QueenCheckRenderer.json'],
  ['QueenCheckFactory', 'artifacts/contracts/QueenCheckFactory.sol/QueenCheckFactory.json'],
  ['QueenCheckRecord', 'artifacts/contracts/QueenCheckRecord.sol/QueenCheckRecord.json']
];

const bytes = (hex) => (hex.length - 2) / 2;
let failed = false;

for (const [name, path] of contracts) {
  const artifact = JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
  const creation = bytes(artifact.bytecode);
  const runtime = bytes(artifact.deployedBytecode);
  console.log(`${name}: runtime=${runtime} bytes, initcode=${creation} bytes`);
  if (runtime > 24_576) {
    console.error(`${name} exceeds the EIP-170 runtime limit`);
    failed = true;
  }
  if (creation > 49_152) {
    console.error(`${name} exceeds the EIP-3860 initcode limit`);
    failed = true;
  }
}

if (failed) process.exitCode = 1;
