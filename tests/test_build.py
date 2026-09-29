import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import build_data  # noqa: E402
from industry import classify_industry, classify_org  # noqa: E402


class ParseTest(unittest.TestCase):
    def test_csv_row(self):
        raw = (
            "主管機關,公告日期,處分日期,處分字號,事業單位名稱或負責人,違法法規法條,違反法規內容,罰鍰金額,備註說明\n"
            "台北市,20240201,20240115,北市勞動字第1130001號,好味道小吃店(王小明),"
            "勞動基準法第24條;勞動基準法第32條第2項,未給付加班費;超時工作,\"40,000\",\n"
            "台北市,20240201,20240115,北市勞動字第1130002號,某公司,就業服務法第57條,x,30000,\n"
        ).encode("utf-8-sig")
        rows = build_data.load_csv_bytes(raw)
        self.assertEqual(len(rows), 1)  # 非勞基法者排除
        r = rows[0]
        self.assertEqual(r["authority"], "臺北市")
        self.assertEqual(r["date"], 20240115)
        self.assertEqual(r["amount"], 40000)
        self.assertEqual(r["laws"], ["勞動基準法第24條", "勞動基準法第32條第2項"])

    def test_roc_date(self):
        self.assertEqual(build_data.to_int_date("1130115"), 20240115)
        self.assertEqual(build_data.to_int_date("2024/01/15"), 20240115)

    def test_authority(self):
        self.assertEqual(build_data.normalize_authority("臺中市政府勞工局"), "臺中市")
        self.assertEqual(build_data.normalize_authority("職業安全衛生署"), "職業安全衛生署")


class IndustryTest(unittest.TestCase):
    def test_classify(self):
        cases = {
            "黃根鵬即好口味檳榔攤(黃根鵬)": "批發及零售業",
            "國立臺灣大學醫學院附設醫院": "醫療保健及社會工作服務業",
            "東亞保全股份有限公司": "支援服務業（保全、清潔、人力派遣、旅行社）",
            "某某營造有限公司": "營建工程業",
            "摩爾物流股份有限公司": "運輸及倉儲業",
        }
        for name, want in cases.items():
            self.assertEqual(classify_industry(name), want, name)

    def test_org(self):
        self.assertEqual(classify_org("財團法人某某基金會"), "財團法人")
        self.assertEqual(classify_org("某某股份有限公司"), "股份有限公司")
        self.assertEqual(classify_org("王小明即小明商行"), "獨資、合夥商號")


if __name__ == "__main__":
    unittest.main()
