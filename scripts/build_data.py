#!/usr/bin/env python3
"""下載並整理「違反勞動基準法」公布資料，輸出前端查詢頁使用的 JSON。

資料來源（官方）：
  勞動部「違反勞動法令事業單位（雇主）查詢系統」 https://announcement.mol.gov.tw/
  其開放資料「違反勞動基準法」資料集（A17000000J-030225-svj）：
  https://apiservice.mol.gov.tw/OdService/download/A17000000J-030225-svj
  各直轄市、縣市政府勞動局處依勞動基準法第 80 條之 1 公布的裁罰名單，皆彙整於此。

用法：
  python3 scripts/build_data.py                    # 下載官方最新 CSV，併入 data/ 既有資料
  python3 scripts/build_data.py --csv 檔案.csv      # 使用手動下載的 CSV
  python3 scripts/build_data.py --kiang-dir DIR    # 匯入 kiang/announcement.mol.gov.tw 存檔
  python3 scripts/build_data.py --rebuild ...      # 不合併既有資料，全部重建

輸出：
  data/index.json         主管機關、產業別等代碼表與各年度筆數
  data/records/YYYY.json  以「處分日期」西元年分檔的裁罰紀錄
"""

import argparse
import csv
import glob
import html
import io
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(__file__))
from industry import INDUSTRIES, ORG_TYPES, classify_industry, classify_org  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
REC_DIR = os.path.join(DATA_DIR, "records")

MOL_CSV_URL = "https://apiservice.mol.gov.tw/OdService/download/A17000000J-030225-svj"

MUNICIPALITIES = ["臺北市", "新北市", "桃園市", "臺中市", "臺南市", "高雄市"]
COUNTIES = [
    "基隆市", "新竹市", "嘉義市",
    "新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣", "嘉義縣",
    "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣", "金門縣", "連江縣",
]

# 各欄位在不同版本 CSV 中可能出現的名稱
FIELD_ALIASES = {
    "authority": ["主管機關", "縣市別", "縣市", "公布機關"],
    "announce": ["公告日期", "公布日期"],
    "date": ["處分日期", "裁處日期"],
    "doc": ["處分字號", "裁處書字號"],
    "name": ["事業單位名稱或負責人", "事業單位名稱", "雇主名稱"],
    "law": ["違法法規法條", "違反法規法條", "違反法條"],
    "content": ["違反法規內容", "違法內容"],
    "amount": ["罰鍰金額", "處分金額或滯納金", "罰鍰金額(元)"],
    "note": ["備註說明", "備註"],
}


def normalize_authority(s: str) -> str:
    s = re.sub(r"\s+", "", s or "").replace("台", "臺")
    for c in MUNICIPALITIES + COUNTIES:
        if s.startswith(c):
            return c
    s = s.replace("臺灣", "台灣")
    return s or "未標示"


def clean(s) -> str:
    s = html.unescape(str(s or ""))
    s = s.replace("\x00", "").replace("　", " ")
    return re.sub(r"\s+", " ", s).strip()


def to_int_date(s: str) -> int:
    digits = re.sub(r"\D", "", s or "")
    if len(digits) == 8:
        return int(digits)
    if len(digits) == 7:  # 民國 1130115
        return (int(digits[:3]) + 1911) * 10000 + int(digits[3:])
    return 0


def to_amount(s: str) -> int:
    digits = re.sub(r"[^\d]", "", s or "")
    return int(digits) if digits else 0


def split_multi(s: str):
    return [p.strip() for p in re.split(r"[;；]", s or "") if p.strip()]


def row_from_dict(d: dict, authority_override=None):
    def pick(key):
        for alias in FIELD_ALIASES[key]:
            if alias in d and d[alias] not in (None, ""):
                return d[alias]
        return ""

    law = clean(pick("law"))
    if "勞動基準法" not in law and "勞基法" not in law:
        return None
    rec = {
        "authority": normalize_authority(authority_override or pick("authority")),
        "announce": to_int_date(pick("announce")),
        "date": to_int_date(pick("date")),
        "doc": clean(pick("doc")),
        "name": clean(pick("name")),
        "laws": split_multi(law.replace("勞基法", "勞動基準法")),
        "texts": split_multi(clean(pick("content"))),
        "amount": to_amount(pick("amount")),
        "note": clean(pick("note")),
    }
    if not rec["date"]:
        rec["date"] = rec["announce"]
    if not rec["date"] or not rec["name"]:
        return None
    return rec


def load_csv_bytes(raw: bytes):
    for enc in ("utf-8-sig", "cp950", "big5"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ValueError("無法判斷 CSV 編碼")
    reader = csv.DictReader(io.StringIO(text))
    reader.fieldnames = [re.sub(r"\s+", "", f or "") for f in reader.fieldnames]
    out = []
    for d in reader:
        r = row_from_dict(d)
        if r:
            out.append(r)
    return out


def fetch_mol():
    req = urllib.request.Request(MOL_CSV_URL, headers={"User-Agent": "labor-inspection-query/1.0"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        return load_csv_bytes(resp.read())


def load_kiang(directory: str):
    """匯入 kiang/announcement.mol.gov.tw 的 data/{年}/{主管機關}/*.json 存檔。"""
    out = []
    for path in glob.glob(os.path.join(directory, "*", "*", "*.json")):
        authority = os.path.basename(os.path.dirname(path))
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
        except (ValueError, OSError):
            continue
        # 該存檔把「/」置換成「_」並移除空白，名稱中的「_」多為負責人分隔
        r = row_from_dict(d, authority_override=authority)
        if r:
            out.append(r)
    return out


def load_existing():
    out = []
    idx_path = os.path.join(DATA_DIR, "index.json")
    if not os.path.exists(idx_path):
        return out
    with open(idx_path, encoding="utf-8") as f:
        idx = json.load(f)
    for path in sorted(glob.glob(os.path.join(REC_DIR, "*.json"))):
        with open(path, encoding="utf-8") as f:
            y = json.load(f)
        for row in y["rows"]:
            a, date, announce, doc, name, laws, texts, amount, note = row[:9]
            out.append({
                "authority": idx["authorities"][a],
                "announce": announce, "date": date, "doc": doc, "name": name,
                "laws": [y["laws"][i] for i in laws],
                "texts": [y["texts"][i] for i in texts],
                "amount": amount, "note": note,
            })
    return out


def key_of(r):
    doc = re.sub(r"[\s_/]", "", r["doc"]).split("號")[0]
    name = re.sub(r"[\s_/()（）]", "", r["name"])[:12]
    return (doc, name, "|".join(r["laws"]), r["date"])


def merge(*sources):
    seen = {}
    for src in sources:
        for r in src:
            seen[key_of(r)] = r  # 後來的來源（官方最新）覆蓋舊資料
    return list(seen.values())


def authority_order(names):
    fixed = MUNICIPALITIES + COUNTIES
    others = sorted(n for n in names if n not in fixed)
    return fixed + others


def write_output(records):
    os.makedirs(REC_DIR, exist_ok=True)
    authorities = authority_order({r["authority"] for r in records})
    a_idx = {a: i for i, a in enumerate(authorities)}
    ind_idx = {n: i for i, n in enumerate(INDUSTRIES)}
    org_idx = {n: i for i, n in enumerate(ORG_TYPES)}

    by_year = {}
    for r in records:
        by_year.setdefault(r["date"] // 10000, []).append(r)

    years = {}
    for old in glob.glob(os.path.join(REC_DIR, "*.json")):
        os.remove(old)
    for year, rows in sorted(by_year.items()):
        rows.sort(key=lambda r: (-r["date"], r["authority"], r["name"]))
        laws, texts = {}, {}
        packed = []
        for r in rows:
            li = [laws.setdefault(x, len(laws)) for x in r["laws"]]
            ti = [texts.setdefault(x, len(texts)) for x in r["texts"]]
            packed.append([
                a_idx[r["authority"]], r["date"], r["announce"], r["doc"], r["name"],
                li, ti, r["amount"], r["note"],
                ind_idx[classify_industry(r["name"])], org_idx[classify_org(r["name"])],
            ])
        payload = {"year": year, "laws": list(laws), "texts": list(texts), "rows": packed}
        with open(os.path.join(REC_DIR, f"{year}.json"), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        years[str(year)] = {
            "count": len(rows),
            "minDate": min(r["date"] for r in rows),
            "maxDate": max(r["date"] for r in rows),
        }

    tz = timezone(timedelta(hours=8))
    index = {
        "updatedAt": datetime.now(tz).strftime("%Y-%m-%d %H:%M"),
        "source": MOL_CSV_URL,
        "municipalities": MUNICIPALITIES,
        "counties": COUNTIES,
        "authorities": authorities,
        "industries": INDUSTRIES,
        "orgTypes": ORG_TYPES,
        "rowFields": ["authority", "date", "announce", "doc", "name", "laws", "texts",
                      "amount", "note", "industry", "orgType"],
        "years": years,
        "total": len(records),
    }
    with open(os.path.join(DATA_DIR, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    return index


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", help="使用本機 CSV 檔，而非線上下載")
    ap.add_argument("--kiang-dir", help="匯入 kiang/announcement.mol.gov.tw 的 data 目錄")
    ap.add_argument("--rebuild", action="store_true", help="不合併 data/ 既有資料")
    ap.add_argument("--since", type=int, default=2015, help="只保留此西元年（含）之後的處分（預設 2015）")
    args = ap.parse_args()

    sources = [] if args.rebuild else [load_existing()]
    if args.kiang_dir:
        sources.append(load_kiang(args.kiang_dir))
    if args.csv:
        with open(args.csv, "rb") as f:
            sources.append(load_csv_bytes(f.read()))
    if not args.kiang_dir and not args.csv:
        sources.append(fetch_mol())

    for i, s in enumerate(sources):
        print(f"來源 {i}: {len(s)} 筆", file=sys.stderr)
    records = [r for r in merge(*sources) if r["date"] // 10000 >= args.since]
    index = write_output(records)
    print(f"完成：共 {index['total']} 筆，年度 {', '.join(index['years'])}", file=sys.stderr)


if __name__ == "__main__":
    main()
