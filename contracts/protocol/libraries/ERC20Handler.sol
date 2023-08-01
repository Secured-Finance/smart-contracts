// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import {IWETH9} from "../interfaces/IWETH9.sol";
import {ERC20HandlerStorage as Storage} from "../storages/libraries/ERC20HandlerStorage.sol";

library ERC20Handler {
    function initialize(address _baseCurrency) internal {
        require(Storage.slot().baseCurrency == address(0), "Already initialized");
        Storage.slot().baseCurrency = _baseCurrency;
    }

    function baseCurrency() internal view returns (address) {
        return Storage.slot().baseCurrency;
    }

    function depositAssets(
        address _token,
        address _payer,
        address _receiver,
        uint256 _amount
    ) internal {
        if (address(_token) == Storage.slot().baseCurrency) {
            convertToWrappedToken(_receiver, _amount);
        } else {
            safeTransferFrom(_token, _payer, _receiver, _amount);
        }
    }

    function withdrawAssets(
        address _token,
        address _receiver,
        uint256 _amount
    ) internal {
        if (address(_token) == Storage.slot().baseCurrency) {
            convertFromWrappedToken(_receiver, _amount);
        } else {
            safeTransfer(_token, _receiver, _amount);
        }
    }

    function convertToWrappedToken(address _receiver, uint256 _amount) internal {
        require(address(this).balance >= _amount, "Insufficient balance");

        IWETH9(Storage.slot().baseCurrency).deposit{value: _amount}();
        IWETH9(Storage.slot().baseCurrency).transfer(_receiver, _amount);
    }

    function convertFromWrappedToken(address _receiver, uint256 _amount) internal {
        uint256 balance = IWETH9(Storage.slot().baseCurrency).balanceOf(address(this));
        require(balance >= _amount, "Insufficient balance");

        if (balance > 0) {
            IWETH9(Storage.slot().baseCurrency).withdraw(_amount);
            safeTransferETH(_receiver, _amount);
        }
    }

    /// @dev Transfer helper from UniswapV2 Router
    function safeApprove(
        address token,
        address to,
        uint256 value
    ) internal {
        // bytes4(keccak256(bytes('approve(address,uint256)')));
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0x095ea7b3, to, value)
        );
        require(
            success && (data.length == 0 || abi.decode(data, (bool))),
            "TransferHelper: APPROVE_FAILED"
        );
    }

    /**
     * There are many non-compliant ERC20 tokens... this can handle most, adapted from UniSwap V2
     * Im trying to make it a habit to put external calls last (reentrancy)
     * You can put this in an internal function if you like.
     */
    function safeTransfer(
        address token,
        address to,
        uint256 amount
    ) internal {
        // solium-disable-next-line security/no-low-level-calls
        (bool success, bytes memory data) = token.call(
            // 0xa9059cbb = bytes4(keccak256("transfer(address,uint256)"))
            abi.encodeWithSelector(0xa9059cbb, to, amount)
        );
        require(
            success && (data.length == 0 || abi.decode(data, (bool))),
            "TransferHelper: TRANSFER_FROM_FAILED"
        ); // ERC20 Transfer failed
    }

    function safeTransferFrom(
        address token,
        address from,
        address to,
        uint256 value
    ) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, value)
        );
        require(
            success && (data.length == 0 || abi.decode(data, (bool))),
            "TransferHelper: TRANSFER_FROM_FAILED"
        );
    }

    function safeTransferETH(address to, uint256 value) internal {
        (bool success, ) = to.call{value: value}(new bytes(0));
        require(success, "TransferHelper: ETH_TRANSFER_FAILED");
    }
}
