import json, os, sys, urllib.request, urllib.error, base64
root = r"C:\Users\War\scrach\sim_ceo"
key = ""
with open(os.path.join(root, ".env"), encoding="utf-8") as f:
    for line in f:
        if line.startswith("META_API_KEY="):
            key = line.strip().split("=", 1)[1]
            break
if not key:
    print("NO_KEY"); sys.exit(2)
prompts = [
    "Minimalist logo mark, circular deep navy badge with abstract round boardroom table and seat ring, thin gold line accents, flat vector style, no text, no letters",
    "Elegant monogram logo, serif letters S and C intertwined, gold on deep navy background, luxury advisory brand mark, letters S C only, no other text",
    "Abstract compass rose merged with a speech bubble, deep navy and amber, minimal tech logo mark, flat vector, no text, no letters",
    "Geometric owl head outline, wisdom and counsel theme, deep navy with gold eyes, flat minimal logo mark, no text, no letters",
    "Three overlapping dialogue bubbles forming an S curve, navy gold and white, advisory board logo mark, flat vector, no text, no letters",
    "Lighthouse beam over calm waves inside a circle, guidance theme, deep navy and amber flat logo mark, no text, no letters",
    "Abstract chess knight built from geometric shapes, strategy theme, deep navy with one gold mane line, minimal logo mark, no text, no letters",
    "Three interlocking rings in navy gold and slate, unity and counsel theme, minimal logo mark, flat vector, no text, no letters",
    "Mountain summit with small flag inside a rounded square, achievement theme, deep navy and amber flat logo mark, no text, no letters",
    "Art deco sunburst over a boardroom table seen from above, gold rays on deep navy, premium emblem logo, no text, no letters",
]
picks = sys.argv[1:]
idxs = [int(x) for x in picks] if picks else list(range(1, len(prompts) + 1))
outdir = os.path.join(root, "output", "imagegen")
os.makedirs(outdir, exist_ok=True)
url = "https://api.meta.ai/v1/images/generations"
for i in idxs:
    body = json.dumps({"model": "muse-image-1.0", "prompt": prompts[i - 1], "n": 1, "response_format": "b64_json"}).encode()
    req = urllib.request.Request(url, data=body, headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, method="POST")
    try:
        data = json.load(urllib.request.urlopen(req, timeout=300))
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read()[:400]); sys.exit(3)
    img = data["data"][0]["b64_json"]
    p = os.path.join(outdir, "simceo-logo-%02d.png" % i)
    open(p, "wb").write(base64.b64decode(img))
    print("saved " + p)
