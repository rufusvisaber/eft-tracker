#!/usr/bin/env python3
"""每交易日抓取沪深交易所官方 ETF 份额，追写到 data/shares.js。

优先使用交易所官方按日规模数据（上交所 query.sse.com.cn / 深交所 www.szse.cn）；
若接口临时不可用，回退到腾讯行情当前份额。由 GitHub Actions 调用，也可手动运行：
    python tools/update_shares.py
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


def fetch(url, referer, as_text=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer})
    raw = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "ignore")
    return raw if as_text else json.loads(raw)


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
    raw = fetch(url, "https://star.sse.com.cn/", as_text=True)
    data = json.loads(raw[raw.index("(") + 1:raw.rindex(")")])
    out = {}
    for row in data.get("result") or []:
        code = str(row.get("SEC_CODE", "")).strip()
        if code in wanted and row.get("TOT_VOL"):
            out[code] = round(float(row["TOT_VOL"]) / 1e4, 4)
    return out


def szse_shares(code, start_dash, end_dash):
    params = {
        "SHOWTYPE": "JSON", "CATALOGID": "scsj_fund_jjgm", "jjlb": "ETF",
        "txtDm": code, "txtStart": start_dash, "txtEnd": end_dash, "PAGESIZE": "100",
    }
    url = "https://www.szse.cn/api/report/ShowReport/data?" + urllib.parse.urlencode(params)
    data = fetch(url, "https://www.szse.cn/market/fund/volume/etf/index.html")
    out = {}
    for row in (data[0].get("data") or []) if data else []:
        date = str(row.get("size_date", ""))[:10].replace("-", "")
        if date and row.get("current_size"):
            out[date] = round(float(str(row["current_size"]).replace(",", "")) / 1e4, 4)
    return out


def tencent_shares(tcodes):
    req = urllib.request.Request("https://qt.gtimg.cn/q=" + ",".join(tcodes),
                                 headers={"User-Agent": UA})
    raw = urllib.request.urlopen(req, timeout=30).read().decode("gbk", "ignore")
    row, date = {}, ""
    for line in raw.split(";"):
        if '="' not in line:
            continue
        a = line.split('="', 1)[1].rstrip('"').split("~")
        if len(a) < 73 or not a[72]:
            continue
        try:
            share = float(a[72]) / 1e8
        except ValueError:
            continue
        if share <= 0:
            continue
        row[a[2]] = round(share, 4)
        date = a[30][:8]
    return date, row


def main():
    cfg = read_js_object(CONFIG, "window.ETF_CONFIG")
    items = cfg["items"]
    updates = read_js_object(SHARES, "window.ETF_SHARE_UPDATES")
    beijing = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))

    sse_codes = {i["code"] for i in items if i["tcode"].startswith("sh")}
    szse_codes = [i["code"] for i in items if i["tcode"].startswith("sz")]

    # 交易所 T 日晚间更新、T+1 早间定稿；往前找最近一个有数据的交易日
    found = None
    for back in range(5):
        d = (beijing.date() - datetime.timedelta(days=back)).strftime("%Y%m%d")
        try:
            row = sse_shares(d, sse_codes)
            if len(row) >= len(sse_codes) * 0.8:
                found = (d, row)
                break
        except Exception as exc:
            print(f"SSE {d} 失败: {exc}")
        time.sleep(0.2)

    if found:
        date, row = found
        dash = f"{date[:4]}-{date[4:6]}-{date[6:]}"
        for code in szse_codes:
            try:
                series = szse_shares(code, dash, dash)
                if date in series:
                    row[code] = series[date]
            except Exception as exc:
                print(f"SZSE {code} 失败: {exc}")
            time.sleep(0.15)
        print(f"交易所源：{date} 共 {len(row)} 只")
    else:
        print("交易所接口不可用，回退腾讯行情")
        date, row = tencent_shares([i["tcode"] for i in items])

    if not date or len(row) < len(items) * 0.8:
        print(f"仅取得 {len(row)}/{len(items)} 只标的份额，跳过写入")
        return

    updates[date] = dict(updates.get(date, {}), **row)
    write_js_object(SHARES, "window.ETF_SHARE_UPDATES", updates)
    print(f"已写入 {date} 份额快照")


if __name__ == "__main__":
    main()
