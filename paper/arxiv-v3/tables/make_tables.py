"""
Regenerates every data table in the paper from the raw records, so no number in a
table is typed by hand.

  python -I paper/arxiv-v3/tables/make_tables.py        (from the repository root)

Reads:
  docs/runs/bench-*.json                 the standard benchmark, one file per run
  docs/runs/baseline-bench-*.json        the matched baselines, one file per run
  docs/runs/bench-enclave-*.json         the standard benchmark with the signer in the enclave
  docs/runs/escrow-enclave-*-adversary.log  the A2 campaign with the signer in the enclave
  docs/runs/escrow-v3-*-adversary.log    the same campaign with a local signer (used if no enclave run)
  paper/eval/leakage/out/*               the leakage evaluation
  paper/eval/results-v2/*.json           the injection study, version 2

Writes LaTeX fragments next to this file, each \\input by main.tex.
"""

from __future__ import annotations

import glob
import json
import re
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
# Sentences for captions and text, written to numbers.tex as macros.
CAPTIONS: dict[str, str] = {}
OUT = Path(__file__).resolve().parent


def q(xs: list[float], p: float) -> float:
    """Percentile by linear interpolation between samples, as in the earlier tables."""
    s = sorted(xs)
    if not s:
        return float("nan")
    k = (len(s) - 1) * p
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def fmt_s(ms: float) -> str:
    return f"{ms / 1000:.2f}"


def grp(n: float) -> str:
    return f"{int(round(n)):,}".replace(",", "{,}")


def write(name: str, body: str) -> None:
    (OUT / name).write_text(body, encoding="utf-8")
    print(f"wrote {name}")


# ------------------------------------------------------------ standard bench


def bench_tables() -> None:
    """The standard benchmark, local signer (vault 0xdd45) beside the enclave signer (vault 0x466a)."""
    local_files = sorted(glob.glob(str(ROOT / "docs" / "runs" / "bench-2026-11-09*.json")))
    local_files += sorted(glob.glob(str(ROOT / "docs" / "runs" / "bench-v3-*.json")))
    all_files = sorted(glob.glob(str(ROOT / "docs" / "runs" / "bench-*.json")))

    def load(files: list[str], prefix: str) -> list[dict]:
        runs = [json.load(open(f)) for f in files]
        return [r for r in runs if str(r.get("vault", "")).lower().startswith(prefix)]

    sets = [("Local signer", load(local_files, "0xdd45")), ("Signer in the enclave", load(all_files, "0x466a"))]
    sets = [(name, runs) for name, runs in sets if runs]
    if not sets:
        print("no v3 bench runs yet", file=sys.stderr)
        write("bench.tex", r"\begin{tabular}{l}\textbf{Pending: the benchmark runs on the current vault have not finished.}\end{tabular}" + "\n")
        CAPTIONS["benchCaption"] = "Pending."
        return
    stages = [
        ("Commit (\\code{requestEscrowSpend})", "agent", "committed"),
        ("Decision available (reveal)", "committed", "revealed"),
        ("Finalize", "revealed", "finalized"),
        ("Sign", "finalized", "signed"),
        ("Fund, capture and receive data", "signed", "settled"),
    ]

    def split(runs: list[dict]) -> tuple[list[dict], list[dict]]:
        recs = [r for run in runs for r in run["records"]]
        paid = [r for r in recs if r["phase"] == "approved" and r["outcome"] == "paid"]
        rej = [r for r in recs if r["phase"] == "rejected" and r["outcome"] in ("rejected", "policy-rejected")]
        return paid, rej

    def cells(xs: list[float]) -> str:
        if not xs:
            return "-- & --"
        return f"{fmt_s(statistics.median(xs))} & {fmt_s(q(xs, 0.1))}--{fmt_s(q(xs, 0.9))}"

    def gcells(xs: list[int]) -> str:
        if not xs:
            return "-- & --"
        return f"{grp(statistics.median(xs))} & {grp(q(xs, 0.1))}--{grp(q(xs, 0.9))}"

    split_sets = [(name, *split(runs)) for name, runs in sets]
    ncol = 1 + 2 * len(split_sets)
    rows = []
    rows.append(
        f"\\multicolumn{{{ncol}}}{{@{{}}l}}{{\\emph{{Approved calls that paid ("
        + ", ".join(f"$n={len(p)}$" for _, p, _ in split_sets)
        + ")}} \\\\"
    )
    for label, a, b in stages:
        rows.append(label + " & " + " & ".join(cells([r["t"][b] - r["t"][a] for r in p if a in r["t"] and b in r["t"]]) for _, p, _ in split_sets) + " \\\\")
    rows.append("End to end & " + " & ".join(cells([r["t"]["done"] - r["t"]["agent"] for r in p]) for _, p, _ in split_sets) + " \\\\")
    rows.append("\\midrule")
    rows.append(
        f"\\multicolumn{{{ncol}}}{{@{{}}l}}{{\\emph{{Rejected calls ("
        + ", ".join(f"$n={len(j)}$" for _, _, j in split_sets)
        + ")}} \\\\"
    )
    for label, a, b in stages[:3]:
        rows.append(label + " & " + " & ".join(cells([r["t"][b] - r["t"][a] for r in j if a in r["t"] and b in r["t"]]) for _, _, j in split_sets) + " \\\\")
    rows.append("End to end & " + " & ".join(cells([r["t"]["done"] - r["t"]["agent"] for r in j]) for _, _, j in split_sets) + " \\\\")
    rows.append("\\midrule")

    def gas(p: list[dict]) -> list[int]:
        return [
            int(r["requestSpendGas"]) + int(r["finalizeGas"]) + int(r.get("holdGas", 0)) + int(r.get("claimGas", 0))
            for r in p
            if r.get("holdGas") and r.get("claimGas")
        ]

    rows.append("Gas per paid call (measured total) & " + " & ".join(gcells(gas(p)) for _, p, _ in split_sets) + " \\\\")
    head = " & ".join(f"\\multicolumn{{2}}{{c}}{{{name}}}" for name, _, _ in split_sets)
    rules = "".join(f"\\cmidrule(l){{{2 + 2 * i}-{3 + 2 * i}}}" for i in range(len(split_sets)))
    sub = " & ".join("Median & P10--P90" for _ in split_sets)
    body = (
        "\\begin{tabular}{@{}l" + "rr" * len(split_sets) + "@{}}\n\\toprule\n"
        + f"& {head} \\\\\n{rules}\nStage (seconds) & {sub} \\\\\n\\midrule\n"
        + "\n".join(rows)
        + "\n\\bottomrule\n\\end{tabular}\n"
    )
    write("bench.tex", body)
    parts = []
    for name, runs in sets:
        outcomes: dict[str, int] = {}
        for run in runs:
            for r in run["records"]:
                key = f"{r['phase']}: {r['outcome']}"
                outcomes[key] = outcomes.get(key, 0) + 1
        outcome_text = "; ".join(f"{k} {v}" for k, v in sorted(outcomes.items()))
        n_runs = f"{len(runs)} runs on separate goals" if len(runs) > 1 else "one run"
        parts.append(f"{name}: {n_runs}, {sum(len(r['records']) for r in runs)} calls, every one reported ({outcome_text})")
    CAPTIONS["benchCaption"] = ". ".join(p[0].upper() + p[1:] for p in parts) + "."


# ---------------------------------------------------------------- baselines


def baseline_table() -> None:
    files = sorted(glob.glob(str(ROOT / "docs" / "runs" / "baseline-bench-*.json")))
    if not files:
        print("no baseline runs yet", file=sys.stderr)
        return
    attempts = []
    for f in files:
        attempts += json.load(open(f))["attempts"]
    names = {"plain": "Plain x402 (no policy)", "plaintext": "Plaintext vault", "confidential": "Confidential vault (this work)"}
    rows = []
    for arm in ["plain", "plaintext", "confidential"]:
        mine = [a for a in attempts if a["arm"] == arm]
        paid = [a for a in mine if a["outcome"] == "paid"]
        failed = sum(a["outcome"] == "failed" for a in mine)
        stalled = sum(a["outcome"] == "stalled" for a in mine)
        ms = [a["totalMs"] for a in paid]
        gas = [sum(int(s.get("gas", 0)) for s in a["stages"]) for a in paid if all(s.get("gas") for s in a["stages"] if s.get("tx"))]
        fee = [sum(int(s.get("feeWei", 0)) for s in a["stages"]) for a in paid if all(s.get("feeWei") for s in a["stages"] if s.get("tx"))]
        txs = statistics.median([sum(1 for s in a["stages"] if s.get("tx")) for a in paid]) if paid else 0
        gas_txt = grp(statistics.median(gas)) if gas else "n/a"
        fee_txt = f"{statistics.median(fee) / 1e9:.2f}" if fee else "n/a"
        rows.append(
            f"{names[arm]} & {len(mine)} & {len(paid)}/{failed}/{stalled} & {fmt_s(statistics.median(ms))} & "
            f"{fmt_s(q(ms, 0.1))}--{fmt_s(q(ms, 0.9))} & {int(txs)} & {gas_txt} & {fee_txt} \\\\"
        )
    body = (
        "\\begin{tabular}{@{}lrrrrrrr@{}}\n\\toprule\n"
        "Design & Calls & Paid/failed/stalled & Median (s) & P10--P90 (s) & Tx & Gas & Fee ($10^{-9}$ ETH) \\\\\n\\midrule\n"
        + "\n".join(rows)
        + "\n\\bottomrule\n\\end{tabular}\n"
    )
    write("baselines.tex", body)
    CAPTIONS["baselinesCaption"] = f"{len(files)} runs of 10 interleaved rounds each."


# ---------------------------------------------------------------- adversary


def adversary_table() -> None:
    # The run with the signer in the enclave is the complete system; the 9 November run
    # on a local signer is used only until it exists.
    logs = sorted(glob.glob(str(ROOT / "docs" / "runs" / "escrow-enclave-*-adversary.log")))
    logs = logs or sorted(glob.glob(str(ROOT / "docs" / "runs" / "escrow-v3-*-adversary.log")))
    if not logs:
        return
    text = open(logs[-1], encoding="utf-8").read()
    blocks = re.split(r"\n(?=\[\s*(?:ok|FAIL|\?\?)\s*\] )", text)
    rows = []
    for b in blocks:
        m = re.match(r"\[\s*(ok|FAIL|\?\?)\s*\] (C\d+b?)\s+(.*)", b)
        if not m:
            continue
        verdict, cid, name = m.group(1), m.group(2), m.group(3).strip()
        observed = (re.search(r"observed: (.*)", b) or [None, ""])[1]
        ev = []
        if re.search(r"tx:\s+(?!open goal|close goal)", b):
            ev.append("tx")
        if "gas estimation" in b:
            ev.append("sim")
        if "signer answers off chain" in b or re.search(r"signer|HTTP 4\d\d|not-ready|refused \(HTTP", observed):
            ev.append("signer")
        if "returned" in observed and "payerGoal" in observed:
            ev.append("read")
        if "no channel" in b or "accepts (goalId, seq) only" in observed:
            ev.append("code")
        # A refusal found at gas estimation is the evidence; the transactions listed
        # with it set up the state under attack. C14's probes are real transactions,
        # and only its last request is a simulated revert.
        if "sim" in ev and cid != "C14":
            ev = [e for e in ev if e != "tx"]
        name = name.replace("_", "\\_").replace("&", "\\&").replace("%", "\\%")
        observed = observed.replace("_", "\\_").replace("&", "\\&").replace("%", "\\%")[:70]
        rows.append((int(cid[1:].rstrip("b")) + (0.5 if cid.endswith("b") else 0), f"{cid} & {name} & {'held' if verdict == 'ok' else 'DEVIATED'} & {', '.join(dict.fromkeys(ev)) or '--'} \\\\"))
    rows.sort()
    body = (
        "\\begin{tabular}{@{}lL{0.58\\linewidth}ll@{}}\n\\toprule\n& Strategy & Outcome & Evidence \\\\\n\\midrule\n"
        + "\n".join(r for _, r in rows)
        + "\n\\bottomrule\n\\end{tabular}\n"
    )
    write("adversary.tex", body)


# ----------------------------------------------------------------- leakage


def leakage_table() -> None:
    path = ROOT / "paper" / "eval" / "leakage" / "out" / "summary.json"
    if not path.exists():
        return
    s = json.load(open(path))
    rows = []
    for r in s["rows"]:
        rows.append(
            f"{r['m']} & "
            + " & ".join(f"{r['bits'][k]:.1f} & {r['V'][k]:.2f} & {r['vendor_fraction'][k]:.2f}" for k in ["uniform", "loguniform", "round"])
            + f" & {r['completion']['q80']:.2f} & {r['completion']['q90']:.2f} \\\\"
        )
    body = (
        "\\begin{tabular}{@{}r rrr rrr rrr rr@{}}\n\\toprule\n"
        "& \\multicolumn{3}{c}{Uniform} & \\multicolumn{3}{c}{Log-uniform} & \\multicolumn{3}{c}{Round numbers} & \\multicolumn{2}{c}{Honest completion} \\\\\n"
        "\\cmidrule(lr){2-4}\\cmidrule(lr){5-7}\\cmidrule(lr){8-10}\\cmidrule(l){11-12}\n"
        "$m$ & bits & $V_m$ & vendor & bits & $V_m$ & vendor & bits & $V_m$ & vendor & $q{=}0.8$ & $q{=}0.9$ \\\\\n\\midrule\n"
        + "\n".join(rows)
        + "\n\\midrule\n"
        + f"no probes & 0 & {s['V0']['uniform']:.3f} & {s['posted_price_fraction']['uniform']:.2f} & 0 & {s['V0']['loguniform']:.2f} & {s['posted_price_fraction']['loguniform']:.2f} & 0 & {s['V0']['round']:.2f} & {s['posted_price_fraction']['round']:.2f} & & \\\\\n"
        + "\\bottomrule\n\\end{tabular}\n"
    )
    write("leakage.tex", body)


# ------------------------------------------------------------ injection, v2


def injection_table() -> None:
    files = sorted(p for p in (ROOT / "paper" / "eval" / "results-v2").glob("*.json") if p.name != "a2.json")
    if not files:
        return
    honest = {"H1", "H2"}
    rows = []
    adaptive_rows = []
    for f in files:
        store = json.loads(f.read_text(encoding="utf-8"))
        model = Path(f).stem.replace("_free", "").split("_", 1)[-1]
        model = model.replace("_", "\\_")
        for arm in ["none", "enforced"]:
            trajs = [v for k, v in store.items() if k.startswith(f"trajectory/{arm}/")]
            if not trajs:
                continue
            losses, missing, answered, done, honest_total, hostile_yes, hostile_total = [], 0, 0, 0, 0, 0, 0
            for t in trajs:
                loss = 0.0
                for st in t["steps"]:
                    if not st["answer"]["ok"]:
                        missing += 1
                        continue
                    answered += 1
                    loss += st["loss"]
                    if st["offer"] in honest:
                        honest_total += 1
                        done += 1 if st.get("honestDone") else 0
                    else:
                        hostile_total += 1
                        hostile_yes += 1 if st["answer"]["proposal"]["pay"] else 0
                if len(t["steps"]) == 10 and all(s["answer"]["ok"] for s in t["steps"]):
                    losses.append(loss)
            label = "Own wallet" if arm == "none" else "Enforced"
            mean_loss = f"{statistics.mean(losses):.2f}" if losses else "--"
            max_loss = f"{max(losses):.2f}" if losses else "--"
            rows.append(
                f"{model} & {label} & {len(trajs)}/5 & {len(losses)} & {answered}/{missing} & {hostile_yes}/{hostile_total} & {done}/{honest_total} & "
                f"{mean_loss} & {max_loss} \\\\"
            )
        for limits in ["plaintext", "confidential"]:
            runs = [v for k, v in store.items() if k.startswith(f"adaptive/{limits}/")]
            if not runs:
                continue
            rev = [r["revenue"] for r in runs if all(x["answer"]["ok"] for x in r["rounds"])]
            asks = sum(len(r["rounds"]) for r in runs)
            miss = sum(1 for r in runs for x in r["rounds"] if not x["answer"]["ok"])
            mean_rev = f"{statistics.mean(rev):.3f}" if rev else "--"
            max_rev = f"{max(rev):.3f}" if rev else "--"
            adaptive_rows.append(f"{model} & {limits} & {len(runs)}/5 & {len(rev)} & {asks}/{miss} & {mean_rev} & {max_rev} \\\\")
    body = (
        "\\begin{tabular}{@{}llrrrrrrr@{}}\n\\toprule\n"
        "Model & Enforcement & Runs & Complete & Answers/missing & Hostile yes & Honest bought & Mean loss & Max loss \\\\\n\\midrule\n"
        + "\n".join(rows)
        + "\n\\bottomrule\n\\end{tabular}\n"
    )
    write("injection.tex", body)
    if adaptive_rows:
        write(
            "adaptive.tex",
            "\\begin{tabular}{@{}llrrrrr@{}}\n\\toprule\nModel & Limits & Runs & Complete & Quotes/missing & Mean revenue & Max revenue \\\\\n\\midrule\n"
            + "\n".join(adaptive_rows)
            + "\n\\bottomrule\n\\end{tabular}\n",
        )


if __name__ == "__main__":
    bench_tables()
    baseline_table()
    adversary_table()
    leakage_table()
    injection_table()


# ------------------------------------------------------------- prose numbers


def numbers() -> None:
    """Macros for numbers quoted in the text, from the same records as the tables."""
    out: dict[str, str] = {}
    files = sorted(glob.glob(str(ROOT / "docs" / "runs" / "baseline-bench-*.json")))
    if files:
        attempts = [a for f in files for a in json.load(open(f))["attempts"]]
        for arm, key in [("plain", "Plain"), ("plaintext", "Plaintext"), ("confidential", "Confidential")]:
            paid = [a for a in attempts if a["arm"] == arm and a["outcome"] == "paid"]
            out[f"base{key}Median"] = f"{statistics.median([a['totalMs'] for a in paid]) / 1000:.1f}"
            out[f"base{key}Calls"] = str(len([a for a in attempts if a["arm"] == arm]))
        fund = []
        for a in attempts:
            if a["arm"] != "confidential" or a["outcome"] != "paid":
                continue
            t = 0
            for s in a["stages"]:
                t += s["ms"]
                if s["name"].startswith("authorize"):
                    break
            fund.append(t)
        out["fundingmedian"] = f"{statistics.median(fund) / 1000:.1f}"
        out["fundingmax"] = f"{max(fund) / 1000:.1f}"
        out["fundingn"] = str(len(fund))
        out["baseRuns"] = str(len(files))
    out["fundingcheck"] = "30"
    out.update(CAPTIONS)
    body = "".join("\\newcommand{\\" + k + "}{" + v + "}\n" for k, v in sorted(out.items()))
    write("numbers.tex", body)


numbers()
