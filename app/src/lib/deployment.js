import { getAddress, isAddress, keccak256 } from 'viem';
import { baseSepolia, foundry } from 'viem/chains';
import { factoryAbi, recordAbi } from './contracts/abi.js';
import baseSepoliaDeployment from './deployments/base-sepolia.json' with { type: 'json' };

const trustedBaseDeployments = new WeakMap();

function requireCode(code, label) {
  if (!code || code === '0x') throw new Error(`${label} has no contract bytecode.`);
  return code;
}

function sameAddress(actual, expected, label) {
  if (getAddress(actual) !== getAddress(expected)) {
    throw new Error(`${label} does not match the verified deployment manifest.`);
  }
}

async function localDeployment(publicClient, env) {
  const configured = env.PUBLIC_LOCAL_QUEENCHECK_FACTORY_ADDRESS;
  if (!configured || !isAddress(configured)) {
    throw new Error('Factory address is not configured for the local network.');
  }
  const factory = getAddress(configured);
  const [factoryCode, rawRecord] = await Promise.all([
    publicClient.getCode({ address: factory }),
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'record' })
  ]);
  requireCode(factoryCode, 'Local factory');
  const record = getAddress(rawRecord);
  const [recordCode, recordFactory] = await Promise.all([
    publicClient.getCode({ address: record }),
    publicClient.readContract({ address: record, abi: recordAbi, functionName: 'factory' })
  ]);
  requireCode(recordCode, 'Local record');
  sameAddress(recordFactory, factory, 'Local record factory');
  return { factory, record };
}

export async function verifyManifestDeployment(publicClient, deployment) {
  if (
    deployment.schemaVersion !== 1 ||
    deployment.chainId !== baseSepolia.id ||
    deployment.status !== 'deployed'
  ) {
    throw new Error('QueenCheck is not deployed on Base Sepolia in this release.');
  }

  const contracts = deployment.contracts;
  const names = ['factory', 'gameImplementation', 'rulesEngine', 'renderer', 'record'];
  for (const name of names) {
    if (
      !contracts[name] ||
      !isAddress(contracts[name].address) ||
      contracts[name].sourceVerification !== 'exact_match'
    ) {
      throw new Error(`The ${name} manifest entry is invalid.`);
    }
  }

  const addresses = Object.fromEntries(
    names.map((name) => [name, getAddress(contracts[name].address)])
  );
  const codes = await Promise.all(
    names.map((name) => publicClient.getCode({ address: addresses[name] }))
  );
  names.forEach((name, index) => {
    const code = requireCode(codes[index], name);
    if (keccak256(code) !== contracts[name].runtimeCodeHash) {
      throw new Error(`${name} bytecode does not match the verified deployment manifest.`);
    }
  });

  const factoryRelationships = Object.fromEntries(
    await Promise.all(
      ['implementation', 'rules', 'renderer', 'record'].map(async (functionName) => [
        functionName,
        await publicClient.readContract({
          address: addresses.factory,
          abi: factoryAbi,
          functionName
        })
      ])
    )
  );
  sameAddress(factoryRelationships.implementation, addresses.gameImplementation, 'Factory implementation');
  sameAddress(factoryRelationships.rules, addresses.rulesEngine, 'Factory rules engine');
  sameAddress(factoryRelationships.renderer, addresses.renderer, 'Factory renderer');
  sameAddress(factoryRelationships.record, addresses.record, 'Factory record');

  const [recordFactory, recordRenderer] = await Promise.all([
    publicClient.readContract({ address: addresses.record, abi: recordAbi, functionName: 'factory' }),
    publicClient.readContract({ address: addresses.record, abi: recordAbi, functionName: 'renderer' })
  ]);
  sameAddress(recordFactory, addresses.factory, 'Record factory');
  sameAddress(recordRenderer, addresses.renderer, 'Record renderer');
  return { factory: addresses.factory, record: addresses.record };
}

export async function assertTrustedDeployment(publicClient, chainId, env = {}) {
  const numericChainId = Number(chainId);
  if (numericChainId === foundry.id) return localDeployment(publicClient, env);
  if (numericChainId !== baseSepolia.id) throw new Error('Unsupported network.');
  let verification = trustedBaseDeployments.get(publicClient);
  if (!verification) {
    verification = verifyManifestDeployment(publicClient, baseSepoliaDeployment);
    trustedBaseDeployments.set(publicClient, verification);
    verification.catch(() => trustedBaseDeployments.delete(publicClient));
  }
  return verification;
}
