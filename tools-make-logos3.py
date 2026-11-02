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
    "Chunky flat vector logo, blocky geometric CEO torso in navy suit and gold tie with arms crossed, confident minimal face, logo mark, no text, no letters",
    "Three dimensional voxel character of a blocky CEO crossing arms, navy suit, plain light background, isometric game figurine style, no text, no letters",
    "Pixel art portrait, 16-bit style CEO with crossed arms, navy suit and gold tie, plain background, no text, no letters",
    "Bold Bauhaus geometric CEO bust with crossed arms built from circles rectangles and triangles, navy amber and cream, no text, no letters",
    "Minimalist blocky line art CEO with thick strokes and crossed arms, deep navy on cream background, no text, no letters",
    "Toy brick figurine photo of a CEO crossing arms in navy suit, tiny plastic toy style, studio lighting, plain background, no text, no letters",
    "Origami folded paper CEO with crossed arms, navy and gold paper craft, minimal geometric logo mark, no text, no letters",
    "Blocky CEO silhouette emblem with crossed arms inside a circle badge, gold on deep navy, flat vector logo mark, no text, no letters",
    "Retro 8-bit arcade boss portrait, blocky CEO crossing arms in navy suit, dark background with gold accents, no text, no letters",
    "Abstract stacked blocks totem forming a CEO torso with crossed arms, navy gold and slate cubes, minimal geometric logo, no text, no letters",
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
    p = os.path.join(outdir, "simceo-logoc-%02d.png" % i)
    open(p, "wb").write(base64.b64decode(img))
    print("saved " + p)
