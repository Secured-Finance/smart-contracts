// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MockUSDC is ERC20, Ownable {
    string private _name = "USD Coin";
    string private _symbol = "USDC";

    constructor(uint256 initialBalance) payable ERC20(_name, _symbol) {
        _mint(msg.sender, initialBalance);
    }

    function decimals() public view virtual override returns (uint8) {
        return 6;
    }

    function mint(address account, uint256 amount) public onlyOwner {
        _mint(account, amount);
    }

    function burn(address account, uint256 amount) public onlyOwner {
        _burn(account, amount);
    }
}