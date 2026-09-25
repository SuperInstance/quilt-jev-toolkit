"""
quilt-jev-toolkit: minimal JEV (TypeSafe) client.

Endpoints:
  GET  /v1/models                       — list models
  POST /v1/systemone                    — ask questions about content

Question types:
  noul   yes/no question.  Returns {type: noul, noul: 0.99}
  choice select from named criteria. Returns {type: choice, choice: name, confidence, probabilities}
  score  rate on ordered criteria.    Returns {type: score, score, confidence, legend, probabilities}

Usage:
    from jev_client import ask, noul, choice, score
    r = ask("...", {"x": noul("...")})
    print(r["answers"]["x"]["noul"])
"""
import json
import os
import urllib.request
import urllib.error


BASE = "https://api.typesafe.ai"


def _hdr():
    return {
        "Authorization": f"Bearer {os.environ['TYPESAFEAI_KEY']}",
        "Content-Type": "application/json",
        "User-Agent": "quilt-jev-toolkit/1.0",
    }


def list_models():
    """Return list of available models and aliases."""
    req = urllib.request.Request(BASE + "/v1/models", headers=_hdr())
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def ask(state, questions, model="jev-latest", timeout=30):
    """Ask one or more questions about state.

    state: any content (string, dict, list).
    questions: dict of {name: question_spec}.

    Returns:
        dict with 'model', 'answers' (dict of name → answer),
        and 'usage' (input/output tokens).
    """
    if not isinstance(questions, dict) or not questions:
        raise ValueError("questions must be a non-empty dict")
    payload = {"state": state, "model": model, "questions": questions}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        BASE + "/v1/systemone", data=data, method="POST", headers=_hdr()
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


# === Question builders ===

def noul(instructions, criteria=None):
    """Yes/no question. Returns {noul: 0.0-1.0}."""
    q = {"type": "noul", "instructions": instructions}
    if criteria:
        q["criteria"] = criteria
    return q


def choice(instructions, criteria):
    """Pick from named criteria. criteria = {name: description}."""
    return {"type": "choice", "instructions": instructions, "criteria": criteria}


def score(instructions, criteria):
    """Rate on ordered criteria. criteria = list of descriptions."""
    return {"type": "score", "instructions": instructions, "criteria": criteria}


# === Convenience runners ===

def canon_gate(text, *, gate_threshold=0.7):
    """Return JEV's verdict on whether text is canon-worthy."""
    r = ask(
        text[:4000],
        {
            "is_canon": noul("Is this canon-worthy? (high doctrinal signal, novel, foundational)"),
            "depth": score(
                "Rate the doctrinal depth",
                ["trivial", "useful", "deep", "frontier"],
            ),
            "domain": choice(
                "Which domain?",
                {
                    "biology": "biological / cellular",
                    "cs": "computer science",
                    "philosophy": "philosophy / metaphysics",
                    "engineering": "engineering practice",
                    "doctrine": "quilt doctrine",
                },
            ),
        },
    )
    canon_p = r["answers"]["is_canon"]["noul"]
    return {
        "canon_p": canon_p,
        "is_canon": canon_p >= gate_threshold,
        "depth": r["answers"]["depth"]["score"],
        "domain": r["answers"]["domain"]["choice"],
        "usage": r["usage"],
    }


if __name__ == "__main__":
    # Test
    if "TYPESAFEAI_KEY" not in os.environ:
        print("Set TYPESAFEAI_KEY env var")
        exit(1)

    print("=== Models ===")
    print(json.dumps(list_models(), indent=2)[:300])

    print("\n=== Test ===")
    r = ask(
        "Quilt cells form communities that grow and die like organisms.",
        {
            "is_canon": noul("Is this canon-worthy?"),
            "depth": score("Rate the doctrinal depth", ["trivial", "useful", "deep", "frontier"]),
        },
    )
    print(json.dumps(r, indent=2))
