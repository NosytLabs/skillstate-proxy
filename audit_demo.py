#!/usr/bin/env python3
"""Long-horizon code audit through a running skillstate-proxy.

Each step sends (spec, current file, compact Σ). The model returns a state_patch.
Prompt size stays ~O(1) because history is not replayed.

Requires a proxy already listening (default http://127.0.0.1:8789).

  SKILLSTATE_PROXY=http://127.0.0.1:8789/v1/chat/completions \\
  SKILLSTATE_MODEL=gpt-4o-mini \\
  python3 audit_demo.py
"""
import json, os, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROXY = os.environ.get("SKILLSTATE_PROXY", "http://127.0.0.1:8789/v1/chat/completions")
COST_URL = os.environ.get("SKILLSTATE_COST", PROXY.replace("/v1/chat/completions", "/cost"))
MODEL = os.environ.get("SKILLSTATE_MODEL", "gpt-4o-mini")
REPO = Path(os.environ.get("SKILLSTATE_AUDIT_DIR", ROOT / "src"))
FILES = sorted(f.name for f in REPO.iterdir() if f.suffix == ".ts")

SPEC = (
    "You are an expert senior code reviewer auditing a TypeScript proxy codebase. "
    "For each file you are shown, identify concrete issues: security flaws, correctness bugs, "
    "dead code, race conditions, token-estimation errors. Be specific with line-level detail. "
    "ALWAYS end your reply with a ```json block that is a state_patch with keys: "
    "file (just audited), issue_count (int), findings (array of strings), files_done (array). "
    "Keep findings concrete and actionable."
)

def call(messages, max_tokens=800):
    body = json.dumps({"model": MODEL, "messages": messages, "max_tokens": max_tokens}).encode()
    req = urllib.request.Request(PROXY, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())

def extract_state_patch(content):
    if "```json" in content:
        block = content.split("```json")[1].split("```")[0].strip()
    elif "{" in content and "state_patch" in content:
        start = content.index("{")
        end = content.rindex("}") + 1
        block = content[start:end]
    else:
        return None
    try:
        return json.loads(block)
    except Exception:
        return None

def main():
    if not FILES:
        print(f"no .ts files in {REPO}", file=sys.stderr)
        sys.exit(1)
    state = {"files_done": [], "findings": [], "total_issues": 0}
    print(f"Auditing {len(FILES)} files via {PROXY} model={MODEL}\n")
    all_findings = {}
    for i, fname in enumerate(FILES):
        path = REPO / fname
        code = path.read_text()
        if len(code) > 6000:
            code = code[:6000] + "\n... [truncated]"
        user_msg = (
            f"[STEP {i}] Auditing file {i+1}/{len(FILES)}: {fname}\n\n"
            f"--- current accumulated state ---\n{json.dumps(state)}\n\n"
            f"--- file content ---\n{code}"
        )
        try:
            resp = call([{"role": "system", "content": SPEC}, {"role": "user", "content": user_msg}])
            content = resp["choices"][0]["message"]["content"]
            usage = resp.get("usage", {})
            patch = extract_state_patch(content)
            if patch:
                state["files_done"].append(patch.get("file", fname))
                state["total_issues"] += int(patch.get("issue_count", 0))
                for finding in patch.get("findings", []):
                    state["findings"].append(finding)
                    all_findings.setdefault(fname, []).append(finding)
            print(
                f"  [{i+1}/{len(FILES)}] {fname}: prompt={usage.get('prompt_tokens')} "
                f"completion={usage.get('completion_tokens')} "
                f"issues_this_file={patch.get('issue_count', '?') if patch else '?'}"
            )
        except Exception as e:
            print(f"  [{i+1}/{len(FILES)}] {fname}: ERROR {e}")
        time.sleep(0.5)

    print("\n=== AUDIT COMPLETE ===")
    print(f"Files audited: {len(state['files_done'])}/{len(FILES)}")
    print(f"Total issues found: {state['total_issues']}")
    print("\n=== FINDINGS BY FILE ===")
    for fname, finds in all_findings.items():
        print(f"\n--- {fname} ---")
        for f in finds:
            print(f"  - {f}")
    try:
        with urllib.request.urlopen(COST_URL, timeout=10) as r:
            cost = json.loads(r.read())
        print("\n=== PROXY COST LEDGER (24h) ===")
        print(json.dumps(cost, indent=2)[:800])
    except Exception as e:
        print(f"\n(cost ledger unavailable: {e})")

if __name__ == "__main__":
    main()
