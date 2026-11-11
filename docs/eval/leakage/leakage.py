"""
Leakage of the encrypted per-call cap through the decision channel, as the
attempt budget m varies.

The model is the paper's: every request is a public amount and a public yes/no
decision, so each attempt answers "amount <= cap?" (with the budget not binding).
An adaptive adversary chooses the amounts. Nothing here touches a chain; it
evaluates the bound on realistic cap distributions.

Outputs (CSV, read by pgfplots, and a JSON summary) go to ./out.

  python -I leakage.py

Four quantities:

1. Guessing success V_m: the probability that the adversary names the cap
   exactly after m answers, maximised over adaptive strategies. With threshold
   questions over a sorted support, any partition of the support into at most
   2^m contiguous intervals is reachable by a depth-m tree, and the best one puts
   each of the 2^m most likely values in its own interval, so V_m is the sum of
   the 2^m largest prior probabilities (capped at 1). Min-entropy leakage is
   log2(V_m / V_0) <= m.

2. A hostile vendor's revenue per sale, after k probing attempts, as a fraction
   of what it would get with a plaintext cap (where it prices at the cap). The
   vendor learns an interval [a, b] containing the cap and prices at a. Computed
   by dynamic programming over intervals: F_k(l, r) = max_t F_{k-1}(l, t-1) +
   F_{k-1}(t, r), F_0(l, r) = v_l * P(l..r).

3. The single posted price with no probing, max_p p * P(cap >= p), for reference.

4. An honest agent's chance of completing n purchases within m attempts when
   each honest request is approved with probability q (the market price is under
   the cap): P(Binomial(m, q) >= n).
"""

from __future__ import annotations

import csv
import json
import math
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent / "out"
OUT.mkdir(exist_ok=True)

# --------------------------------------------------------------- priors (in cents)

CENTS = np.arange(1, 1001)  # 0.01 .. 10.00 USDC, the console's range for one call


def uniform() -> np.ndarray:
    return np.full(CENTS.size, 1.0 / CENTS.size)


def log_uniform() -> np.ndarray:
    w = 1.0 / CENTS
    return w / w.sum()


ROUND_VALUES = [5, 10, 20, 25, 50, 75, 100, 150, 200, 250, 300, 500, 1000]


def round_numbers(mass_on_round: float = 0.7) -> np.ndarray:
    """People choose round caps. 70% on thirteen round values, the rest log-uniform."""
    p = log_uniform() * (1.0 - mass_on_round)
    for v in ROUND_VALUES:
        p[v - 1] += mass_on_round / len(ROUND_VALUES)
    return p / p.sum()


PRIORS = {"uniform": uniform(), "loguniform": log_uniform(), "round": round_numbers()}

# -------------------------------------------------------------- 1. guessing success


def vulnerability(p: np.ndarray, m: int) -> float:
    k = min(2**m, p.size)
    return float(np.sort(p)[::-1][:k].sum())


def leakage_bits(p: np.ndarray, m: int) -> float:
    return math.log2(vulnerability(p, m) / vulnerability(p, 0))


# ------------------------------------------------------------ 2. vendor revenue


def vendor_revenue(p: np.ndarray, values: np.ndarray, kmax: int) -> list[float]:
    """E[a] after k optimal threshold probes, for k = 0..kmax. a = lower end of the
    interval known to hold the cap; the vendor knows the prior's support."""
    n = values.size
    cum = np.concatenate([[0.0], np.cumsum(p)])
    mass = lambda l, r: cum[r + 1] - cum[l]  # noqa: E731
    F = np.zeros((n, n))
    for l in range(n):
        for r in range(l, n):
            F[l, r] = values[l] * mass(l, r)
    results = [F[0, n - 1]]
    for _ in range(kmax):
        G = F.copy()
        for l in range(n):
            for r in range(l + 1, n):
                # split before t: left [l, t-1], right [t, r]
                left = F[l, l:r]  # F[l, t-1] for t = l+1..r
                right = F[l + 1 : r + 1, r]  # F[t, r] for t = l+1..r
                G[l, r] = max(F[l, r], float((left + right).max()))
        F = G
        results.append(F[0, n - 1])
    return results


def posted_price(p: np.ndarray, values: np.ndarray) -> float:
    survival = np.cumsum(p[::-1])[::-1]  # P(cap >= v_i)
    return float((values * survival).max())


# --------------------------------------------------------- 4. honest completion


def completion(m: int, n: int, q: float) -> float:
    if m < n:
        return 0.0
    return float(sum(math.comb(m, i) * q**i * (1 - q) ** (m - i) for i in range(n, m + 1)))


# ----------------------------------------------------------------------- run


def main() -> None:
    ms = list(range(0, 21))
    with open(OUT / "vulnerability.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["m"] + [f"V_{k}" for k in PRIORS] + [f"bits_{k}" for k in PRIORS])
        for m in ms:
            w.writerow(
                [m]
                + [f"{vulnerability(p, m):.6f}" for p in PRIORS.values()]
                + [f"{leakage_bits(p, m):.4f}" for p in PRIORS.values()]
            )

    # Revenue on a 5-cent grid (200 values), which keeps the interval DP quick.
    grid = np.arange(5, 1001, 5)
    kmax = 12
    revenue = {}
    for name, p in PRIORS.items():
        coarse = np.array([p[(v - 5) : v].sum() for v in grid])
        coarse /= coarse.sum()
        mean_cap = float((grid * coarse).sum())
        r = vendor_revenue(coarse, grid.astype(float), kmax)
        revenue[name] = {
            "mean_cap_cents": mean_cap,
            "fraction": [x / mean_cap for x in r],
            "posted_fraction": posted_price(coarse, grid.astype(float)) / mean_cap,
        }
    with open(OUT / "vendor.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["k"] + [f"frac_{k}" for k in PRIORS] + [f"posted_{k}" for k in PRIORS])
        for k in range(kmax + 1):
            w.writerow(
                [k]
                + [f"{revenue[n]['fraction'][k]:.4f}" for n in PRIORS]
                + [f"{revenue[n]['posted_fraction']:.4f}" for n in PRIORS]
            )

    n_calls = 5
    qs = [0.7, 0.8, 0.9, 0.95]
    with open(OUT / "completion.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["m"] + [f"q{int(q*100)}" for q in qs])
        for m in ms:
            w.writerow([m] + [f"{completion(m, n_calls, q):.4f}" for q in qs])

    # The summary the paper's table reads: m chosen around n = 5 calls.
    rows = []
    for m in [5, 7, 10, 15, 20]:
        rows.append(
            {
                "m": m,
                "bits": {k: round(leakage_bits(p, m), 2) for k, p in PRIORS.items()},
                "V": {k: round(vulnerability(p, m), 4) for k, p in PRIORS.items()},
                "vendor_fraction": {
                    k: round(revenue[k]["fraction"][min(m, kmax)], 3) for k in PRIORS
                },
                "completion": {f"q{int(q*100)}": round(completion(m, n_calls, q), 3) for q in qs},
            }
        )
    summary = {
        "support": "caps of 0.01 to 10.00 USDC in cents (1000 values); vendor DP on a 5-cent grid",
        "n_calls": n_calls,
        "posted_price_fraction": {k: round(revenue[k]["posted_fraction"], 3) for k in PRIORS},
        "V0": {k: round(vulnerability(p, 0), 5) for k, p in PRIORS.items()},
        "rows": rows,
    }
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
