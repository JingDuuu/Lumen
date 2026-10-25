"""Read + preview a synthetic edit; only --apply persists it. Never generates."""
import argparse
import json
from pathlib import Path
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import lumen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()
current = lumen.request_json("/api/agent/board")
identifier = "agent-note-" + uuid.uuid4().hex[:8]
transaction = {"expected_revision":current["revision"],"request_id":str(uuid.uuid4()),"operations":[
    {"op":"add_item","value":{"id":identifier,"kind":"text","role":"style","content":"Soft evening light on a fictional coastal scene.","x":800,"y":40,"w":320,"h":220}}
]}
preview = lumen.request_json("/api/agent/preview", "POST", transaction, timeout=120)
print(json.dumps(preview, ensure_ascii=False, indent=2))
if args.apply:
    result = lumen.request_json("/api/agent/board/operations", "POST", transaction)
    print(json.dumps(result, ensure_ascii=False, indent=2))
