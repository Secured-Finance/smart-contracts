// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IMockERC20} from "./IMockERC20.sol";

contract TokenFaucet is Ownable {
    uint8 private constant MAX_MINT_COUNT = 100;

    mapping(bytes32 => address) currencies;
    mapping(bytes32 => uint256) mintableAmounts;
    mapping(address => uint8) mintCount;

    function getCurrencyAddress(bytes32 _ccy) external view returns (address) {
        return currencies[_ccy];
    }

    function registerCurrency(
        bytes32 _ccy,
        address _token,
        uint256 _mintableAmount
    ) external onlyOwner {
        currencies[_ccy] = _token;
        mintableAmounts[_ccy] = _mintableAmount;
    }

    function mint(bytes32 _ccy) public {
        require(mintCount[msg.sender] < MAX_MINT_COUNT, "Max mint limit exceeded");
        mintCount[msg.sender]++;
        address tokenAddress = currencies[_ccy];
        IMockERC20(tokenAddress).mint(msg.sender, mintableAmounts[_ccy]);
    }
}
