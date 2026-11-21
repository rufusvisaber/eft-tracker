#!/usr/bin/env python3
"""用沪深交易所官方按日 ETF 规模数据，回填种子快照之后的份额历史。

上交所：query.sse.com.cn/commonQuery.do（ETF 规模总表，TOT_VOL 单位万份）
深交所：www.szse.cn/api/report/ShowReport/data（基金规模，current_size 单位万份）

用法：python tools/backfill_shares.py
结果写入 data/shares.js 的 window.ETF_SHARE_UPDATES，页面刷新即生效。
"""
import datetime
import json
import pathlib
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
CONFIG = ROOT / "data" / "config.js"
SHARES = ROOT / "data" / "shares.js"
UA = "Mozilla/5.0"


def read_js_object(path, var_name):
    text = path.read_text(encoding="utf-8")
    prefix = var_name + " ="
    return json.loads(text[text.index(prefix) + len(prefix):].strip().rstrip(";"))


def write_js_object(path, var_name, obj):
    path.write_text(
        var_name + " = " + json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )


def fetch_json(url, referer, as_text=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer})
    raw = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "ignore")
    if as_text:
        return raw
    return json.loads(raw)


def sse_shares(date_compact, wanted):
    params = {
        "jsonCallBack": "cb",
        "sqlId": "COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L",
        "isPagination": "true",
        "pageHelp.pageSize": "2000",
        "pageHelp.cacheSize": "1",
        "STAT_DATE": date_compact,
    }
    url = "https://query.sse.com.cn/commonQuery.do?" + urllib.parse.urlencode(params)
    raw = fetch_json(url, "https://star.sse.com.cn/", as_text=True)
    data = json.loads(raw[raw.index("(") + 1:raw.rindex(")")])
    rows = data.get("result") or []
    out = {}
    for row in rows:
        code = str(row.get("SEC_CODE", "")).strip()
        if code in wanted:
            try:
                out[code] = round(float(row["TOT_VOL"]) / 1e4, 4)
            except (ValueError, KeyError, TypeError):
                pass
    return out


def szse_shares(code, start_dash, end_dash):
    params = {
        "SHOWTYPE": "JSON",
        "CATALOGID": "scsj_fund_jjgm",
        "jjlb": "ETF",
        "txtDm": code,
        "txtStart": start_dash,
        "txtEnd": end_dash,
        "PAGESIZE": "100",
    }
    url = "https://www.szse.cn/api/report/ShowReport/data?" + urllib.parse.urlencode(params)
    data = fetch_json(url, "https://www.szse.cn/market/fund/volume/etf/index.html")
    rows = (data[0].get("data") or []) if data else []
    out = {}
    for row in rows:
        date = str(row.get("size_date", ""))[:10].replace("-", "")
        try:
            out[date] = round(float(str(row["current_size"]).replace(",", "")) / 1e4, 4)
        except (ValueError, KeyError, TypeError):
            pass
    return out


def main():
    cfg = read_js_object(CONFIG, "window.ETF_CONFIG")
    seed_hist = cfg["shares_history"]
    seed_last = max(seed_hist)
    beijing = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    end = beijing.strftime("%Y%m%d")
    start_dt = datetime.datetime.strptime(seed_last, "%Y%m%d") + datetime.timedelta(days=1)
    start = start_dt.strftime("%Y%m%d")
    if start > end:
        print("没有需要回填的日期")
        return

    sse_codes = [i["code"] for i in cfg["items"] if i["tcode"].startswith("sh")]
    szse_codes = [i["code"] for i in cfg["items"] if i["tcode"].startswith("sz")]

    updates = read_js_object(SHARES, "window.ETF_SHARE_UPDATES")
    by_date = {}

    # 沪市：逐交易日查全表
    d = start_dt.date()
    last_date = beijing.date()
    while d <= last_date:
        compact = d.strftime("%Y%m%d")
        try:
            row = sse_shares(compact, set(sse_codes))
            if row:
                by_date[compact] = row
                print(f"SSE {compact}: {len(row)} 只")
        except Exception as exc:
            print(f"SSE {compact} 失败: {exc}")
        d += datetime.timedelta(days=1)
        time.sleep(0.15)

    # 深市：按代码查区间
    start_dash = f"{start[:4]}-{start[4:6]}-{start[6:]}"
    end_dash = f"{end[:4]}-{end[4:6]}-{end[6:]}"
    for code in szse_codes:
        try:
            series = szse_shares(code, start_dash, end_dash)
            for date, value in series.items():
                if start <= date <= end:
                    by_date.setdefault(date, {})[code] = value
            print(f"SZSE {code}: {len(series)} 个交易日")
        except Exception as exc:
            print(f"SZSE {code} 失败: {exc}")
        time.sleep(0.15)

    for date, row in sorted(by_date.items()):
        updates[date] = dict(updates.get(date, {}), **row)

    write_js_object(SHARES, "window.ETF_SHARE_UPDATES", updates)
    print(f"完成：写入 {len(by_date)} 个交易日，最新 {max(by_date) if by_date else '—'}")


if __name__ == "__main__":
    main()
