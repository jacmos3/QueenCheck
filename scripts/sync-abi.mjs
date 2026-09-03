import { readFile, writeFile } from 'node:fs/promises';

const entries = [
  ['factoryAbi', 'artifacts/contracts/QueenCheckFactory.sol/QueenCheckFactory.json'],
  ['gameAbi', 'artifacts/contracts/QueenCheckGame.sol/QueenCheckGame.json'],
  ['recordAbi', 'artifacts/contracts/QueenCheckRecord.sol/QueenCheckRecord.json']
];
const target = new URL('../app/src/lib/contracts/abi.generated.js', import.meta.url);
let output = '// Generated from Hardhat artifacts by npm run sync:abi. Do not edit manually.\n';

for (const [exportName, artifactPath] of entries) {
  const artifact = JSON.parse(
    await readFile(new URL(`../${artifactPath}`, import.meta.url), 'utf8')
  );
  output += `\nexport const ${exportName} = ${JSON.stringify(artifact.abi, null, 2)};\n`;
}

if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8').catch(() => '');
  if (current !== output) {
    console.error('Generated app ABI is stale. Run npm run sync:abi.');
    process.exitCode = 1;
  }
} else {
  await writeFile(target, output);
  console.log('Synchronized QueenCheckFactory, QueenCheckGame, and QueenCheckRecord ABIs.');
}
