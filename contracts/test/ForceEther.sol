// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
contract ForceEther { constructor() payable {} function force(address payable target) external { selfdestruct(target); } }
