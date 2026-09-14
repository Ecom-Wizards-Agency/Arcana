"""Resolve tokens.css into Figma-ready variables.

Figma stores resolved RGBA and has no color-mix(), so semantic tokens must be
evaluated rather than transcribed. The mix maths mirrors the mix() helper in
apps/web/src/ui/design-system.test.ts, which is the reference implementation.
"""
import re, json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

CSS = (ROOT / "packages/ui/src/tokens.css").read_text()

def block(start_pat, stop_at):
    i = CSS.index(start_pat) + len(start_pat)
    return CSS[i:CSS.index("\n}", i)]

light = block(":root {", None)
dark  = block(":root[data-theme='dark'] {", None)

DECL = re.compile(r"(--wa-[\w-]+)\s*:\s*([^;]+);")

def decls(txt):
    out = {}
    for m in DECL.finditer(txt):
        out[m.group(1)] = " ".join(m.group(2).split())
    return out

L, D = decls(light), decls(dark)

def hex_rgb(h):
    h = h.lstrip("#")
    if len(h) == 3: h = "".join(c*2 for c in h)
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

VAR = re.compile(r"^var\(\s*(--wa-[\w-]+)\s*\)$")

def resolve(name, scope, seen=None):
    """-> (r,g,b,a) 0-255 floats, or None when the value is not a colour."""
    seen = seen or set()
    if name in seen: return None
    seen = seen | {name}
    raw = scope.get(name) or L.get(name)
    if raw is None: return None
    return resolve_value(raw, scope, seen)

def resolve_value(raw, scope, seen):
    raw = raw.strip()
    if raw.startswith("#"):
        r, g, b = hex_rgb(raw); return (r, g, b, 1.0)
    if raw == "transparent": return (0, 0, 0, 0.0)
    m = VAR.match(raw)
    if m: return resolve(m.group(1), scope, seen)
    if raw.startswith("color-mix(") and raw.endswith(")"):
        parts, start, depth = [], 0, 0
        inner = raw[len("color-mix("):-1]
        for i, char in enumerate(inner):
            if char == "(": depth += 1
            elif char == ")": depth -= 1
            elif char == "," and depth == 0:
                parts.append(inner[start:i].strip())
                start = i + 1
        parts.append(inner[start:].strip())
        if len(parts) != 3 or parts[0] != "in srgb": return None
        weighted = re.fullmatch(r"(.+)\s+([\d.]+)%", parts[1])
        if weighted is None: return None
        a = resolve_value(weighted.group(1), scope, seen)
        pct = float(weighted.group(2)) / 100.0
        b = resolve_value(parts[2], scope, seen)
        if a is None or b is None: return None
        # transparent contributes alpha 0 but no colour: premultiply on alpha.
        ar, ag, ab, aa = a; br, bg, bb, ba = b
        alpha = aa*pct + ba*(1-pct)
        if alpha == 0: return (0, 0, 0, 0)
        return ((ar*aa*pct + br*ba*(1-pct))/alpha,
                (ag*aa*pct + bg*ba*(1-pct))/alpha,
                (ab*aa*pct + bb*ba*(1-pct))/alpha, alpha)
    return None

def export_tokens():
    names = sorted(set(L) | set(D))
    out, skipped = {}, []
    for n in names:
        lv, dv = resolve(n, L), resolve(n, D)
        if lv is None and dv is None:
            skipped.append(n); continue
        out[n] = {
            "light": [round(c/255, 6) for c in lv[:3]] + [round(lv[3], 4)] if lv else None,
            "dark":  [round(c/255, 6) for c in dv[:3]] + [round(dv[3], 4)] if dv else None,
        }
    
    return {"colors": out, "nonColor": skipped}

if __name__ == "__main__":
    result = export_tokens()
    (ROOT / "tools/figma-tokens/tokens.figma.json").write_text(json.dumps(result, indent=1) + "\n")
    print(len(result["colors"]), "colors;", len(result["nonColor"]), "non-color tokens")
