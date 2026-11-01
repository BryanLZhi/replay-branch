"""Download every format's usage stats from pkmn.github.io/smogon (Smogon's monthly stats) and compact them into stats/.
Random battles have no usage stats; for them the sets the random team generator picks from (pkmn.github.io/randbats)
are compacted the same way, each share being the chance that a set has it.

Usage: python3 source/stats/build_stats.py [cache dir]
"""
import json
import os
import sys
import time
import urllib.request

BASE = "https://pkmn.github.io/smogon/data/stats"
RANDBATS = "https://pkmn.github.io/randbats/data"
RANDOM_FORMATS = ["gen9randombattle", "gen9randomdoublesbattle", "gen9babyrandombattle", "gen8randombattle", "gen8bdsprandombattle",
                  "gen7randombattle", "gen7letsgorandombattle", "gen6randombattle", "gen5randombattle", "gen4randombattle",
                  "gen3randombattle", "gen2randombattle", "gen1randombattle"]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "stats")


def fetch(name, cache, base=BASE):
    path = os.path.join(cache, name)
    if not os.path.exists(path):
        urllib.request.urlretrieve(f"{base}/{name}", path)
        time.sleep(0.2)
    with open(path) as f:
        return json.load(f)


def top(counts, n, min_share):
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    return [[k, round(v, 3)] for k, v in ranked[:n] if v >= min_share and k not in ("Nothing", "")]


def compact(pokemon):
    """{species: {u: usage, a: abilities, i: items, m: moves, t: tera types, s: spreads}}, each a [name, share] list."""
    out = {}
    for species, p in pokemon.items():
        e = {"u": round(p.get("usage", {}).get("weighted", 0), 4)}
        for key, field, n, min_share in (("a", "abilities", 3, .02), ("i", "items", 8, .01), ("m", "moves", 14, .01),
                                         ("t", "teraTypes", 6, .02), ("s", "spreads", 3, 0)):
            if p.get(field):
                e[key] = top(p[field], n, min_share)
        out[species] = e
    return out


def compact_random(sets):
    """The same shape from random battle sets: {species: {level, moves | roles: {role: {moves, items, abilities, teraTypes}}}}."""
    out = {}
    for species, entry in sets.items():
        roles = list(entry.get("roles", {}).values()) or [entry]
        e = {"u": 0}
        for key, field, n in (("a", "abilities", 3), ("i", "items", 8), ("m", "moves", 14), ("t", "teraTypes", 6)):
            share = {}
            for role in roles:
                options = role.get(field) or entry.get(field) or []
                picked = 4 if field == "moves" else 1   # a set has four moves, one of everything else
                for name in options:
                    share[name] = share.get(name, 0) + min(1, picked / len(options)) / len(roles)
            if share:
                e[key] = top(share, n, 0)
        out[species] = e
    return out


def write(formatid, compacted):
    with open(os.path.join(OUT, formatid + ".json"), "w") as f:
        json.dump(compacted, f, separators=(",", ":"))


def main():
    cache = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.cache/replay-branch-stats")
    os.makedirs(cache, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    formats = {}
    for name in sorted(fetch("index.json", cache)):
        try:
            data = fetch(name, cache)
        except Exception as e:  # a missing or broken format file is skipped
            print("skipped", name, e)
            continue
        formatid = name[:-len(".json")]
        write(formatid, compact(data["pokemon"]))
        formats[formatid] = len(data["pokemon"])
    os.makedirs(os.path.join(cache, "randbats"), exist_ok=True)
    for formatid in RANDOM_FORMATS:
        try:
            sets = fetch(formatid + ".json", os.path.join(cache, "randbats"), RANDBATS)
        except Exception as e:
            print("skipped", formatid, e)
            continue
        write(formatid, compact_random(sets))
        formats[formatid] = len(sets)
    with open(os.path.join(OUT, "index.json"), "w") as f:
        json.dump(formats, f, separators=(",", ":"))
    print("formats written:", len(formats))


if __name__ == "__main__":
    main()
