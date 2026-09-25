# quilt-jev-toolkit

> Small toolkit for using JEV (TypeSafe) as a Quilt canon oracle.

JEV is a hosted oracle that answers yes/no, multiple choice, and
scored questions about content. It's deterministic (variance < 0.01
across runs), fast (~66ms/call), and robust to adversarial inputs.

This toolkit wraps JEV with a small `noul / choice / score` builder
API and adds utilities for canon-gating Quilt content.

## Quick start

```bash
export TYPESAFEAI_KEY=apikey_...
python3 jev_client.py "the earth is round" '{"x": {"type": "noul", "instructions": "Is this true?"}}'
```

Or in Python:

```python
from jev_client import ask, noul, choice, score

result = ask(
    "Quilt cells form communities that grow and die like organisms.",
    {
        "is_canon": noul("Is this canon-worthy?"),
        "domain": choice("Which domain?", {"biology": "...", "cs": "..."}),
        "depth": score("Rate depth", ["low", "moderate", "high", "extreme"]),
    }
)
print(result["answers"])
```

## Discovery results (Sept 24, 2026)

Rounds run so far:

| Round | Topic | Finding |
|-------|-------|---------|
| 1 | Boundary tests | JEV handles 1-char, 5000-char, unicode; 0.3s per call |
| 2 | Factual sweep | 19/20 = 95% accuracy on basic truths |
| 3 | Myth-busting | 12/12 = 100% on common misconceptions |
| 4 | Cross-model | jev-latest ≈ jev-preview (same answers) |
| 5 | Quilt README canon-gate | QULT.md: is_canon=0.73, is_fractal=0.98 |
| 6 | TLDR_MANY_LANGUAGES | is_polyformal=0.95, languages_count=2.98 |
| 7 | Adversarial | 7/7 on prompt injection / leading questions |
| 8 | Scale | 50 parallel calls in 3.3s (66ms/call) |
| 9 | Determinism | p range 0.980-0.990 over 10 runs |

## Files

- `jev_client.py` — minimal JEV client (noul / choice / score builders)
- `canon_gate.py` — score Quilt content for canon promotion
- `discovery_log.md` — round-by-round findings

## Why JEV is one signal, not the only signal

JEV is fast and well-calibrated, but it's still an LLM oracle. It can
hallucinate (see Round 2 — "humans have 5 senses" returned 0.49,
which is technically right — humans have more than 5 senses — but
the conventional answer is 5).

Use JEV as **one canary** in a multi-signal canon gate:
- JEV score
- Byte-exact polyformality (across 6 substrates)
- Multi-model consensus (JEV + ZAI + DeepSeek agreeing)
- Human review for borderline cases

## Gotchas (re-confirmed)

- `criteria` is required for `score` and `choice` questions (a list
  of strings for score, a dict of {name: description} for choice)
- `noul` questions can have `criteria` (true/false descriptions) but
  it's optional
- JEV returns `usage.input_tokens` and `usage.output_tokens` — use
  them to budget
- The model name in response is `jev-1.13.0` (not the alias
  `jev-latest` you sent)
- For choice questions, `confidence` can be low even when the
  `choice` is clearly correct — check the `probabilities` dict
