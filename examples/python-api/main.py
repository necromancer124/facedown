"""Lists your GitHub repositories. The token comes from the environment, put
there by facedown; this program never knows it came from a vault.

    facedown run --keys GITHUB_TOKEN -- python main.py

Uses only the standard library. With requests it is the same idea:
    requests.get(url, headers={"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}"})
"""

import json
import os
import sys
import urllib.error
import urllib.request

token = os.environ.get("GITHUB_TOKEN")
if not token:
    sys.exit("GITHUB_TOKEN is not set. Run me with: facedown run --keys GITHUB_TOKEN -- python main.py")

# Printing a secret by accident is harmless under facedown: the output shows
# ***GITHUB_TOKEN*** instead. (Shown here on purpose, so you can see it.)
print(f"[debug] using token {token}", flush=True)

request = urllib.request.Request(
    "https://api.github.com/user/repos?per_page=10&sort=updated",
    headers={
        "Authorization": f"Bearer {token}",
        "User-Agent": "facedown-example",
        "Accept": "application/vnd.github+json",
    },
)
try:
    with urllib.request.urlopen(request, timeout=20) as response:
        repos = json.load(response)
except urllib.error.HTTPError as err:
    sys.exit(f"GitHub said {err.code}: {json.load(err).get('message')}")

for repo in repos:
    print(f"{'private' if repo['private'] else 'public '}  {repo['full_name']}")
