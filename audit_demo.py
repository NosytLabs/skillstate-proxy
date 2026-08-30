#!/usr/bin/env python3
"""Long-horizon code audit through skillstate-proxy + gonka/deepseek.

Each step: send (P, current_file_content, Σ_state) -> model outputs state_patch -> merge.
Demonstrates SKILL.state bounded-prompt behaviour: 10 files audited, state accumulates,
prompt stays ~O(1) because we only send the current file + compact state, not full history.
"""
import json, os, urllib.request, sys, time

PROXY = "http://127.0.0.1:8791/v1/chat/completions"
MODEL = "deepseek-ai/DeepSeek-V4-Flash-0731"
REPO = "/Users/tyson/Desktop/Code/ai/skillstate-proxy/src"
FILES = sorted(f for f in os.listdir(REPO) if f.endswith(".ts"))

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
    # tolerate truncated output / reasoning prefix before the json block
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
    state = {"files_done": [], "findings": [], "total_issues": 0}
    print(f"Auditing {len(FILES)} files via skillstate-proxy -> gonka/deepseek\n")
    all_findings = {}
    for i, fname in enumerate(FILES):
        path = os.path.join(REPO, fname)
        with open(path) as f:
            code = f.read()
        # truncate huge files to keep the demo visible
        if len(code) > 6000:
            code = code[:6000] + "\n... [truncated]"
        user_msg = (
            f"[STEP {i}] Auditing file {i+1}/{len(FILES)}: {fname}\n\n"
            f"--- current accumulated state ---\n{json.dumps(state)}\n\n"
            f"--- file content ---\n{code}"
        )
        try:
            resp = call([{"role":"system","content":SPEC},{"role":"user","content":user_msg}])
            content = resp["choices"][0]["message"]["content"]
            usage = resp.get("usage", {})
            patch = extract_state_patch(content)
            if patch:
                state["files_done"].append(patch.get("file", fname))
                state["total_issues"] += int(patch.get("issue_count", 0))
                for f in patch.get("findings", []):
                    state["findings"].append(f)
                    all_findings.setdefault(fname, []).append(f)
            print(f"  [{i+1}/{len(FILES)}] {fname}: prompt={usage.get('prompt_tokens')} "
                  f"completion={usage.get('completion_tokens')} issues_this_file={patch.get('issue_count','?') if patch else '?'}")
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
    # total tokens from proxy cost
    try:
        with urllib.request.urlopen("http://127.0.0.1:8791/cost", timeout=10) as r:
            cost = json.loads(r.read())
        print(f"\n=== PROXY COST LEDGER (24h) ===")
        print(json.dumps(cost, indent=2)[:800])
    except Exception as e:
        print(f"\n(cost ledger unavailable: {e})")

if __name__ == "__main__":
    main()
