// SPDX-License-Identifier: MIT
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

contract MoneyMarket {
    event SetMoneyMarketBook(address indexed sender);
    event DelMoneyMarketBook(address indexed sender);
    event DelOneItem(address indexed sender);
    event TakeOneItem(address indexed sender);

    enum Ccy {ETH, FIL, USDC}
    enum Term {_3m, _6m, _1y, _2y, _3y, _5y}
    enum Side {LEND, BORROW}

    uint256 constant NUMCCY = 3;
    uint256 constant NUMTERM = 6;
    uint256 constant NUMDF = 7; // numbef of discount factors
    uint256 constant BP = 10000; // basis point

    struct MoneyMarketBook {
        MoneyMarketItem[NUMTERM][NUMCCY] lenders;
        MoneyMarketItem[NUMTERM][NUMCCY] borrowers;
        bool isValue;
    }

    struct MoneyMarketItem {
        Term term;
        uint256 amt;
        uint256 rate; // bps
        uint256 goodtil;
        bool isAvailable;
        address addr;
    }

    struct MoneyMarketInput {
        Term term;
        uint256 amt;
        uint256 rate;
    }

    // For mark to market
    struct DiscountFactor{
        uint256 df3m;
        uint256 df6m;
        uint256 df1y;
        uint256 df2y;
        uint256 df3y;
        uint256 df4y;
        uint256 df5y;
    }

    // keeps all the records
    // MoneyMarketBook [0] for ETH, [1] for FIL, [2] for USDC
    mapping(address => MoneyMarketBook) private moneyMarketMap;
    address[] private marketMakers;

    function getMarketMakers() public view returns (address[] memory) {
        return marketMakers;
    }

    // helper to convert input data to MoneyMarketItem
    function inputToItem(MoneyMarketInput memory input, uint256 goodtil)
        private
        view
        returns (MoneyMarketItem memory)
    {
        MoneyMarketItem memory item;
        item.term = input.term;
        item.amt = input.amt;
        item.rate = input.rate;
        item.goodtil = goodtil;
        item.isAvailable = true;
        item.addr = msg.sender;
        return item;
    }

    // to be called by market makers for booking
    function setMoneyMarketBook(
        Ccy ccy,
        MoneyMarketInput[] memory lenders,
        MoneyMarketInput[] memory borrowers,
        uint256 effectiveSec
    ) public {
        // TODO - check if collateral covers borrowers amt
        MoneyMarketBook storage book = moneyMarketMap[msg.sender];
        MoneyMarketItem[NUMTERM] storage lenderTerms = book.lenders[uint256(ccy)];
        MoneyMarketItem[NUMTERM] storage borrowerTerms = book.borrowers[uint256(ccy)];
        for (uint256 i = 0; i < lenders.length; i++) {
            Term term = lenders[i].term;
            MoneyMarketItem memory newItem = inputToItem(
                lenders[i],
                now + effectiveSec
            );
            lenderTerms[uint256(term)] = newItem;
        }
        for (uint256 i = 0; i < borrowers.length; i++) {
            Term term = borrowers[i].term;
            MoneyMarketItem memory newItem = inputToItem(
                borrowers[i],
                now + effectiveSec
            );
            borrowerTerms[uint256(term)] = newItem;
        }
        if (!moneyMarketMap[msg.sender].isValue) marketMakers.push(msg.sender);
        book.isValue = true;
        emit SetMoneyMarketBook(msg.sender);
    }

    function delMoneyMarketBook() public {
        require(moneyMarketMap[msg.sender].isValue == true, 'MoneyMarketBook not found');
        delete moneyMarketMap[msg.sender];
        for (uint256 i = 0; i < marketMakers.length; i++) {
            if (marketMakers[i] == msg.sender) delete marketMakers[i];
        } // marketMakers.length no change
        emit DelMoneyMarketBook(msg.sender);
    }

    // TODO - [internal] delete from loan contract. require(moneyMarketMap[marketMaker] == true)
    function delOneItem(
        address addr,
        Side side,
        Ccy ccy,
        Term term
    ) public {
        require(moneyMarketMap[addr].isValue == true, 'MoneyMarketBook not found');
        if (side == Side.LEND)
            delete moneyMarketMap[addr].lenders[uint256(ccy)][uint256(term)];
        else delete moneyMarketMap[addr].borrowers[uint256(ccy)][uint256(term)];
        emit DelOneItem(addr);
    }

    function getOneItem(
        address addr,
        Side side,
        Ccy ccy,
        Term term
    ) public view returns (MoneyMarketItem memory) {
        if (side == Side.LEND)
            return moneyMarketMap[addr].lenders[uint256(ccy)][uint256(term)];
        else return moneyMarketMap[addr].borrowers[uint256(ccy)][uint256(term)];
    }

    // to be called from Loan
    // take a deal, update amount, and return rates
    function takeOneItem(
        address addr,
        Side side,
        Ccy ccy,
        Term term,
        uint256 amt
    ) public returns (uint rate) {
        MoneyMarketBook memory book = moneyMarketMap[addr];
        require(book.isValue == true, 'MoneyMarketBook not found');
        MoneyMarketItem storage item;
        if (side == Side.LEND)
            item = moneyMarketMap[addr].lenders[uint256(ccy)][uint256(term)];
        else item = moneyMarketMap[addr].borrowers[uint256(ccy)][uint256(term)];
        if (item.goodtil < now) {
            delOneItem(addr, side, ccy, term);
            revert("Item expired");
        }
        if (item.amt < amt) {
            revert ("Amount too large");
        } else {
            item.amt -= amt; // update amount
        }
        emit TakeOneItem(msg.sender);
        return item.rate;
    }

    function getOneBook(address addr) public view returns (MoneyMarketBook memory) {
        return moneyMarketMap[addr];
    }

    function getAllBooks() public view returns (MoneyMarketBook[] memory) {
        MoneyMarketBook[] memory allBooks = new MoneyMarketBook[](marketMakers.length);
        for (uint256 i = 0; i < marketMakers.length; i++) {
            allBooks[i] = moneyMarketMap[marketMakers[i]];
        }
        return allBooks;
    }

    // priority on lower lend rate, higher borrow rate, larger amt
    function betterItem(
        MoneyMarketItem memory a,
        MoneyMarketItem memory b,
        Side side
    ) private pure returns (MoneyMarketItem memory) {
        if (!a.isAvailable) return b;
        if (!b.isAvailable) return a;
        if (a.rate == b.rate) return a.amt > b.amt ? a : b;
        if (side == Side.LEND) return a.rate < b.rate ? a : b;
        return a.rate > b.rate ? a : b; // Side.BORROW
    }

    function getBestBook() public view returns (MoneyMarketBook memory) {
        MoneyMarketBook memory book;
        for (uint256 i = 0; i < NUMCCY; i++) {
            for (uint256 j = 0; j < NUMTERM; j++) {
                for (uint256 k = 0; k < marketMakers.length; k++) {
                    book.lenders[i][j] = betterItem(
                        book.lenders[i][j],
                        moneyMarketMap[marketMakers[k]].lenders[i][j],
                        Side.LEND
                    );
                    book.borrowers[i][j] = betterItem(
                        book.borrowers[i][j],
                        moneyMarketMap[marketMakers[k]].borrowers[i][j],
                        Side.LEND
                    );
                }
            }
        }
        return book;
    }

    function getLenderRates()
        public
        view
        returns (uint256[NUMTERM][NUMCCY] memory)
    {
        MoneyMarketBook memory bestBook = getBestBook();
        uint256[NUMTERM][NUMCCY] memory rates;
        for (uint256 i = 0; i < NUMCCY; i++) {
            for (uint256 j = 0; j < NUMTERM; j++) {
                rates[i][j] = bestBook.lenders[i][j].rate;
            }
        }
        return rates;
    }

    function getBorrowerRates()
        public
        view
        returns (uint256[NUMTERM][NUMCCY] memory)
    {
        MoneyMarketBook memory bestBook = getBestBook();
        uint256[NUMTERM][NUMCCY] memory rates;
        for (uint256 i = 0; i < NUMCCY; i++) {
            for (uint256 j = 0; j < NUMTERM; j++) {
                rates[i][j] = bestBook.borrowers[i][j].rate;
            }
        }
        return rates;
    }

    // to be called by Loan or Collateral for valuation
    function getMidRates()
        public
        view
        returns (uint256[NUMTERM][NUMCCY] memory)
    {
        MoneyMarketBook memory bestBook = getBestBook();
        uint256[NUMTERM][NUMCCY] memory rates;
        for (uint256 i = 0; i < NUMCCY; i++) {
            for (uint256 j = 0; j < NUMTERM; j++) {
                rates[i][j] =
                    (bestBook.lenders[i][j].rate +
                        bestBook.borrowers[i][j].rate) /
                    2;
            }
        }
        return rates;
    }

    // helper to generate DF
    function genDF(uint256[NUMDF] memory rates) private pure returns (DiscountFactor memory) {
        DiscountFactor memory df;
        // bootstrap in BasisPoint scale
        df.df3m = BP * BP / (BP + rates[0] * 90 / 360);
        df.df6m = BP * BP / (BP + rates[1] * 180 / 360);
        df.df1y = BP * BP / (BP + rates[2]);
        df.df2y = BP * (BP - rates[3] * df.df1y / BP) / (BP + rates[3]);
        df.df3y = BP * (BP - rates[4] * (df.df1y + df.df2y) / BP ) / (BP + rates[4]);
        df.df4y = BP * (BP - rates[5] * (df.df1y + df.df2y + df.df3y) / BP ) / (BP + rates[5]);
        df.df5y = BP * (BP - rates[6] * (df.df1y + df.df2y + df.df3y + df.df4y) / BP ) / (BP + rates[6]);
        return df;
    }

    function getDiscountFactors() public view returns (DiscountFactor[NUMCCY] memory) {
        uint256[NUMTERM][NUMCCY] memory mkt = getMidRates();
        uint256[NUMDF][NUMCCY] memory rates = [
            [mkt[0][0], mkt[0][1], mkt[0][2], mkt[0][3], mkt[0][4], (mkt[0][4] + mkt[0][5])/2, mkt[0][5]],
            [mkt[1][0], mkt[1][1], mkt[1][2], mkt[1][3], mkt[1][4], (mkt[1][4] + mkt[1][5])/2, mkt[1][5]],
            [mkt[2][0], mkt[2][1], mkt[2][2], mkt[2][3], mkt[2][4], (mkt[2][4] + mkt[2][5])/2, mkt[2][5]]
        ];
        DiscountFactor memory dfETH = genDF(rates[0]);
        DiscountFactor memory dfFIL = genDF(rates[1]);
        DiscountFactor memory dfUSDC = genDF(rates[2]);
        return [dfETH, dfFIL, dfUSDC];
    }
}