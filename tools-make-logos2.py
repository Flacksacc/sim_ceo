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
    "Minimalist logo mark, royal crown merged with a speech bubble, leadership voice theme, deep navy and gold flat vector, no text, no letters",
    "Minimalist logo mark, open book with rising sun above pages, knowledge and decisions theme, deep navy and amber flat vector, no text, no letters",
    "Geometric fox head, clever counsel theme, deep navy with single gold ear accent, flat minimal logo mark, no text, no letters",
    "Circular labyrinth path leading to a center dot, guidance through complexity theme, navy line art with gold center, minimal logo, no text, no letters",
    "Abstract partnership knot of two interlaced bands forming a circle, trust theme, navy and gold flat logo mark, no text, no letters",
    "Stylized tree with symmetric roots and branches inside a circle, growth and grounding theme, deep navy and gold flat logo, no text, no letters",
    "Minimalist vintage microphone on a small podium, board voice theme, navy silhouette with gold grille lines, flat logo mark, no text, no letters",
    "Nautilus spiral shell, wisdom and depth theme, gold spiral on deep navy, minimal geometric logo mark, no text, no letters",
    "Abstract bridge arch over calm water, connecting decisions theme, navy arch with gold reflection line, flat minimal logo, no text, no letters",
    "Single continuous ribbon line forming the letter S, elegant flow theme, gold ribbon on deep navy, premium minimal logo, the S shape only, no other letters",
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
    p = os.path.join(outdir, "simceo-logob-%02d.png" % i)
    open(p, "wb").write(base64.b64decode(img))
    print("saved " + p)
