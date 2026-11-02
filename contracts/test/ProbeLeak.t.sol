// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {inco} from "@inco/lightning/src/Lib.sol";

import {PolicyVault} from "../src/PolicyVault.sol";
import {PolicyVaultTest} from "./PolicyVault.t.sol";

/// The relay asks "is this amount within the limits?" as often as it can.
///
/// The requested amount is public and so is every decision, so each spend is a
/// yes/no question about min(cap, budget). Rejections never moved a counter,
/// and since `reclaimExpired` an approval need not either: name a hold that
/// ends a second later, never collect, and take the amount and the call back.
/// Before the attempt budget, this recovered a secret cap of 137,391 exactly in
/// 23 requests at no cost to the goal.
///
/// The attempt budget does not stop the questions; it counts them. Each
/// request spends one attempt whatever its outcome, and reclaim never returns
/// it, so a goal opened with `maxAttempts = A` answers at most A questions.
contract ProbeLeakTest is PolicyVaultTest {
    uint256 constant SECRET_CAP = 137_391; // 0.137391 USDC
    uint256 constant SECRET_BUDGET = 5_000_000; // 5 USDC
    uint32 constant ONE_CALL = 1;
    /// The attacker's prior: the cap lies somewhere in [0, SEARCH_RANGE).
    uint256 constant SEARCH_RANGE = 10_000_000;

    /// Runs the binary search until the goal refuses another request.
    /// Returns the interval the cap is known to lie in.
    function _probe(uint256 goal) internal returns (uint256 lo, uint256 hi, uint256 probes) {
        goalId = goal;
        lo = 0;
        hi = SEARCH_RANGE;

        while (hi - lo > 1 && vault.attemptsRemaining(goalId) > 0) {
            uint256 ask = (lo + hi) / 2;
            uint64 seq = vault.requestSpend(goalId, ask, VENDOR, RESOURCE, uint64(block.timestamp) + 1);
            processAllOperations();
            bool approved = _finalize(seq);
            probes++;

            if (approved) {
                lo = ask;
                // Never collected: wait out the one-second hold and take it back.
                (, uint64 validBefore) = vault.validityWindow(goalId, seq);
                vm.warp(validBefore);
                vault.reclaimExpired(goalId, seq);
                processAllOperations();
            } else {
                hi = ask;
            }
        }
    }

    function _openProbeGoal(uint32 attempts) internal returns (uint256) {
        PolicyVault.OpenGoalParams memory params =
            _paramsWithAttempts(SECRET_BUDGET, SECRET_CAP, ONE_CALL, attempts, OTHER_PAYER, alice);
        uint256 fee = 2 * inco.getFee();
        vm.deal(alice, fee);
        vm.prank(alice);
        uint256 id = vault.openGoal{value: fee}(params);
        processAllOperations();
        return id;
    }

    /// With a small attempt budget the search is cut off, and what it learned is
    /// exactly what the bound allows: an interval no narrower than the prior
    /// range divided by 2^attempts.
    function testProbingIsBoundedByTheAttemptBudget() public {
        uint32 attempts = 8;
        (uint256 lo, uint256 hi, uint256 probes) = _probe(_openProbeGoal(attempts));

        console.log("probes", probes);
        console.log("cap lies in", lo, hi);

        assertEq(probes, attempts, "the search should have used every attempt");
        assertTrue(lo <= SECRET_CAP && SECRET_CAP < hi, "the interval must still contain the cap");
        assertGt(hi - lo, 1, "the cap must not be recovered exactly");
        assertGe(hi - lo, SEARCH_RANGE >> attempts, "learned more than attempts bits allow");

        vm.expectRevert(PolicyVault.NoAttemptsLeft.selector);
        vault.requestSpend(goalId, lo, VENDOR, RESOURCE, uint64(block.timestamp) + 1);
    }

    /// The bound is the owner's choice. An owner who allows as many attempts as
    /// the search needs gets no protection from it, which is why the number is
    /// set per goal and stated, not hidden.
    function testAGenerousAttemptBudgetStillAllowsExactRecovery() public {
        (uint256 lo, uint256 hi, uint256 probes) = _probe(_openProbeGoal(30));

        console.log("probes", probes, "recovered cap", lo);
        assertEq(hi - lo, 1);
        assertEq(lo, SECRET_CAP);
        assertLe(probes, 24);
    }
}
