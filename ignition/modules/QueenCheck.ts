import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("QueenCheck", (module) => {
  const rules = module.contract("ChessRulesEngine");
  const implementation = module.contract("QueenCheckGame");
  const renderer = module.contract("QueenCheckRenderer");
  const factory = module.contract("QueenCheckFactory", [
    implementation,
    rules,
    renderer,
  ]);

  return { rules, implementation, renderer, factory };
});
