#!/usr/bin/env python3
"""Analyse a FetchFido CSV export -- the range test's actual deliverable.

The question this exists to answer (docs/DESIGN.md section 11): at collar
height, in real terrain, at what distance does packet delivery fall below
usable? Maximum range is the wrong metric; the delivery curve is the right one.

Standard library only, in keeping with the project's no-dependency stance.

Usage:
    tools/analyze-session.py export.csv
    tools/analyze-session.py export.csv --from 33.55178,-101.90178
    tools/analyze-session.py export.csv --gateway '!9ea0eaac'
"""

import argparse
import csv
import math
import statistics as st
import sys
from datetime import datetime, timezone

EARTH_R = 6371000.0


def haversine(lat1, lon1, lat2, lon2):
    p = math.radians
    dlat, dlon = p(lat2 - lat1), p(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(p(lat1)) * math.cos(p(lat2)) * math.sin(dlon / 2) ** 2)
    return 2 * EARTH_R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def load(path, include_nodedb):
    rows, skipped = [], 0
    with open(path, newline="") as fh:
        for r in csv.DictReader(fh):
            if not r.get("lat") or not r.get("lon"):
                continue
            # Node-database entries are the radio's last-known values, not
            # packets heard over the air. They have no RSSI and were never
            # received, so counting them as deliveries inflates the result.
            if r.get("link") == "nodedb" and not include_nodedb:
                skipped += 1
                continue
            rows.append({
                "id": r["device_id"],
                "ts": parse_ts(r["timestamp_utc"]),
                "lat": float(r["lat"]),
                "lon": float(r["lon"]),
                "rssi": int(r["rssi_dbm"]) if r.get("rssi_dbm") else None,
                "snr": float(r["snr_db"]) if r.get("snr_db") else None,
                "hops": int(r["hops"]) if r.get("hops") not in (None, "") else None,
                "link": r.get("link", ""),
            })
    return rows, skipped


def find_outages(fixes, cadence, factor=10):
    """Gaps far larger than the cadence, which are receiver-side rather than
    radio-side. The overnight capture that started this: both devices lost the
    identical window because the machine slept."""
    out = []
    for a, b in zip(fixes, fixes[1:]):
        gap = b["ts"] - a["ts"]
        if gap > cadence * factor:
            out.append((a["ts"], b["ts"], gap))
    return out


def bar(frac, width=20):
    n = int(round(frac * width))
    return "#" * n + "." * (width - n)


def analyse_device(dev, fixes, ref, bin_m, args):
    fixes.sort(key=lambda f: f["ts"])
    span = fixes[-1]["ts"] - fixes[0]["ts"]
    intervals = [b["ts"] - a["ts"] for a, b in zip(fixes, fixes[1:])]

    print(f"\n=== {dev}  ({len(fixes)} fixes) ===")
    if len(fixes) < 2:
        print("  too few fixes to analyse")
        return

    cadence = args.cadence or st.median(intervals)
    print(f"  window    {datetime.fromtimestamp(fixes[0]['ts'], timezone.utc):%H:%M:%S}"
          f" .. {datetime.fromtimestamp(fixes[-1]['ts'], timezone.utc):%H:%M:%S} UTC"
          f"  ({span / 3600:.2f} h)")
    print(f"  cadence   {cadence:.0f} s"
          + ("  (given)" if args.cadence else "  (median interval)"))

    outages = find_outages(fixes, cadence)
    live = [g for g in intervals if g <= cadence * 10]
    if outages:
        print(f"  outages   {len(outages)} excluded as receiver-side:")
        for a, b, g in outages:
            print(f"              {datetime.fromtimestamp(a, timezone.utc):%H:%M:%S}"
                  f" -> {datetime.fromtimestamp(b, timezone.utc):%H:%M:%S}"
                  f"  ({g / 60:.1f} min)")

    elapsed = sum(live)
    expected = round(elapsed / cadence) + 1 if cadence else 0
    received = len(live) + 1
    if expected:
        print(f"  coverage  {elapsed / 3600:.2f} h live")
        print(f"  delivery  {received}/{expected} = "
              f"{100 * received / expected:.1f}%")

    misses = [g for g in live if g > cadence * 1.5]
    if misses:
        lost = sum(round(g / cadence) - 1 for g in misses)
        print(f"  dropped   {lost} fixes across {len(misses)} gaps"
              f" (longest {max(misses):.0f} s)")

    rssi = [f["rssi"] for f in fixes if f["rssi"] is not None]
    snr = [f["snr"] for f in fixes if f["snr"] is not None]
    if rssi:
        print(f"  rssi      median {st.median(rssi):.0f}  range {min(rssi)}..{max(rssi)} dBm")
    if snr:
        print(f"  snr       median {st.median(snr):.2f}  range {min(snr)}..{max(snr)} dB")
    hops = {}
    for f in fixes:
        if f["hops"] is not None:
            hops[f["hops"]] = hops.get(f["hops"], 0) + 1
    if hops:
        label = ", ".join(f"{'direct' if k == 0 else str(k) + ' hop'}: {v}"
                          for k, v in sorted(hops.items()))
        print(f"  hops      {label}")

    if not ref:
        print("\n  (pass --from LAT,LON or --gateway ID for the distance curve)")
        return

    # Attribute each interval to the distance it happened at, so misses land in
    # the bin where they occurred. This is an estimate: a gap is assumed to have
    # been spent between the two positions that bracket it.
    bins = {}
    for a, b in zip(fixes, fixes[1:]):
        gap = b["ts"] - a["ts"]
        if gap > cadence * 10:
            continue
        mid_lat = (a["lat"] + b["lat"]) / 2
        mid_lon = (a["lon"] + b["lon"]) / 2
        d = haversine(ref[0], ref[1], mid_lat, mid_lon)
        key = int(d // bin_m)
        slot = bins.setdefault(key, {"exp": 0, "got": 0, "rssi": [], "snr": []})
        slot["exp"] += max(1, round(gap / cadence))
        slot["got"] += 1
        if b["rssi"] is not None:
            slot["rssi"].append(b["rssi"])
        if b["snr"] is not None:
            slot["snr"].append(b["snr"])

    if not bins:
        return
    print(f"\n  delivery vs distance from {ref[0]:.5f},{ref[1]:.5f}"
          f"  (bins of {bin_m:.0f} m)")
    print("    NOTE: RSSI and SNR are measured by the node that RECEIVED the")
    print("          packet. This curve is only meaningful if the reference is")
    print("          that receiving gateway.")
    relayed = sum(v for k, v in hops.items() if k > 0)
    if relayed:
        print(f"    NOTE: {relayed} packets arrived relayed; for those, RSSI"
              " describes the")
        print("          final hop from the relay, not the link from the collar.")
    print("    distance        delivery   n   RSSI   SNR")
    for key in sorted(bins):
        s = bins[key]
        frac = s["got"] / s["exp"] if s["exp"] else 0
        lo, hi = key * bin_m, (key + 1) * bin_m
        r = f"{st.median(s['rssi']):5.0f}" if s["rssi"] else "    -"
        n = f"{st.median(s['snr']):5.1f}" if s["snr"] else "    -"
        print(f"    {lo:5.0f}-{hi:5.0f} m   {100 * frac:5.1f}%  {s['got']:3d}  "
              f"{r}  {n}  {bar(frac)}")

    usable = [k for k in sorted(bins)
              if bins[k]["got"] / max(1, bins[k]["exp"]) >= 0.9]
    if usable:
        print(f"\n  90%+ delivery out to {(max(usable) + 1) * bin_m:.0f} m")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv")
    ap.add_argument("--from", dest="origin", metavar="LAT,LON",
                    help="position of the RECEIVING gateway, for the distance curve")
    ap.add_argument("--gateway", metavar="ID",
                    help="receiving gateway; its median position becomes the reference")
    ap.add_argument("--bin", type=float, default=100.0,
                    help="distance bin width in metres (default 100)")
    ap.add_argument("--cadence", type=float,
                    help="expected seconds between broadcasts; inferred if omitted")
    ap.add_argument("--include-nodedb", action="store_true",
                    help="include node-database rows (they are not heard packets)")
    ap.add_argument("--device", help="analyse only this device id")
    args = ap.parse_args()

    rows, skipped = load(args.csv, args.include_nodedb)
    if not rows:
        sys.exit("no usable rows")

    by = {}
    for r in rows:
        by.setdefault(r["id"], []).append(r)

    print(f"file      {args.csv}")
    print(f"rows      {len(rows)} used"
          + (f", {skipped} node-db rows excluded" if skipped else ""))
    print(f"devices   {', '.join(sorted(by))}")

    ref = None
    if args.origin:
        lat, lon = (float(x) for x in args.origin.split(","))
        ref = (lat, lon)
    elif args.gateway:
        g = by.get(args.gateway)
        if not g:
            sys.exit(f"no rows for gateway {args.gateway}")
        ref = (st.median([f["lat"] for f in g]), st.median([f["lon"] for f in g]))
        print(f"reference {args.gateway} median position {ref[0]:.5f},{ref[1]:.5f}")

    for dev in sorted(by):
        if args.device and dev != args.device:
            continue
        if args.gateway and dev == args.gateway:
            continue  # the reference node is not a subject
        analyse_device(dev, by[dev], ref, args.bin, args)


if __name__ == "__main__":
    main()
