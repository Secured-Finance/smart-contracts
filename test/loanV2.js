const LoanCallerMock = artifacts.require('LoanCallerMock');
const PaymentAggregator = artifacts.require('PaymentAggregator');
const CloseOutNetting = artifacts.require('CloseOutNetting');
const LendingMarketControllerMock = artifacts.require('LendingMarketControllerMock');
const CollateralAggregatorCallerMock = artifacts.require('CollateralAggregatorCallerMock');
const CollateralAggregator = artifacts.require('CollateralAggregator');
const AddressPackingTest = artifacts.require('AddressPackingTest');
const CurrencyController = artifacts.require('CurrencyController');
const ProductAddressResolver = artifacts.require('ProductAddressResolver');
const BokkyPooBahsDateTimeContract = artifacts.require('BokkyPooBahsDateTimeContract');
const TimeSlotTest = artifacts.require('TimeSlotTest');
const MockV3Aggregator = artifacts.require('MockV3Aggregator');

const { emitted, reverted} = require('../test-utils').assert;
const { should } = require('chai');
const { toBytes32 } = require('../test-utils').strings;
const { toEther, toBN } = require('../test-utils').numbers;
const { getLatestTimestamp, ONE_DAY, advanceTimeAndBlock } = require('../test-utils').time;
const utils = require('web3-utils');

should();

const expectRevert = reverted;

contract('LoanV2', async (accounts) => {
    const [owner, alice, bob, carol] = accounts;

    const ZERO_BN = toBN('0');
    const IR_BASE = toBN('10000');
    const DFRAC_3M = toBN('90').div(toBN('360'));

    let signers;

    let hexFILString = toBytes32("FIL");
    let hexETHString = toBytes32("ETH");
    let hexBTCString = toBytes32("BTC");

    let filToETHRate = web3.utils.toBN("67175250000000000");
    let ethToUSDRate = web3.utils.toBN("232612637168");
    let btcToETHRate = web3.utils.toBN("23889912590000000000");

    let loanName = "0xLoan";
    let loanPrefix = "0x21aaa47b";

    let _1yearTimeSlot;
    let _2yearTimeSlot;
    let _3yearTimeSlot;
    let _4yearTimeSlot;
    let _5yearTimeSlot;

    const generateId = (value, prefix) => {
        let right = utils.toBN(utils.rightPad(prefix, 64));
        let left = utils.toBN(utils.leftPad(value, 64));
    
        let id = utils.numberToHex(right.or(left));

        return id;
    };

    const getTimeSlotIdentifierInYears = async (now, years) => {
        let slotTime, slotDate;
        let timeSlots = new Array();
        
        for (i = 0; i < years.length; i++) {
            slotTime = await timeLibrary.addDays(now, years[i] * 365);
            slotDate = await timeLibrary.timestampToDate(slotTime);
            timeSlot = await timeSlotTest.position(slotDate.year, slotDate.month, slotDate.day);    
    
            timeSlots.push(timeSlot);
        }
    
        return timeSlots;
    };

    before('deploy smart contracts for testing LoanV2', async () => {
        signers = await ethers.getSigners();

        const DealId = await ethers.getContractFactory('DealId')
        const dealIdLibrary = await DealId.deploy();
        await dealIdLibrary.deployed();
        productResolver = await ProductAddressResolver.new();

        const loanFactory = await ethers.getContractFactory(
            'LoanV2',
            {
                libraries: {
                    DealId: dealIdLibrary.address
                }
              }
            )
        loan = await loanFactory.deploy();

        const markToMarketFactory = await ethers.getContractFactory(
            'MarkToMarket',
            {
                libraries: {
                    DealId: dealIdLibrary.address
                }
              }
            )
        markToMarket = await markToMarketFactory.deploy(productResolver.address);

        loanCaller = await LoanCallerMock.new(loan.address);
        paymentAggregator = await PaymentAggregator.new();
        closeOutNetting = await CloseOutNetting.new(paymentAggregator.address);
        collateral = await CollateralAggregator.new();
        collateralCaller = await CollateralAggregatorCallerMock.new(collateral.address);
        lendingController = await LendingMarketControllerMock.new();

        await loan.addLendingMarket(hexFILString, 5, loanCaller.address);
        await loan.addLendingMarket(hexFILString, 0, loanCaller.address);
        await loan.setPaymentAggregator(paymentAggregator.address);
        await loan.setCollateralAddr(collateral.address);
        await loan.setLendingControllerAddr(lendingController.address);
        
        await collateral.addCollateralUser(loan.address);
        await collateral.addCollateralUser(collateralCaller.address);

        currencyController = await CurrencyController.new();
        filToETHPriceFeed = await MockV3Aggregator.new(18, hexFILString, filToETHRate);
        ethToUSDPriceFeed = await MockV3Aggregator.new(8, hexETHString, ethToUSDRate);
        btcToETHPriceFeed = await MockV3Aggregator.new(18, hexBTCString, btcToETHRate);

        let tx = await currencyController.supportCurrency(hexETHString, "Ethereum", 60, ethToUSDPriceFeed.address, 7500);
        await emitted(tx, 'CcyAdded');

        tx = await currencyController.supportCurrency(hexFILString, "Filecoin", 461, filToETHPriceFeed.address, 7500);
        await emitted(tx, 'CcyAdded');

        tx = await currencyController.supportCurrency(hexBTCString, "Bitcoin", 0, btcToETHPriceFeed.address, 7500);
        await emitted(tx, 'CcyAdded');

        tx = await currencyController.updateCollateralSupport(hexETHString, true);
        await emitted(tx, 'CcyCollateralUpdate');

        tx = await currencyController.updateMinMargin(hexETHString, 2500);
        await emitted(tx, 'MinMarginUpdated');

        await collateral.setCurrencyControler(currencyController.address, {from: owner});

        await paymentAggregator.addPaymentAggregatorUser(loan.address);
        await paymentAggregator.setCloseOutNetting(closeOutNetting.address);
        await paymentAggregator.setMarkToMarket(markToMarket.address);

        tx = await productResolver.registerProduct(loanPrefix, loan.address, lendingController.address, {from: owner});
        await emitted(tx, 'RegisterProduct');

        addressPacking = await AddressPackingTest.new();

        timeLibrary = await BokkyPooBahsDateTimeContract.new();
        timeSlotTest = await TimeSlotTest.new();

        let status = await paymentAggregator.isPaymentAggregatorUser(loan.address);
        status.should.be.equal(true);
    });

    describe('Test the execution of loan deal between Alice and Bob', async () => {
        let filAmount = web3.utils.toBN("30000000000000000000");
        let filUsed = (filAmount.mul(web3.utils.toBN(2000))).div(web3.utils.toBN(10000));
        let aliceFIlUsed = (filUsed.mul(web3.utils.toBN(15000))).div(web3.utils.toBN(10000));
        let bobFILUsed = (filAmount.mul(web3.utils.toBN(15000))).div(web3.utils.toBN(10000));

        const dealId = generateId(1, loanPrefix);
        const rate = '1450';
        
        const coupon = filAmount.mul(toBN(rate)).div(IR_BASE);
        const repayment = filAmount.add(coupon);
        const closeOutPayment = filAmount.add(coupon.mul(toBN('5'))).sub(filAmount);

        let start;
        let maturity;

        let testTxHash = toBytes32("0xTestTxHash");

        it('Prepare the yield curve', async () => {
            const lendRates = [920, 1020, 1120, 1220, 1320, 1520];
            const borrowRates = [780, 880, 980, 1080, 1180, 1380];
            const midRates = [850, 950, 1050, 1150, 1250, 1450];

            let tx = await lendingController.setBorrowRatesForCcy(hexFILString, borrowRates);
            tx = await lendingController.setLendRatesForCcy(hexFILString, lendRates);

            let rates = await lendingController.getMidRatesForCcy(hexFILString);
            rates.map((rate, i) => {
                rate.toNumber().should.be.equal(midRates[i])
            });
        });

        it('Register collateral books for Bob and Alice', async () => {
            let result = await collateral.register({from: alice, value: 1000000000000000000});
            await emitted(result, 'Register');

            let book = await collateral.getCollateralBook(alice);
            book[0].should.be.equal('0');
            book[1].should.be.equal('1000000000000000000');
            book[2].should.be.equal('0');

            result = await collateral.register({from: bob, value: 10000000000000000000});
            await emitted(result, 'Register');

            book = await collateral.getCollateralBook(bob);
            book[0].should.be.equal('0');
            book[1].should.be.equal('10000000000000000000');
            book[2].should.be.equal('0');
        });
        
        it('Register new loan deal between Alice and Bob', async () => {
            // Alice is lender, trying to lend 30 FIL for 5 years 

            await collateralCaller.useUnsettledCollateral(alice, hexFILString, filUsed);

            await loanCaller.register(alice, bob, 0, hexFILString, 5, filAmount, rate);
            start = await timeLibrary._now();
            maturity = await timeLibrary.addDays(start, 1825);

            let annualSlots = await getTimeSlotIdentifierInYears(start, [1, 2, 3, 4, 5]);
            _1yearTimeSlot = annualSlots[0];
            _2yearTimeSlot = annualSlots[1];
            _3yearTimeSlot = annualSlots[2];
            _4yearTimeSlot = annualSlots[3];
            _5yearTimeSlot = annualSlots[4];

            let deal = await loan.getLoanDeal(dealId);
            deal.lender.should.be.equal(alice);
            deal.borrower.should.be.equal(bob);
            deal.ccy.should.be.equal(hexFILString);
            deal.term.should.be.equal(5);
            deal.notional.toString().should.be.equal(filAmount.toString());
            deal.rate.toString().should.be.equal(rate);
            deal.start.toString().should.be.equal(start.toString());
            deal.end.toString().should.be.equal(maturity.toString());
            
            let schedule = await loan.getPaymentSchedule(dealId);
            schedule.amounts.map((amount, i) => {
                if (i != 5 && i != 0) {
                    amount.toString().should.be.equal(coupon.toString())
                } else if (i != 0) {
                    amount.toString().should.be.equal(repayment.toString())
                }
            });

            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, hexFILString, _1yearTimeSlot);
            timeSlot.netPayment.toString().should.be.equal(coupon.toString());

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, hexFILString, _2yearTimeSlot);
            timeSlot.netPayment.toString().should.be.equal(coupon.toString());

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, hexFILString, _3yearTimeSlot);
            timeSlot.netPayment.toString().should.be.equal(coupon.toString());

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, hexFILString, _4yearTimeSlot);
            timeSlot.netPayment.toString().should.be.equal(coupon.toString());

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, hexFILString, _5yearTimeSlot);
            timeSlot.netPayment.toString().should.be.equal(repayment.toString());

            let closeOut = await closeOutNetting.getCloseOutPayment(alice, bob, hexFILString);
            closeOut.netPayment.toString().should.be.equal(closeOutPayment.toString());
        });

        it('Check locked collateral amounts', async () => {
            let aliceFILInETH = await currencyController.convertToETH(hexFILString, aliceFIlUsed);
            let bobFILInETH = await currencyController.convertToETH(hexFILString, bobFILUsed);

            let book = await collateral.getCollateralBook(alice);
            book.lockedCollateral.should.be.equal(aliceFILInETH.toString());

            book = await collateral.getCollateralBook(bob);
            book.lockedCollateral.should.be.equal(bobFILInETH.toString());

            let position = await collateral.getBilateralPosition(alice, bob);
            position.lockedCollateralA.should.be.equal(bobFILInETH.toString());
            position.lockedCollateralB.should.be.equal(aliceFILInETH.toString());
        });

        it('Try to get last settled payment, verify payment from lender', async () => {
            let payment = await loan.getLastSettledPayment(dealId);
            payment.toString().should.be.equal('0');
            
            now = await getLatestTimestamp();
            let slotTime = await timeLibrary.addDays(now, 2);
            let slotDate = await timeLibrary.timestampToDate(slotTime);
            slotPosition = await timeSlotTest.position(slotDate.year, slotDate.month, slotDate.day);

            await paymentAggregator.verifyPayment(alice, bob, hexFILString, slotTime, filAmount, testTxHash, { from: alice });

            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, hexFILString, slotPosition);
            timeSlot.paymentProof.should.be.equal(testTxHash);
            timeSlot.verificationParty.should.be.equal(alice);
            timeSlot.netPayment.toString().should.be.equal(filAmount.toString());
            timeSlot.isSettled.should.be.equal(false);
        });

        it('Try to settle payment by Bob (borrower) and check last settlement payment', async () => {
            now = await getLatestTimestamp();
            let slotTime = await timeLibrary.addDays(now, 2);
            let slotDate = await timeLibrary.timestampToDate(slotTime);
            slotPosition = await timeSlotTest.position(slotDate.year, slotDate.month, slotDate.day);
            
            let closeOut = await closeOutNetting.getCloseOutPayment(alice, bob, hexFILString);
            closeOut.netPayment.toString().should.be.equal(closeOutPayment.toString());

            await paymentAggregator.settlePayment(bob, alice, hexFILString, slotTime, testTxHash, { from: bob });
    
            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, hexFILString, slotPosition);
            timeSlot.paymentProof.should.be.equal(testTxHash);
            timeSlot.verificationParty.should.be.equal(alice);
            timeSlot.netPayment.toString().should.be.equal(filAmount.toString());
            timeSlot.isSettled.should.be.equal(true);

            closeOut = await closeOutNetting.getCloseOutPayment(alice, bob, hexFILString);
            closeOut.netPayment.toString().should.be.equal((closeOutPayment.add(filAmount)).toString());

            let payment = await loan.getLastSettledPayment(dealId);
            payment.toString().should.be.equal('0');

            let presentValue = await loan.getDealPV(dealId);

            console.log("Present value of the loan for 30 FIL between Alice and Bob after notional exchange: " + presentValue.toString())
            console.log("");
        });

        it('Shift yield curve by 1 percent upwards, calculate present value to see the difference', async () => {
            const lendRates = [1020, 1120, 1220, 1320, 1420, 1620];
            const borrowRates = [880, 980, 1080, 1180, 1280, 1480];
            const midRates = [950, 1050, 1150, 1250, 1350, 1550];

            let tx = await lendingController.setBorrowRatesForCcy(hexFILString, borrowRates);
            tx = await lendingController.setLendRatesForCcy(hexFILString, lendRates);
            let rates = await lendingController.getMidRatesForCcy(hexFILString);
            rates.map((rate, i) => {
                rate.toNumber().should.be.equal(midRates[i])
            });

            let presentValue = await loan.getDealPV(dealId);
            console.log("Present value of the loan for 30 FIL between Alice and Bob after yield curve shift: " + presentValue.toString())
            console.log("");
        });

        it('Shift yield curve by 2 percent down, calculate present value to see the difference', async () => {
            const lendRates = [820, 920, 1020, 1120, 1220, 1420];
            const borrowRates = [680, 780, 880, 980, 1080, 1280];
            const midRates = [750, 850, 950, 1050, 1150, 1350];

            let tx = await lendingController.setBorrowRatesForCcy(hexFILString, borrowRates);
            tx = await lendingController.setLendRatesForCcy(hexFILString, lendRates);
            let rates = await lendingController.getMidRatesForCcy(hexFILString);
            rates.map((rate, i) => {
                rate.toNumber().should.be.equal(midRates[i])
            });

            let presentValue = await loan.getDealPV(dealId);
            console.log("Present value of the loan for 30 FIL between Alice and Bob after another yield curve shift: " + presentValue.toString())
            console.log("");
        });

        it('Try to request/reject early termination of the deal', async () => {
            await loan.connect(signers[1]).requestTermination(dealId);
            await expectRevert(
                loan.acceptTermination(dealId), "borrower must accept"
            );
            await loan.connect(signers[2]).rejectTermination(dealId);
        });

        it('Try to successfully terminate the deal after 30 days', async () => {
            await advanceTimeAndBlock(30 * ONE_DAY);

            await loan.connect(signers[1]).requestTermination(dealId);
            await loan.connect(signers[2]).acceptTermination(dealId);

            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, hexFILString, _1yearTimeSlot);
            timeSlot.netPayment.toString().should.be.equal('0');

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, hexFILString, _2yearTimeSlot);
            timeSlot.netPayment.toString().should.be.equal('0');

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, hexFILString, _3yearTimeSlot);
            timeSlot.netPayment.toString().should.be.equal('0');

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, hexFILString, _4yearTimeSlot);
            timeSlot.netPayment.toString().should.be.equal('0');

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, hexFILString, _5yearTimeSlot);
            timeSlot.netPayment.toString().should.be.equal('0');

            let closeOut = await closeOutNetting.getCloseOutPayment(alice, bob, hexFILString);
            closeOut.netPayment.toString().should.be.equal('0');

            // let position = await collateral.getBilateralPosition(alice, bob);
            // TODO: Add automatic collateral rebalance on terminating the deal and releasing collateral
            // position.lockedCollateralA.should.be.equal(bobFILInETH.toString());
            // position.lockedCollateralB.should.be.equal(aliceFILInETH.toString());

        });
    });

    describe('Test the execution of loan deal between Bob and Alice, try to successfully execute the deal', async () => {
        const rate = toBN(700);
        let filAmount = toBN("10000000000000000000");
        let filUsed = (filAmount.mul(toBN(2000))).div(toBN(10000));
        let aliceFIlUsed = (filAmount.mul(toBN(15000))).div(toBN(10000));
        let bobFILUsed = (filUsed.mul(toBN(15000))).div(toBN(10000));

        const dealId = generateId(2, loanPrefix);
        const annualCoupon = filAmount.mul(rate).div(IR_BASE);
        const coupon = annualCoupon.div(toBN('4'));
        const repayment = filAmount.add(coupon);
        const closeOutPayment = filAmount.add(coupon.sub(filAmount));

        let start;
        let maturity;
        let slotDate;
        let slotPosition;
        let timeSlot;

        let testTxHash = toBytes32("0xTestTxHash2");

        it('Deposit more collateral for Alice', async () => {
            let book = await collateral.getCollateralBook(alice);
            let initialIndependentAmount = book.independentAmount;

            let result = await collateral.deposit({from: alice, value: 9000000000000000000});
            await emitted(result, 'Deposit');

            book = await collateral.getCollateralBook(alice);
            book.independentAmount.should.be.equal(toBN(initialIndependentAmount).add(toBN('9000000000000000000')).toString());
        });

        it('Register new loan deal between Bob and Alice', async () => {
            await collateralCaller.useUnsettledCollateral(bob, hexFILString, filUsed);

            await loanCaller.register(bob, alice, 0, hexFILString, 0, filAmount, rate);
            start = await timeLibrary._now();
            maturity = await timeLibrary.addDays(start, 90);
            slotDate = await timeLibrary.timestampToDate(maturity);
            slotPosition = await timeSlotTest.position(slotDate.year, slotDate.month, slotDate.day);

            let deal = await loan.getLoanDeal(dealId);
            deal.lender.should.be.equal(bob);
            deal.borrower.should.be.equal(alice);
            deal.ccy.should.be.equal(hexFILString);
            deal.term.should.be.equal(0);
            deal.notional.toString().should.be.equal(filAmount.toString());
            deal.rate.toString().should.be.equal(rate.toString());
            deal.start.toString().should.be.equal(start.toString());
            deal.end.toString().should.be.equal(maturity.toString());

            let schedule = await loan.getPaymentSchedule(dealId);
            schedule.amounts[1].toString().should.be.equal(repayment.toString());
            schedule.payments[1].toString().should.be.equal(maturity.toString());

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(bob, alice, hexFILString, slotPosition);
            timeSlot.netPayment.toString().should.be.equal(repayment.toString());

            let closeOut = await closeOutNetting.getCloseOutPayment(alice, bob, hexFILString);
            closeOut.netPayment.toString().should.be.equal(closeOutPayment.toString());

            let presentValue = await loan.getDealPV(dealId);
            presentValue.toString().should.be.equal(filAmount.toString());
            console.log("Present value of the loan for 30 FIL between Alice and Bob before settlement is: " + presentValue.toString())
            console.log("");
        });

        it('Succesfully settle the notional transaction by the lender', async () => {
            now = await getLatestTimestamp();
            let slotTime = await timeLibrary.addDays(now, 2);
            let slotDate = await timeLibrary.timestampToDate(slotTime);
            slotPosition = await timeSlotTest.position(slotDate.year, slotDate.month, slotDate.day);

            await paymentAggregator.verifyPayment(bob, alice, hexFILString, slotTime, filAmount, testTxHash, { from: bob });

            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, hexFILString, slotPosition);
            timeSlot.paymentProof.should.be.equal(testTxHash);
            timeSlot.verificationParty.should.be.equal(bob);
            timeSlot.netPayment.toString().should.be.equal(filAmount.toString());
            timeSlot.isSettled.should.be.equal(false);

            await paymentAggregator.settlePayment(alice, bob, hexFILString, slotTime, testTxHash, { from: alice });

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, hexFILString, slotPosition);
            timeSlot.isSettled.should.be.equal(true);

            let presentValue = await loan.getDealPV(dealId);
            // presentValue.toString().should.be.equal(filAmount.toString());
            console.log("Present value of the loan for 30 FIL between Alice and Bob before settlement is: " + presentValue.toString())
            console.log("");
        });

    });

});