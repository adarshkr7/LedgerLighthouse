"""
Mutation test of the accounting invariants (test/AccountingInvariants.t.sol).

Each mutant removes or weakens one check in the vault. The invariant suite runs
offline from the escrow fixture against each, and must fail. The source is restored
after every mutant, whatever happens.

  python -I mutate-accounting.py            # from contracts/
"""

import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ESCROW = HERE / "src" / "EscrowPolicyVault.sol"
POLICY = HERE / "src" / "PolicyVault.sol"

MUTANTS = [
    ("authorize: no reclaimed check", ESCROW, "        require(!record.reclaimed, AlreadyReclaimed());\n        // Closing a goal", "        // Closing a goal"),
    ("authorize: no open-goal check", ESCROW, "        require(goals[goalId].open, GoalNotOpen());\n        // All or nothing", "        // All or nothing"),
    ("authorize: no approval check", ESCROW, "        require(record.finalized && record.approved, NotApproved());\n        require(!record.reclaimed, AlreadyReclaimed());\n        // Closing", "        require(!record.reclaimed, AlreadyReclaimed());\n        // Closing"),
    ("reclaim: credits a captured payment", ESCROW, "        require(captured == 0, AuthorizationUsed());\n\n        if (!collected)", "\n        if (!collected)"),
    ("reclaim: uncollected before the window closes", ESCROW, "            require(block.timestamp >= info.preApprovalExpiry, AuthorizationLive());\n", ""),
    ("reclaim: held before the capture deadline", ESCROW, "            require(block.timestamp >= info.authorizationExpiry, AuthorizationLive());\n", ""),
    ("reclaim: twice", ESCROW, "        require(!record.reclaimed, AlreadyReclaimed());\n\n        IAuthCaptureEscrow.PaymentInfo memory info = escrowPayment(goalId, seq);\n        (bool collected", "\n        IAuthCaptureEscrow.PaymentInfo memory info = escrowPayment(goalId, seq);\n        (bool collected"),
    ("credit: call not restored", POLICY, "        goal.callsRemaining += 1;\n        // The attempt", "        // The attempt"),
    ("credit: flag not set", POLICY, "        record.reclaimed = true;\n\n        euint256 restored", "\n        euint256 restored"),
    ("finalize: call spent on rejection too", POLICY, "        if (approved) {\n            goal.callsRemaining -= 1;\n        }", "        goal.callsRemaining -= 1;"),
    ("request: attempt not spent", POLICY, "        attemptsRemaining[goalId] -= 1;\n", ""),
    ("debit: the whole amount whatever the decision", POLICY, "ok.select(amount.asEuint256(), uint256(0).asEuint256())", "ok.select(amount.asEuint256(), amount.asEuint256())"),
    ("decision: cap not compared", POLICY, "_remainingBudget[goalId].ge(amount).and(_perCallCap[goalId].ge(amount))", "_remainingBudget[goalId].ge(amount)"),
    ("sweep: allowed on an open goal", ESCROW, "        require(!goal.open, GoalStillOpen());\n", ""),
]


def run_suite() -> tuple[bool, str]:
    env = {k: v for k, v in os.environ.items() if k != "ESCROW_FORK_RPC"}
    env["FOUNDRY_INVARIANT_RUNS"] = "64"
    env["FOUNDRY_INVARIANT_DEPTH"] = "128"
    out = subprocess.run(
        ["forge", "test", "--match-contract", "^AccountingInvariantsTest$"],
        cwd=HERE, env=env, capture_output=True, text=True,
    )
    text = out.stdout + out.stderr
    if "Compiler run failed" in text or "Error (" in text:
        return False, "did not compile"
    return "[PASS]" in text and "[FAIL" not in text, next((l for l in text.splitlines() if "FAIL" in l or "assertion" in l.lower()), "")[:160]


def main() -> int:
    results = []
    for name, path, old, new in MUTANTS:
        source = path.read_text(encoding="utf-8")
        if source.count(old) != 1:
            results.append({"mutant": name, "result": "NOT APPLIED (pattern not unique)"})
            print(f"{name:50s} NOT APPLIED")
            continue
        try:
            path.write_text(source.replace(old, new), encoding="utf-8", newline="\n")
            passed, line = run_suite()
        finally:
            path.write_text(source, encoding="utf-8", newline="\n")
        verdict = "survived" if passed else ("killed" if line != "did not compile" else "did not compile")
        results.append({"mutant": name, "result": verdict, "detail": line})
        print(f"{name:50s} {verdict}  {line}")
    (HERE / "invariant-out").mkdir(exist_ok=True)
    (HERE / "invariant-out" / "mutants.json").write_text(json.dumps(results, indent=2))
    return 1 if any(r["result"] != "killed" for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
