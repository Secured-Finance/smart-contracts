const PaymentAggregator = artifacts.require('PaymentAggregator');
const PaymentAggregatorCallerMock = artifacts.require('PaymentAggregatorCallerMock');
const TimeSlotTest = artifacts.require('TimeSlotTest');
const BokkyPooBahsDateTimeContract = artifacts.require('BokkyPooBahsDateTimeContract');
const AddressPackingTest = artifacts.require('AddressPackingTest');

const { ethers } = require('hardhat');
const { reverted} = require('../test-utils').assert;
const { should } = require('chai');
const { toBytes32 } = require('../test-utils').strings;
const { toEther, toBN } = require('../test-utils').numbers;
const { getLatestTimestamp, ONE_DAY, advanceTimeAndBlock } = require('../test-utils').time;
should();

const expectRevert = reverted;

contract('PaymentAggregator', async (accounts) => {
    const [owner, alice, bob, carol] = accounts;

    const ZERO_BN = toBN('0');
    const IR_BASE = toBN('10000');

    const zeroAddr = '0x0000000000000000000000000000000000000000';
    const zeroString = '0x0000000000000000000000000000000000000000000000000000000000000000';

    const getTimeSlotIdentifierInYears = async (years) => {
        let slotTime, slotDate;
        let timeSlots = new Array();
        
        for (i = 0; i < years.length; i++) {
            slotTime = await timeLibrary.addYears(now, years[i]);
            slotDate = await timeLibrary.timestampToDate(slotTime);
            timeSlot = await timeSlotTest.position(slotDate.year, slotDate.month, slotDate.day);    
    
            timeSlots.push(timeSlot);
        }
    
        return timeSlots;
    }    

    let timeLibrary;
    let paymentAggregator;
    let aggregatorCaller;
    let timeSlotTest;
    let addressPacking;

    let totalPayment0 = ZERO_BN;
    let couponPayment0 = ZERO_BN;
    let combinedPayment0 = ZERO_BN;
    let crossPayment0 = ZERO_BN;

    let totalPayment1 = ZERO_BN;
    let couponPayment1 = ZERO_BN;
    let combinedPayment1 = ZERO_BN;
    let crossPayment1 = ZERO_BN;

    let _1yearDealStart0;
    let _5yearDealStart0;
    let _1yearDealStart1;

    let now;
    let _3monthTimeSlot;
    let _1yearTimeSlot;
    let _2yearTimeSlot;
    let _3yearTimeSlot;
    let _4yearTimeSlot;
    let _5yearTimeSlot;

    let testCcy = toBytes32("0xTestCcy");
    let testTxHash = toBytes32("0xTestTxHash");

    before('deploy TimeSlotTest', async () => {
        timeLibrary = await BokkyPooBahsDateTimeContract.new();
        addressPacking = await AddressPackingTest.new();
        timeSlotTest = await TimeSlotTest.new();
        paymentAggregator = await PaymentAggregator.new();

        aggregatorCaller = await PaymentAggregatorCallerMock.new(paymentAggregator.address);
        await paymentAggregator.addPaymentAggregatorUser(aggregatorCaller.address);
        let status = await paymentAggregator.isPaymentAggregatorUser(aggregatorCaller.address);
        status.should.be.equal(true);
    });

    describe('Prepare time slot identifiers', async () => {
        it('Add Prepare time slot identifiers', async () => {
            now = await getLatestTimestamp();
            let slotTime = await timeLibrary.addMonths(now, 3);
            let slotDate = await timeLibrary.timestampToDate(slotTime);
            _3monthTimeSlot = await timeSlotTest.position(slotDate.year, slotDate.month, slotDate.day);
    
            let annualSlots = await getTimeSlotIdentifierInYears([1, 2, 3, 4, 5]);
            _1yearTimeSlot = annualSlots[0];
            _2yearTimeSlot = annualSlots[1];
            _3yearTimeSlot = annualSlots[2];
            _4yearTimeSlot = annualSlots[3];
            _5yearTimeSlot = annualSlots[4];
        });
    })

    describe('Register payments', () => {
        it('Add payments for 1 year loan deal with Alice as a borrower', async () => {
            now = await getLatestTimestamp();
            _1yearDealStart0 = now;

            let term = 2;
            let notional = toEther(10000);
            let rate = 700; // 7% interest rate

            couponPayment0 = notional.mul(toBN(rate)).div(IR_BASE);
            totalPayment0 = notional.add(couponPayment0);
            combinedPayment0 = combinedPayment0.add(totalPayment0);
            crossPayment0 = crossPayment0.add(totalPayment0);

            await aggregatorCaller.registerPayments(alice, bob, testCcy, term, notional, rate, 0, true, false);

            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _1yearTimeSlot);
            timeSlot.totalPayment0.toString().should.be.equal('0');
            timeSlot.totalPayment1.toString().should.be.equal(totalPayment0.toString());
            timeSlot.netPayment.toString().should.be.equal(totalPayment0.toString());
            timeSlot.flipped.should.be.equal(true);
        });

        it('Expect revert on adding payments for unsupported term', async () => {
            let notional = toEther(1000);
            let term = 6;
            let rate = 1000;

            await expectRevert(
                aggregatorCaller.registerPayments(alice, bob, testCcy, term, notional, rate, 0, true, false), ""
            );
        });

        it('Add payments for 5 years loan deal with Alice as a borrower, check all payment time slots', async () => {
            now = await getLatestTimestamp();
            _5yearDealStart0 = now;

            let term = 5;
            let notional = toEther(5000);
            let rate = 1000; // 10% interest rate

            couponPayment0 = notional.mul(toBN(rate)).div(IR_BASE);
            crossPayment0 = crossPayment0.add(couponPayment0);
            totalPayment0 = notional.add(couponPayment0);

            await aggregatorCaller.registerPayments(alice, bob, testCcy, term, notional, rate, 0, true, false);
            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _1yearTimeSlot);
            timeSlot.totalPayment0.toString().should.be.equal('0');
            timeSlot.totalPayment1.toString().should.be.equal(crossPayment0.toString());
            timeSlot.netPayment.toString().should.be.equal(crossPayment0.toString());
            timeSlot.flipped.should.be.equal(true);

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _2yearTimeSlot);
            timeSlot.totalPayment0.toString().should.be.equal('0');
            timeSlot.totalPayment1.toString().should.be.equal(couponPayment0.toString());
            timeSlot.netPayment.toString().should.be.equal(couponPayment0.toString());
            timeSlot.flipped.should.be.equal(true);

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _3yearTimeSlot);
            timeSlot.totalPayment0.toString().should.be.equal('0');
            timeSlot.totalPayment1.toString().should.be.equal(couponPayment0.toString());
            timeSlot.netPayment.toString().should.be.equal(couponPayment0.toString());
            timeSlot.flipped.should.be.equal(true);

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _4yearTimeSlot);
            timeSlot.totalPayment0.toString().should.be.equal('0');
            timeSlot.totalPayment1.toString().should.be.equal(couponPayment0.toString());
            timeSlot.netPayment.toString().should.be.equal(couponPayment0.toString());
            timeSlot.flipped.should.be.equal(true);

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _5yearTimeSlot);
            timeSlot.totalPayment0.toString().should.be.equal('0');
            timeSlot.totalPayment1.toString().should.be.equal(totalPayment0.toString());
            timeSlot.netPayment.toString().should.be.equal(totalPayment0.toString());
            timeSlot.flipped.should.be.equal(true);
        });

        it('Add payments for 3 month deal with Alice as borrower', async () => {
            let term = 0;
            let notional = toEther(3000);
            let rate = 400; // 4% interest rate
            let actualRate = rate / 4;

            couponPayment0 = notional.mul(toBN(actualRate)).div(IR_BASE);
            totalPayment0 = notional.add(couponPayment0);

            await aggregatorCaller.registerPayments(alice, bob, testCcy, term, notional, rate, 0, true, false);

            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _3monthTimeSlot);

            timeSlot.totalPayment0.toString().should.be.equal('0');
            timeSlot.totalPayment1.toString().should.be.equal(totalPayment0.toString());
            timeSlot.netPayment.toString().should.be.equal(totalPayment0.toString());
            timeSlot.flipped.should.be.equal(true);
        });

        it('Add payments for 3 months deal with Bob as a borrower, expect slot to flip', async () => {
            let term = 0;
            let notional = toEther(5000);
            let rate = 400; // 4% interest rate
            let actualRate = rate / 4;

            couponPayment1 = notional.mul(toBN(actualRate)).div(IR_BASE);
            totalPayment1 = notional.add(couponPayment1);

            await aggregatorCaller.registerPayments(bob, alice, testCcy, term, notional, rate, 0, true, false);

            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _3monthTimeSlot);
            let delta = toBN(timeSlot.totalPayment0).sub(toBN(timeSlot.totalPayment1));
            timeSlot.totalPayment0.toString().should.be.equal(totalPayment1.toString());
            timeSlot.totalPayment1.toString().should.be.equal(totalPayment0.toString());
            timeSlot.netPayment.should.be.equal(delta.toString());
            timeSlot.flipped.should.be.equal(false);
        });

        it('Add payments for 1 year deal with Bob as a borrower, expect slot to flip', async () => {
            now = await getLatestTimestamp();
            _1yearDealStart1 = now;

            let term = 2;
            let notional = toEther(15000);
            let rate = 700; // 7% interest rate

            couponPayment1 = notional.mul(toBN(rate)).div(IR_BASE);
            totalPayment1 = notional.add(couponPayment1);

            await aggregatorCaller.registerPayments(bob, alice, testCcy, term, notional, rate, 0, true, false);

            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _1yearTimeSlot);
            let delta = totalPayment1.sub(crossPayment0);

            timeSlot.totalPayment0.toString().should.be.equal(totalPayment1.toString());
            timeSlot.totalPayment1.toString().should.be.equal(crossPayment0.toString());
            timeSlot.netPayment.should.be.equal(delta.toString());
            timeSlot.flipped.should.be.equal(false);
        });
    });

    describe('Remove payments', () => {
        it('Remove payments for original 1 year loan deal with Alice as a borrower, expect netPayment to be Bob totalPayment', async () => {
            let term = 2;
            let notional = toEther(10000);
            let rate = 700; // 7% interest rate

            couponPayment0 = notional.mul(toBN(rate)).div(IR_BASE);
            totalPayment0 = notional.add(couponPayment0);
            combinedPayment0 = combinedPayment0.sub(totalPayment0);
            crossPayment0 = crossPayment0.sub(totalPayment0);
            let delta = totalPayment1.sub(crossPayment0);

            await aggregatorCaller.removePayments(alice, bob, testCcy, _1yearDealStart0, term, notional, rate, 0, true, false);

            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _1yearTimeSlot);
            timeSlot.totalPayment0.toString().should.be.equal(totalPayment1.toString());
            timeSlot.totalPayment1.toString().should.be.equal(crossPayment0.toString());
            timeSlot.netPayment.should.be.equal(delta.toString());
            timeSlot.flipped.should.be.equal(false);
        });

        it('Expect revert on removing bigger than registered payments for 1 year timeSlot with Bob as borrower', async () => {
            let term = 2;
            let notional = toEther(20000);
            let rate = 700; // 7% interest rate
            let delta = totalPayment1.sub(crossPayment0);

            await expectRevert(
                aggregatorCaller.removePayments(bob, alice, testCcy, _1yearDealStart1, term, notional, rate, 0, true, false), "SafeMath: subtraction overflow"
            );

            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _1yearTimeSlot);
            timeSlot.totalPayment0.toString().should.be.equal(totalPayment1.toString());
            timeSlot.totalPayment1.toString().should.be.equal(crossPayment0.toString());
            timeSlot.netPayment.should.be.equal(delta.toString());
            timeSlot.flipped.should.be.equal(false);
        });

        it('Remove payments for 1 year loan deal with Bob as a borrower, expect netPayment to be 0', async () => {
            let term = 2;
            let notional = toEther(15000);
            let rate = 700;

            let _5yearCouponPayment0 = toEther(5000).mul(toBN(1000)).div(IR_BASE);

            await aggregatorCaller.removePayments(bob, alice, testCcy, _1yearDealStart1, term, notional, rate, 0, true, false);
            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _1yearTimeSlot);
            timeSlot.totalPayment0.toString().should.be.equal('0');
            timeSlot.totalPayment1.toString().should.be.equal(_5yearCouponPayment0.toString());
            timeSlot.netPayment.should.be.equal(_5yearCouponPayment0.toString());
            timeSlot.flipped.should.be.equal(true);
        });

        it('Remove payments for 5 year loan deal with Alice as a borrower, expect all state being cleared', async () => {
            let term = 5;
            let notional = toEther(5000);
            let rate = 1000; // 10% interest rate

            await aggregatorCaller.removePayments(alice, bob, testCcy, _5yearDealStart0, term, notional, rate, 0, true, false);
            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _1yearTimeSlot);
            timeSlot.totalPayment0.toString().should.be.equal('0');
            timeSlot.totalPayment1.toString().should.be.equal('0');
            timeSlot.netPayment.toString().should.be.equal('0');
            timeSlot.flipped.should.be.equal(true);

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _2yearTimeSlot);
            timeSlot.totalPayment0.toString().should.be.equal('0');
            timeSlot.totalPayment1.toString().should.be.equal('0');
            timeSlot.netPayment.toString().should.be.equal('0');
            timeSlot.flipped.should.be.equal(true);

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _3yearTimeSlot);
            timeSlot.totalPayment0.toString().should.be.equal('0');
            timeSlot.totalPayment1.toString().should.be.equal('0');
            timeSlot.netPayment.toString().should.be.equal('0');
            timeSlot.flipped.should.be.equal(true);

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _4yearTimeSlot);
            timeSlot.totalPayment0.toString().should.be.equal('0');
            timeSlot.totalPayment1.toString().should.be.equal('0');
            timeSlot.netPayment.toString().should.be.equal('0');
            timeSlot.flipped.should.be.equal(true);

            timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _5yearTimeSlot);
            timeSlot.totalPayment0.toString().should.be.equal('0');
            timeSlot.totalPayment1.toString().should.be.equal('0');
            timeSlot.netPayment.toString().should.be.equal('0');
            timeSlot.flipped.should.be.equal(true);

        });
    });

    describe('Verify payment and settle payment', () => {
        let slotTime;
        let notional0 = toEther(3000);
        let notional1 = toEther(5000);
        let rate = 400; // 4% interest rate
        let actualRate = rate / 4;

        let couponPayment0 = notional0.mul(toBN(actualRate)).div(IR_BASE);
        let totalPayment0 = notional0.add(couponPayment0);

        let couponPayment1 = notional1.mul(toBN(actualRate)).div(IR_BASE);
        let totalPayment1 = notional1.add(couponPayment1);

        let netPayment = totalPayment1.sub(totalPayment0);

        it('Expect revert on payment verification for 3 month deal without time shift', async () => {
            slotTime = await timeLibrary.addMonths(now, 3);

            await expectRevert(
                aggregatorCaller.verifyPayment(bob, testCcy, slotTime, netPayment, testTxHash, { from: alice }), "OUT OF SETTLEMENT WINDOW"
            );

            await expectRevert(
                aggregatorCaller.verifyPayment(alice, testCcy, slotTime, netPayment, testTxHash, { from: bob }), "OUT OF SETTLEMENT WINDOW"
            );

            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _3monthTimeSlot);
            timeSlot.netPayment.toString().should.be.equal(netPayment.toString());
            timeSlot.isSettled.should.be.equal(false);
        });

        it('Shift time for 89 days, successfully verify payment', async () => {
            await advanceTimeAndBlock(89 * ONE_DAY);
            await aggregatorCaller.verifyPayment(bob, testCcy, slotTime, netPayment, testTxHash, { from: alice })

            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _3monthTimeSlot);
            timeSlot.paymentProof.should.be.equal(testTxHash);
            timeSlot.verificationParty.should.be.equal(alice);
            timeSlot.netPayment.toString().should.be.equal(netPayment.toString());
            timeSlot.isSettled.should.be.equal(false);
        });

        it('Try to settle the net payment, expect revert on incorrect party', async () => {
            await expectRevert(
                aggregatorCaller.settlePayment(bob, testCcy, slotTime, testTxHash, { from: alice }), "INCORRECT_COUNTERPARTY"
            );

            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _3monthTimeSlot);
            timeSlot.paymentProof.should.be.equal(testTxHash);
            timeSlot.verificationParty.should.be.equal(alice);
            timeSlot.netPayment.toString().should.be.equal(netPayment.toString());
            timeSlot.isSettled.should.be.equal(false);
        });

        it('Successfully settle net payment for 3 month deal', async () => {
            await aggregatorCaller.settlePayment(alice, testCcy, slotTime, testTxHash, { from: bob });

            let timeSlot = await paymentAggregator.getTimeSlotBySlotId(alice, bob, testCcy, _3monthTimeSlot);
            timeSlot.paymentProof.should.be.equal(testTxHash);
            timeSlot.verificationParty.should.be.equal(alice);
            timeSlot.netPayment.toString().should.be.equal(netPayment.toString());
            timeSlot.isSettled.should.be.equal(true);
        });
    });

    describe('Calculate gas costs', () => {
        it('Gas costs for time shift', async () => {
            now = await getLatestTimestamp();

            let gasCost = await timeLibrary.getGasCostofAddYears(now, 1);
            console.log("Gas cost for adding 1 year is " + gasCost.toString() + " gas");

            gasCost = await timeLibrary.getGasCostofAddYears(now, 5);
            console.log("Gas cost for adding 5 years is " + gasCost.toString() + " gas");

            gasCost = await timeLibrary.getGasCostofAddMonths(now, 3);
            console.log("Gas cost for adding 3 months is " + gasCost.toString() + " gas");

            gasCost = await timeLibrary.getGasCostofAddMonths(now, 60);
            console.log("Gas cost for adding 5 years in months is " + gasCost.toString() + " gas");

            gasCost = await timeLibrary.getGasCostofAddDays(now, 91);
            console.log("Gas cost for adding days is " + gasCost.toString() + " gas");
        });
    });

});
