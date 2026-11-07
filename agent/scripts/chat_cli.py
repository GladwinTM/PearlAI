"""Talk to the running agent over /api/chat from the terminal (multi-turn, shows tool calls + timings).

uv run python scripts/chat_cli.py "turn one" "turn two" ...      # scripted
uv run python scripts/chat_cli.py --persona ravi                  # interactive
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import httpx

AGENT = os.environ.get("AGENT_URL", "http://localhost:8000")


def turn(client: httpx.Client, message: str, conversation_id: str | None, persona: str | None) -> str | None:
    print(f"\n\033[1myou:\033[0m {message}")
    body = {"message": message, "conversation_id": conversation_id, "persona": persona}
    event = None
    with client.stream("POST", f"{AGENT}/api/chat", json=body, timeout=300) as r:
        r.raise_for_status()
        sys.stdout.write("\033[1mpearl:\033[0m ")
        for line in r.iter_lines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                d = json.loads(line[6:])
                if event == "conversation":
                    conversation_id = d["conversation_id"]
                elif event == "token":
                    sys.stdout.write(d["text"])
                elif event == "safety":
                    print(f"\n  \033[31m[safety] {', '.join(d['rules'])}\033[0m")
                elif event == "tool_call":
                    auto = " (auto)" if d.get("auto") else ""
                    print(f"\n  \033[36m→ {d['name']}{auto}({json.dumps(d['args'])})\033[0m")
                elif event == "tool_result":
                    print(f"  \033[90m← {d['ms']} ms {json.dumps(d['result'])[:300]}\033[0m")
                elif event == "error":
                    print(f"\n  \033[31m[error] {d['message']}\033[0m")
                elif event == "done":
                    t = d.get("timings") or {}
                    print(
                        f"\n  \033[90m[done] outcome={d.get('outcome')} total={t.get('total_ms')}ms "
                        f"ttft={t.get('ttft_ms')}ms llm={t.get('llm_ms')}ms tools={t.get('tools_ms')}ms rounds={t.get('rounds')}\033[0m"
                    )
                sys.stdout.flush()
    return conversation_id


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("turns", nargs="*")
    ap.add_argument("--persona")
    ap.add_argument("--reset", action="store_true", help="POST /api/demo/reset first")
    a = ap.parse_args()
    with httpx.Client() as client:
        if a.reset:
            client.post(f"{AGENT}/api/demo/reset").raise_for_status()
        cid = None
        if a.turns:
            for t in a.turns:
                cid = turn(client, t, cid, a.persona)
        else:
            while True:
                try:
                    msg = input("\n> ").strip()
                except (EOFError, KeyboardInterrupt):
                    break
                if msg:
                    cid = turn(client, msg, cid, a.persona)
        print(f"\nconversation_id={cid}")


if __name__ == "__main__":
    main()
