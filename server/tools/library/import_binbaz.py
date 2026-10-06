from __future__ import annotations

import argparse
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import quote

APP_ROOT = Path(__file__).resolve().parents[3]
if str(APP_ROOT / "server") not in sys.path:
    sys.path.insert(0, str(APP_ROOT / "server"))

import httpx

from balligh.library import fatwa, snapshot
from balligh.library.fetch import Fetcher, FetchError

BASE = "https://binbaz.org.sa"
CACHE_DIR = APP_ROOT / "var" / "library-cache" / "fatwa"
TARGET_DIR = APP_ROOT / "var" / "library-staging" / "fatwa"
LIVE_ROOT = APP_ROOT / "content" / "library"
START_URLS = [f"{BASE}/categories/objective/206/fatwa", f"{BASE}/categories/objective/206/fatwa?page=2"]
MAX_PAGES = 5
CATEGORIES = [
    {"kind": "objective", "id": "206", "label": "الإسلام والإيمان", "topic": "understanding_islam",
     "why": "start category: what Islam and iman are, entering Islam, the pillars"},
    {"kind": "objective", "id": "208", "label": "الربوبية والألوهية", "topic": "belief",
     "why": "core belief: the shahada, tawhid of lordship and worship; linked from the start page sidebar"},
    {"kind": "fiqhi", "id": "23", "label": "حكم الصلاة وأهميتها", "topic": "worship",
     "why": "worship basics: the obligation and importance of the prayer"},
    {"kind": "fiqhi", "id": "14", "label": "فروض الوضوء وصفته", "topic": "worship",
     "why": "worship basics: how to perform wudu"},
    {"kind": "objective", "id": "228", "label": "الآداب والأخلاق المحمودة", "topic": "conduct",
     "why": "everyday conduct: praiseworthy manners and character"},
    {"kind": "objective", "id": "370", "label": "بر الوالدين", "topic": "conduct",
     "why": "everyday conduct: dutifulness to parents"},
]
SEEDS = [
    f"{BASE}/fatwas/18975/" + quote("ما-معنى-الشهادتين"),
    f"{BASE}/fatwas/19825/" + quote("حكم-قراءة-القران-الكريم-لمن-لا-يجيد-قواعد-اللغة-العربية"),
]
SEED_TOPICS = {"objective/208": "belief", "objective/197": "worship", "objective/206": "understanding_islam"}
FAILED_ROUTES = [
    {"url": f"{BASE}/fatwas/18975", "observed": "302 to https://binbaz.org.sa/fatwas/14774/... (a different fatwa)",
     "decision": "id-only fatwa URLs are not used; only full detail URLs linked from official listing pages or the given examples"},
    {"url": f"{BASE}/fatwas/19825", "observed": "302 to https://binbaz.org.sa/fatwas/15617/... (a different fatwa)",
     "decision": "same as above"},
]
CURATED = [
    {"id": '15', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/15/%D8%A7%D9%84%D8%AA%D9%83%D8%A7%D8%B3%D9%84-%D8%B9%D9%86-%D8%A7%D8%AF%D8%A7%D8%A1-%D8%A8%D8%B9%D8%B6-%D8%A7%D9%84%D9%88%D8%A7%D8%AC%D8%A8%D8%A7%D8%AA', "added_from": None, "reason": "Explains that a Muslim who neglects some duties has weaker faith: faith rises with obedience and falls with sin."},
    {"id": '855', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/855/%D9%85%D9%85-%D8%AE%D9%84%D9%82-%D8%A7%D9%84%D9%84%D9%87-%D8%A7%D9%84%D9%85%D9%84%D8%A7%D9%89%D9%83%D8%A9-%D9%88%D8%A7%D8%A8%D9%84%D9%8A%D8%B3', "added_from": None, "reason": "Answers a common curiosity: what angels, jinn and Adam were created from, citing the hadith in Sahih Muslim."},
    {"id": '894', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/894/%D8%A7%D9%84%D8%AA%D8%B9%D8%B1%D9%8A%D9%81-%D8%A8%D8%A7%D9%84%D8%AF%D9%8A%D9%86', "added_from": None, "reason": "Defines what a 'religion' is and how Islam differs from other religions; basic framing for someone exploring Islam."},
    {"id": '963', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/963/%D9%87%D9%84-%D8%A7%D9%84%D8%A7%D9%85%D8%B1-%D8%A8%D8%A7%D9%84%D9%85%D8%B9%D8%B1%D9%88%D9%81-%D9%88%D8%A7%D9%84%D9%86%D9%87%D9%8A-%D8%B9%D9%86-%D8%A7%D9%84%D9%85%D9%86%D9%83%D8%B1-%D8%B1%D9%83%D9%86-%D9%85%D9%86-%D8%A7%D8%B1%D9%83%D8%A7%D9%86-%D8%A7%D9%84%D8%A7%D8%B3%D9%84%D8%A7%D9%85', "added_from": None, "reason": "Lists the five pillars of Islam and where enjoining good fits; a basic orientation question."},
    {"id": '1157', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/1157/%D8%A7%D9%84%D9%83%D8%A8%D8%A7%D9%89%D8%B1-%D8%AA%D9%88%D8%AB%D8%B1-%D9%81%D9%8A-%D8%A7%D8%B3%D9%84%D8%A7%D9%85-%D8%A7%D9%84%D8%B9%D8%A8%D8%AF', "added_from": None, "reason": "Explains how major sins weaken faith without taking a Muslim out of Islam; corrects a common misconception."},
    {"id": '1263', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/1263/%D8%A7%D9%84%D8%A7%D9%85%D9%88%D8%B1-%D8%A7%D9%84%D8%AA%D9%8A-%D9%8A%D8%AF%D8%AE%D9%84-%D8%A8%D9%87%D8%A7-%D9%81%D9%8A-%D8%A7%D9%84%D8%A7%D8%B3%D9%84%D8%A7%D9%85', "added_from": None, "reason": "States what brings a person into Islam (the two testimonies said truthfully, with knowledge) and that prayer and other duties follow; core for converts."},
    {"id": '1532', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/1532/%D8%AD%D9%83%D9%85-%D8%A7%D9%84%D8%A7%D8%B3%D8%AA%D8%AB%D9%86%D8%A7%D8%A1-%D9%81%D9%8A-%D8%A7%D9%84%D8%A7%D9%8A%D9%85%D8%A7%D9%86', "added_from": None, "reason": "Explains saying 'I am a believer, in sha Allah' and that it is not doubt; a frequent beginner question."},
    {"id": '1656', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/1656/%D8%A7%D8%AE%D8%AA%D9%84%D8%A7%D9%81-%D9%85%D8%AF%D9%84%D9%88%D9%84%D8%A7%D8%AA-%D8%A7%D9%84%D8%A7%D9%8A%D9%85%D8%A7%D9%86-%D9%88%D8%A7%D9%84%D8%AA%D9%88%D8%AD%D9%8A%D8%AF-%D9%88%D8%A7%D9%84%D8%B9%D9%82%D9%8A%D8%AF%D8%A9', "added_from": None, "reason": "Distinguishes the terms iman, tawhid and aqidah that new learners meet early."},
    {"id": '1996', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/1996/%D8%A7%D9%84%D8%B1%D9%83%D9%86-%D8%A7%D9%84%D8%A7%D9%88%D9%84-%D9%85%D9%86-%D8%A7%D8%B1%D9%83%D8%A7%D9%86-%D8%A7%D9%84%D8%A7%D8%B3%D9%84%D8%A7%D9%85-%D9%85%D8%B9%D9%86%D8%A7%D9%87-%D9%88%D9%85%D9%82%D8%AA%D8%B6%D8%A7%D9%87', "added_from": None, "reason": "Explains the meaning and requirements of the first pillar (the shahada); foundational for a new Muslim."},
    {"id": '1998', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/1998/%D9%87%D9%84-%D9%8A%D9%83%D9%81%D9%8A-%D8%A7%D9%84%D9%86%D8%B7%D9%82-%D8%A8%D8%A7%D9%84%D8%B4%D9%87%D8%A7%D8%AF%D8%AA%D9%8A%D9%86-%D9%88%D8%A7%D9%84%D8%A7%D8%B9%D8%AA%D9%82%D8%A7%D8%AF-%D9%84%D9%84%D8%AF%D8%AE%D9%88%D9%84-%D9%81%D9%8A-%D8%A7%D9%84%D8%A7%D8%B3%D9%84%D8%A7%D9%85', "added_from": None, "reason": "Answers whether saying and believing the shahada is enough to enter Islam and what is expected after it."},
    {"id": '2089', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/2089/%D9%87%D9%84-%D9%87%D8%A7%D8%B1%D9%88%D8%AA-%D9%88%D9%85%D8%A7%D8%B1%D9%88%D8%AA-%D9%85%D9%84%D9%83%D8%A7%D9%86-%D8%A7%D9%88-%D8%A8%D8%B4%D8%B1%D8%A7%D9%86', "added_from": None, "reason": "Background to a Quran verse readers ask about (Harut and Marut, Al-Baqarah 102); secondary, not a first-step topic."},
    {"id": '3366', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/3366/%D8%AD%D9%82%D9%8A%D9%82%D8%A9-%D8%A7%D8%B5%D9%84-%D8%A7%D9%84%D8%A7%D9%8A%D9%85%D8%A7%D9%86-%D9%88%D8%AA%D9%81%D8%A7%D9%88%D8%AA-%D8%A7%D9%84%D9%86%D8%A7%D8%B3-%D9%81%D9%8A%D9%87', "added_from": None, "reason": "Explains that the basis of faith is one while people differ in its strength."},
    {"id": '3982', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/3982/%D9%85%D8%A7-%D8%A7%D9%84%D8%AD%D8%AF-%D8%A7%D9%84%D8%A7%D8%AF%D9%86%D9%89-%D9%84%D9%84%D9%82%D9%8A%D8%A7%D9%85-%D8%A8%D9%88%D8%A7%D8%AC%D8%A8-%D8%A7%D9%84%D8%B9%D8%A8%D8%A7%D8%AF%D8%A9-%D9%84%D9%84%D9%87-%D8%AA%D8%B9%D8%A7%D9%84%D9%89', "added_from": None, "reason": "Gives the minimum owed to God: do the obligations and avoid the prohibitions; a clear starting point."},
    {"id": '5627', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/5627/%D8%AD%D9%83%D9%85-%D8%A7%D9%84%D8%A7%D9%83%D8%AA%D9%81%D8%A7%D8%A1-%D8%A8%D8%A7%D9%8A%D9%85%D8%A7%D9%86-%D8%A7%D9%84%D9%82%D9%84%D8%A8-%D8%AF%D9%88%D9%86-%D8%A7%D9%84%D8%B9%D9%85%D9%84', "added_from": None, "reason": "Explains that belief in the heart alone is not enough without prayer and other deeds."},
    {"id": '5629', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/5629/%D8%AD%D9%83%D9%85-%D9%85%D9%86-%D9%8A%D8%AA%D8%B1%D9%83-%D8%B1%D9%83%D9%86%D8%A7-%D9%85%D9%86-%D8%A7%D8%B1%D9%83%D8%A7%D9%86-%D8%A7%D9%84%D8%A7%D8%B3%D9%84%D8%A7%D9%85', "added_from": None, "reason": "Clarifies that the shahada brings a person into Islam and why prayer then matters."},
    {"id": '5990', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/5990/%D9%85%D8%A7-%D8%B4%D8%B1%D9%88%D8%B7-%D8%A7%D9%84%D8%A7%D8%B3%D9%84%D8%A7%D9%85', "added_from": None, "reason": "States the two conditions of accepted deeds and Islam: sincerity to God and following the Prophet."},
    {"id": '6720', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/6720/%D9%85%D8%A7-%D8%A7%D9%84%D9%82%D9%88%D8%A9-%D8%A7%D9%84%D9%85%D8%AD%D9%85%D9%88%D8%AF%D8%A9-%D9%81%D9%8A-%D8%A7%D9%84%D9%85%D9%88%D9%85%D9%86', "added_from": None, "reason": "Short note that the praised strength of a believer is strength in deeds, not body."},
    {"id": '6940', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/6940/%D9%85%D8%B9%D9%86%D9%89-%D8%A7%D9%84%D8%B4%D9%87%D8%A7%D8%AF%D8%AA%D9%8A%D9%86', "added_from": None, "reason": "Explains the meaning of the two testimonies, through which a person enters Islam."},
    {"id": '9614', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/9614/%D8%AD%D9%83%D9%85-%D9%85%D8%B1%D8%AA%D9%83%D8%A8-%D8%A7%D9%84%D9%83%D8%A8%D9%8A%D8%B1%D8%A9-%D8%B9%D9%86%D8%AF-%D8%A7%D9%87%D9%84-%D8%A7%D9%84%D8%B3%D9%86%D8%A9-%D9%88%D8%BA%D9%8A%D8%B1%D9%87%D9%85', "added_from": None, "reason": "Explains that a Muslim who commits a major sin is sinful but remains a Muslim (the Sunni position)."},
    {"id": '10633', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/10633/%D9%85%D8%A7%D9%87%D9%8A-%D8%A7%D9%84%D9%81%D8%B7%D8%B1%D8%A9-%D8%A7%D9%84%D8%AA%D9%8A-%D9%8A%D9%88%D9%84%D8%AF-%D8%A7%D9%84%D9%85%D9%88%D9%84%D9%88%D8%AF-%D8%B9%D9%84%D9%8A%D9%87%D8%A7', "added_from": None, "reason": "Explains the fitrah every child is born upon; relevant to someone exploring Islam."},
    {"id": '11423', "topic": 'understanding_islam', "url": 'https://binbaz.org.sa/fatwas/11423/%D8%AA%D9%88%D8%B6%D9%8A%D8%AD-%D9%85%D8%B9%D9%86%D9%89-%D8%A7%D9%84%D8%A7%D8%B3%D9%84%D8%A7%D9%85', "added_from": None, "reason": "Defines Islam: submitting to God with tawhid and obeying Him; an ideal opening entry."},
    {"id": '6', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/6/%D8%A7%D9%84%D8%B3%D8%A8%D9%8A%D9%84-%D8%A7%D9%84%D9%89-%D9%85%D8%B9%D8%B1%D9%81%D8%A9-%D8%A7%D9%84%D8%AA%D9%88%D8%AD%D9%8A%D8%AF-%D8%A7%D8%B9%D8%AA%D9%82%D8%A7%D8%AF%D8%A7-%D9%88%D8%B3%D9%84%D9%88%D9%83%D8%A7-%D9%88%D8%B9%D9%85%D9%84%D8%A7', "added_from": None, "reason": "Practical guidance on how to learn and live tawhid in belief, conduct and deeds."},
    {"id": '52', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/52/%D8%B4%D8%B1%D9%88%D8%B7-%D9%82%D9%88%D9%84-%D9%84%D8%A7-%D8%A7%D9%84%D9%87-%D8%A7%D9%84%D8%A7-%D8%A7%D9%84%D9%84%D9%87', "added_from": None, "reason": "Lists the conditions of 'la ilaha illa Allah' and that its meaning must be understood, not only said."},
    {"id": '56', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/56/%D8%A7%D9%84%D8%AF%D9%84%D9%8A%D9%84-%D8%B9%D9%84%D9%89-%D9%83%D9%84%D9%85%D8%A9-%D8%A7%D9%84%D8%AA%D9%88%D8%AD%D9%8A%D8%AF', "added_from": None, "reason": "Gives the Quranic evidence for the word of tawhid and what tawhid means."},
    {"id": '1158', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/1158/%D9%88%D8%AC%D9%88%D8%A8-%D8%A7%D9%84%D8%AA%D8%B5%D8%AF%D9%8A%D9%82-%D9%85%D8%B9-%D8%A7%D9%84%D8%B4%D9%87%D8%A7%D8%AF%D8%AA%D9%8A%D9%86', "added_from": None, "reason": "Explains that the shahada must be uttered and its meaning believed; basic for conversion."},
    {"id": '1237', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/1237/%D9%83%D9%8A%D9%81-%D9%8A%D8%AA%D8%AD%D9%82%D9%82-%D8%A7%D9%84%D8%AA%D9%88%D8%AD%D9%8A%D8%AF-%D9%88%D9%85%D8%B9%D9%86%D9%89-%D8%A7%D9%84%D8%B4%D8%B1%D9%83-%D9%88%D8%A7%D9%84%D8%B8%D9%84%D9%85', "added_from": None, "reason": "Explains how tawhid is realised and what shirk and injustice mean; core vocabulary."},
    {"id": '1655', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/1655/%D8%AA%D9%82%D8%B3%D9%8A%D9%85-%D8%A7%D9%84%D8%AA%D9%88%D8%AD%D9%8A%D8%AF-%D8%A7%D9%84%D9%89-%D8%AB%D9%84%D8%A7%D8%AB%D8%A9-%D8%A7%D9%82%D8%B3%D8%A7%D9%85', "added_from": None, "reason": "Explains the three-part classification of tawhid and its basis; useful for a teacher introducing the topic."},
    {"id": '2001', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/2001/%D9%85%D8%B9%D9%86%D9%89-%D9%84%D8%A7-%D8%A7%D9%84%D9%87-%D8%A7%D9%84%D8%A7-%D8%A7%D9%84%D9%84%D9%87-%D9%88%D9%85%D9%82%D8%AA%D8%B6%D8%A7%D9%87%D8%A7-%D9%88%D8%B4%D8%B1%D9%88%D8%B7%D9%87%D8%A7', "added_from": None, "reason": "Explains the meaning, requirements and conditions of 'la ilaha illa Allah'."},
    {"id": '2002', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/2002/%D8%A7%D9%84%D9%82%D8%A7%D8%A1-%D8%A7%D9%84%D8%B6%D9%88%D8%A1-%D8%AD%D9%88%D9%84-%D8%A7%D9%87%D9%85%D9%8A%D8%A9-%D8%AA%D9%88%D8%AD%D9%8A%D8%AF-%D8%A7%D9%84%D8%A7%D9%84%D9%87%D9%8A%D8%A9', "added_from": None, "reason": "Explains why worshipping God alone, not only affirming Him as Lord, is the message of the prophets."},
    {"id": '2171', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/2171/%D8%B4%D8%B1%D8%AD-%D8%AD%D8%AF%D9%8A%D8%AB-%D8%A7%D9%85%D8%B1%D8%AA-%D8%A7%D9%86-%D8%A7%D9%82%D8%A7%D8%AA%D9%84-%D8%A7%D9%84%D9%86%D8%A7%D8%B3-%D8%A7%D9%84%D8%AD%D8%AF%D9%8A%D8%AB', "added_from": None, "reason": "Explains an often-quoted hadith ('I was commanded to fight people...') in context; for a teacher answering questions about it, not a first step."},
    {"id": '2190', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/2190/%D8%A8%D9%8A%D8%A7%D9%86-%D8%A7%D9%86%D9%88%D8%A7%D8%B9-%D8%A7%D9%84%D8%AA%D9%88%D8%AD%D9%8A%D8%AF-%D9%88%D8%A7%D9%84%D9%81%D8%B1%D9%82-%D8%A8%D9%8A%D9%86%D9%87%D8%A7', "added_from": None, "reason": "Explains the difference between tawhid of lordship and tawhid of worship in simple terms."},
    {"id": '2348', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/2348/%D9%87%D9%84-%D8%A7%D9%84%D8%B0%D9%8A%D9%86-%D9%8A%D9%86%D9%83%D8%B1%D9%88%D9%86-%D9%88%D8%AC%D9%88%D8%AF-%D8%A7%D9%84%D9%84%D9%87-%D9%8A%D8%AF%D9%84-%D8%B9%D9%84%D9%89-%D8%A7%D9%86%D9%83%D8%A7%D8%B1%D9%87%D9%85-%D8%A7%D9%84%D8%B1%D8%A8%D9%88%D8%A8%D9%8A%D8%A9', "added_from": None, "reason": "Discusses atheists who deny God and tawhid of lordship; relevant to someone from a non-religious background."},
    {"id": '2460', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/2460/%D8%AD%D9%83%D9%85-%D9%85%D9%88%D8%A7%D9%84%D8%A7%D8%A9-%D8%A7%D9%84%D9%83%D9%81%D8%A7%D8%B1-%D9%88%D9%85%D8%AD%D8%A8%D8%AA%D9%87%D9%85', "added_from": None, "reason": "Distinguishes forms of allegiance and affection toward non-Muslims and how they are classified: loving them for their religion or approving it is disbelief, while special affection for a relative or spouse without approving their religion is described as a deficient love that weakens faith, below apostasy; doctrinally sensitive for converts with non-Muslim family and teacher-level."},
    {"id": '2554', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/2554/%D8%B3%D8%A8%D8%A8-%D8%A7%D9%82%D8%AA%D8%B1%D8%A7%D9%86-%D8%A7%D9%84%D8%B4%D9%87%D8%A7%D8%AF%D8%AA%D9%8A%D9%86-%D9%81%D9%8A-%D8%B1%D9%83%D9%86-%D9%88%D8%A7%D8%AD%D8%AF', "added_from": None, "reason": "Explains why the two testimonies form a single pillar."},
    {"id": '2556', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/2556/%D8%AE%D8%B7%D8%A7-%D9%81%D9%8A-%D8%AA%D9%81%D8%B3%D9%8A%D8%B1-%D9%83%D9%84%D9%85%D8%A9-%D9%84%D8%A7-%D8%A7%D9%84%D9%87-%D8%A7%D9%84%D8%A7-%D8%A7%D9%84%D9%84%D9%87', "added_from": None, "reason": "Corrects a common error of explaining 'la ilaha illa Allah' as only 'no creator but God'."},
    {"id": '2994', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/2994/%D8%AD%D9%88%D9%84-%D9%83%D9%84%D9%85%D8%A9-%D8%A7%D9%84%D9%88%D9%84%D8%A7%D8%A1-%D9%84%D9%84%D9%88%D8%B7%D9%86', "added_from": None, "reason": "Addresses the phrase 'loyalty to the homeland'; secondary topic kept for teachers."},
    {"id": '3442', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/3442/%D9%83%D9%8A%D9%81%D9%8A%D8%A9-%D8%A7%D9%84%D8%A8%D8%B1%D8%A7%D8%A1%D8%A9-%D9%85%D9%86-%D8%A7%D9%84%D9%83%D8%A7%D9%81%D8%B1%D9%8A%D9%86-%D9%88%D8%AF%D8%B9%D9%88%D8%AA%D9%87%D9%85-%D8%A7%D9%84%D9%89-%D8%A7%D9%84%D9%84%D9%87', "added_from": None, "reason": "How to call non-Muslim neighbours and co-workers to Islam; relevant to new Muslims living among non-Muslims."},
    {"id": '3446', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/3446/%D8%A7%D9%84%D8%AD%D8%A8-%D9%88%D8%A7%D9%84%D8%A8%D8%BA%D8%B6-%D9%8A%D9%83%D9%88%D9%86-%D9%84%D8%B9%D9%85%D9%84-%D8%A7%D9%84%D8%B4%D8%AE%D8%B5-%D9%84%D8%A7-%D9%84%D8%B0%D8%A7%D8%AA%D9%87', "added_from": None, "reason": "Love and dislike are for a person's deeds, never for race, colour or lineage."},
    {"id": '6782', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/6782/%D9%81%D8%B6%D9%8A%D9%84%D8%A9-%D8%A7%D9%84%D8%AD%D8%A8-%D9%81%D9%8A-%D8%A7%D9%84%D9%84%D9%87-%D9%88%D8%A7%D9%84%D8%A8%D8%BA%D8%B6-%D9%81%D9%8A-%D8%A7%D9%84%D9%84%D9%87', "added_from": None, "reason": "Explains the virtue of loving one another for the sake of God."},
    {"id": '9279', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/9279/%D8%B6%D8%A7%D8%A8%D8%B7-%D8%A7%D9%84%D9%83%D8%B1%D9%87-%D9%88%D8%A7%D9%84%D8%A8%D8%BA%D8%B6-%D9%84%D9%84%D8%BA%D9%8A%D8%B1-%D9%88%D9%85%D8%AF%D8%AA%D9%87', "added_from": None, "reason": "Advises against holding grudges over worldly matters and on striving to reconcile."},
    {"id": '10741', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/10741/%D9%85%D8%A7-%D9%85%D9%82%D8%AA%D8%B6%D9%8A%D8%A7%D8%AA-%D9%84%D8%A7-%D8%A7%D9%84%D9%87-%D8%A7%D9%84%D8%A7-%D8%A7%D9%84%D9%84%D9%87', "added_from": None, "reason": "Explains what 'la ilaha illa Allah' requires of the one who says it."},
    {"id": '11643', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/11643/%D9%87%D9%84-%D9%85%D9%86-%D9%82%D8%A7%D9%84-%D9%84%D8%A7-%D8%A7%D9%84%D9%87-%D8%A7%D9%84%D8%A7-%D8%A7%D9%84%D9%84%D9%87-%D8%AF%D8%AE%D9%84-%D8%A7%D9%84%D8%AC%D9%86%D8%A9-%D9%88%D9%85%D8%A7-%D8%B4%D8%B1%D9%88%D8%B7%D9%87%D8%A7', "added_from": None, "reason": "Answers whether saying 'la ilaha illa Allah' alone admits to Paradise, and its conditions."},
    {"id": '12152', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/12152/%D8%A7%D9%82%D8%B3%D8%A7%D9%85-%D8%A7%D9%84%D8%AA%D9%88%D8%AD%D9%8A%D8%AF-%D9%88%D8%A8%D9%8A%D8%A7%D9%86-%D8%AF%D8%AE%D9%88%D9%84%D9%87%D8%A7-%D8%B6%D9%85%D9%86-%D8%A7%D9%84%D8%B4%D9%87%D8%A7%D8%AF%D8%AA%D9%8A%D9%86', "added_from": None, "reason": "Lists the three categories of tawhid and how they relate to the two testimonies."},
    {"id": '18975', "topic": 'belief', "url": 'https://binbaz.org.sa/fatwas/18975/%D9%85%D8%A7-%D9%85%D8%B9%D9%86%D9%89-%D8%A7%D9%84%D8%B4%D9%87%D8%A7%D8%AF%D8%AA%D9%8A%D9%86', "added_from": None, "reason": "User-provided example: the meaning of the two testimonies; foundational."},
    {"id": '1224', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/1224/%D9%83%D9%8A%D9%81%D9%8A%D8%A9-%D9%82%D8%B6%D8%A7%D8%A1-%D9%85%D9%86-%D8%A7%D8%AF%D8%B1%D9%83-%D8%B1%D9%83%D8%B9%D8%A9-%D9%81%D9%8A-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9-%D8%A7%D9%84%D8%AC%D9%87%D8%B1%D9%8A%D8%A9', "added_from": 'fiqhi/34', "reason": "How a latecomer who joined one rak'ah recites in the rak'ahs he completes; practical for congregational prayer."},
    {"id": '1353', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/1353/%D9%87%D9%84-%D8%AA%D8%B5%D9%84%D9%8A-%D8%A7%D9%84%D9%85%D8%B1%D8%A7%D8%A9-%D8%AC%D9%87%D8%B1%D8%A7-%D9%83%D8%A7%D9%84%D8%B1%D8%AC%D9%84', "added_from": 'fiqhi/34', "reason": "A woman may recite aloud in the aloud prayers like a man; practical for women."},
    {"id": '1375', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/1375/%D8%AD%D9%83%D9%85-%D9%82%D8%B1%D8%A7%D8%A1%D8%A9-%D8%A7%D9%84%D9%81%D8%A7%D8%AA%D8%AD%D8%A9-%D9%81%D9%8A-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9-%D8%A7%D9%84%D8%B3%D8%B1%D9%8A%D8%A9-%D9%88%D8%A7%D9%84%D8%AC%D9%87%D8%B1%D9%8A%D8%A9', "added_from": 'fiqhi/34', "reason": "Al-Fatihah must be recited in every prayer by the imam and the person praying alone; core how-to-pray rule."},
    {"id": '1548', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/1548/%D8%A8%D9%8A%D8%A7%D9%86-%D9%83%D9%8A%D9%81%D9%8A%D8%A9-%D8%A7%D9%84%D8%AA%D9%8A%D9%85%D9%85', "added_from": 'fiqhi/19', "reason": "The correct way to perform tayammum: one strike, then wipe the face and hands."},
    {"id": '1614', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/1614/%D8%AD%D9%83%D9%85-%D8%AA%D8%B1%D9%83-%D8%A7%D9%84%D9%88%D8%A7%D8%AC%D8%A8%D8%A7%D8%AA-%D8%A7%D8%AD%D8%AA%D8%AC%D8%A7%D8%AC%D8%A7-%D8%A8%D8%AD%D8%AF%D9%8A%D8%AB-%D8%A7%D9%84%D8%AC%D9%85%D8%B9%D8%A9-%D8%A7%D9%84%D9%89-%D8%A7%D9%84%D8%AC%D9%85%D8%B9%D8%A9', "added_from": None, "reason": "Corrects the excuse of praying only on Fridays and in Ramadan; one of three kept leaving-prayer items."},
    {"id": '1787', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/1787/%D8%A8%D9%8A%D8%A7%D9%86-%D8%A7%D9%84%D8%AD%D8%A7%D9%84%D8%A7%D8%AA-%D8%A7%D9%84%D8%AA%D9%8A-%D9%8A%D8%AC%D9%88%D8%B2-%D9%81%D9%8A%D9%87%D8%A7-%D8%AA%D8%A7%D8%AE%D9%8A%D8%B1-%D8%A7%D9%84%D8%B5%D9%84%D9%88%D8%A7%D8%AA', "added_from": 'fiqhi/27', "reason": "The valid reasons for delaying a prayer, and that habitual delay is not allowed."},
    {"id": '2149', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/2149/%D8%A7%D9%84%D8%A7%D8%B3%D8%A8%D8%A7%D8%A8-%D8%A7%D9%84%D9%85%D8%B9%D9%8A%D9%86%D8%A9-%D8%B9%D9%84%D9%89-%D8%A7%D9%84%D9%82%D9%8A%D8%A7%D9%85-%D9%84%D8%B5%D9%84%D8%A7%D8%A9-%D8%A7%D9%84%D9%81%D8%AC%D8%B1', "added_from": None, "reason": "Practical steps that help one wake up for the Fajr prayer."},
    {"id": '2523', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/2523/%D9%87%D9%84-%D9%8A%D8%A7%D8%AB%D9%85-%D9%85%D9%86-%D8%AD%D9%81%D8%B8-%D8%B4%D9%8A%D9%89%D8%A7-%D9%85%D9%86-%D8%A7%D9%84%D9%82%D8%B1%D8%A7%D9%86-%D8%AB%D9%85-%D9%86%D8%B3%D9%8A%D9%87', "added_from": 'fiqhi/34', "reason": "Forgetting memorised Quran is not a sin; encourages learning short surahs to recite in prayer; useful for beginners still memorising."},
    {"id": '2616', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/2616/%D8%AD%D9%83%D9%85-%D8%A7%D9%84%D8%AA%D9%86%D8%B4%D9%8A%D9%81-%D8%A8%D8%B9%D8%AF-%D8%A7%D9%84%D9%88%D8%B6%D9%88%D8%A1-%D9%88%D8%A8%D8%B9%D8%AF-%D8%A7%D9%84%D8%BA%D8%B3%D9%84-%D9%85%D9%86-%D8%A7%D9%84%D8%AC%D9%86%D8%A7%D8%A8%D8%A9', "added_from": 'fiqhi/14', "reason": "Drying the limbs after wudu or ghusl is allowed either way; simple everyday question."},
    {"id": '2631', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/2631/%D8%AD%D9%83%D9%85-%D9%82%D8%B6%D8%A7%D8%A1-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9-%D8%B9%D9%86-%D8%A7%D9%84%D9%85%D9%8A%D8%AA', "added_from": None, "reason": "Tells the sick to pray as they are able instead of postponing prayers to make them up later."},
    {"id": '2774', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/2774/%D8%AD%D9%83%D9%85-%D9%85%D9%86-%D9%86%D8%A7%D9%85-%D8%B9%D9%86-%D8%B5%D9%84%D8%A7%D8%A9-%D8%A7%D9%84%D8%B5%D8%A8%D8%AD-%D8%AD%D8%AA%D9%89-%D8%AE%D8%B1%D8%AC-%D9%88%D9%82%D8%AA%D9%87%D8%A7', "added_from": 'fiqhi/27', "reason": "Whoever oversleeps Fajr prays it on waking; a very common beginner situation."},
    {"id": '2778', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/2778/%D8%AD%D9%83%D9%85-%D8%AA%D8%B1%D9%83-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9-%D9%85%D8%B9-%D8%A7%D9%84%D8%A7%D9%82%D8%B1%D8%A7%D8%B1-%D8%A8%D9%87%D8%A7', "added_from": None, "reason": "The core ruling on deliberately leaving prayer, presenting both scholarly views; kept as the single representative ruling."},
    {"id": '2978', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/2978/%D9%85%D8%A7-%D8%A7%D9%84%D9%88%D8%A7%D8%AC%D8%A8-%D8%AA%D8%AC%D8%A7%D9%87-%D8%A7%D9%84%D8%A7%D8%AE-%D8%A7%D9%84%D8%B0%D9%8A-%D9%84%D8%A7-%D9%8A%D8%B5%D9%84%D9%8A', "added_from": None, "reason": "How to advise a brother who does not pray; practical family case, one of three kept leaving-prayer items."},
    {"id": '3005', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3005/%D8%AD%D9%83%D9%85-%D9%85%D9%86-%D9%86%D8%B3%D9%8A-%D9%82%D8%B1%D8%A7%D8%A1%D8%A9-%D8%A7%D9%84%D9%81%D8%A7%D8%AA%D8%AD%D8%A9', "added_from": 'fiqhi/34', "reason": "What to do if Al-Fatihah was forgotten in a rak'ah; short and simple."},
    {"id": '3521', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3521/%D8%AD%D9%83%D9%85-%D9%85%D9%86-%D9%86%D8%B3%D9%8A-%D8%A7%D9%84%D8%AA%D8%B3%D9%85%D9%8A%D8%A9-%D9%82%D8%A8%D9%84-%D8%A7%D9%84%D9%88%D8%B6%D9%88%D8%A1', "added_from": 'fiqhi/14', "reason": "Forgetting 'bismillah' before wudu does not spoil it; a simple, reassuring answer."},
    {"id": '3581', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3581/%D8%AD%D9%83%D9%85-%D8%A7%D9%84%D9%88%D8%B6%D9%88%D8%A1-%D8%A8%D8%A7%D9%84%D9%85%D8%A7%D8%A1-%D8%A7%D9%84%D9%85%D8%AE%D9%84%D9%88%D8%B7-%D8%A8%D8%A7%D9%84%D9%83%D9%84%D9%88%D8%B1', "added_from": 'fiqhi/14', "reason": "Chlorinated tap water is still valid for wudu; practical in many countries."},
    {"id": '3588', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3588/%D8%AD%D9%83%D9%85-%D8%A7%D9%84%D9%88%D8%B6%D9%88%D8%A1-%D8%AF%D8%A7%D8%AE%D9%84-%D8%A7%D9%84%D8%AD%D9%85%D8%A7%D9%85', "added_from": 'fiqhi/14', "reason": "Wudu inside a bathroom is allowed when needed, with where to say the basmala and the shahada; practical for modern homes."},
    {"id": '3594', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3594/%D9%87%D9%84-%D9%8A%D8%B4%D8%AA%D8%B1%D8%B7-%D8%A7%D9%84%D8%A7%D8%B3%D8%AA%D9%86%D8%AC%D8%A7%D8%A1-%D9%84%D9%83%D9%84-%D9%88%D8%B6%D9%88%D8%A1', "added_from": 'fiqhi/14', "reason": "Istinja is not needed before every wudu; explains when it is needed and lists the wudu steps."},
    {"id": '3611', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3611/%D8%AD%D9%83%D9%85-%D8%A7%D8%B3%D8%AA%D8%B9%D9%85%D8%A7%D9%84-%D8%A7%D9%84%D9%85%D9%86%D8%A7%D9%83%D9%8A%D8%B1-%D9%88%D9%87%D9%84-%D8%AA%D8%AC%D8%A8-%D8%A7%D8%B2%D8%A7%D9%84%D8%AA%D9%87-%D8%B9%D9%86%D8%AF-%D8%A7%D9%84%D9%88%D8%B6%D9%88%D8%A1', "added_from": 'fiqhi/14', "reason": "Nail polish must be removed for wudu because it stops water reaching the nail; common question for women."},
    {"id": '3649', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3649/%D8%B5%D9%81%D8%A9-%D9%88%D8%B6%D9%88%D8%A1-%D8%A7%D9%84%D9%86%D8%A8%D9%8A-%D8%B5%D9%84%D9%89-%D8%A7%D9%84%D9%84%D9%87-%D8%B9%D9%84%D9%8A%D9%87-%D9%88%D8%B3%D9%84%D9%85', "added_from": 'fiqhi/14', "reason": "How the Prophet performed wudu, step by step, and the two rak'ahs after it; core practical purification."},
    {"id": '3650', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3650/%D9%87%D9%84-%D9%8A%D8%B4%D8%AA%D8%B1%D8%B7-%D9%84%D8%B5%D8%A7%D8%AD%D8%A8-%D8%A7%D9%84%D9%84%D8%AD%D9%8A%D8%A9-%D8%A7%D9%84%D9%83%D8%AB%D9%8A%D9%81%D8%A9-%D9%88%D8%B5%D9%88%D9%84-%D8%A7%D9%84%D9%85%D8%A7%D8%A1-%D9%84%D9%85%D9%86%D8%A7%D8%A8%D8%AA-%D8%A7%D9%84%D8%B4%D8%B9%D8%B1', "added_from": 'fiqhi/14', "reason": "For a thick beard it is enough to pass water over it; short practical wudu detail."},
    {"id": '3709', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3709/%D8%AA%D9%88%D8%AC%D9%8A%D9%87-%D9%84%D9%85%D9%86-%D9%84%D8%A7-%D9%8A%D8%AD%D8%B3-%D8%A8%D8%A7%D9%84%D8%B1%D8%A7%D8%AD%D8%A9-%D9%81%D9%8A-%D8%B5%D9%84%D8%A7%D8%AA%D9%87', "added_from": None, "reason": "Guidance for someone who feels no comfort in prayer; a common struggle for new Muslims."},
    {"id": '3805', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3805/%D8%A7%D9%84%D8%BA%D8%B3%D9%84-%D9%8A%D9%88%D9%85-%D8%A7%D9%84%D8%AC%D9%85%D8%B9%D8%A9-%D8%B3%D9%86%D8%A9-%D9%85%D9%88%D9%83%D8%AF%D8%A9', "added_from": 'fiqhi/18', "reason": "The Friday ghusl is a confirmed sunnah, not an obligation."},
    {"id": '3807', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3807/%D8%A7%D9%84%D8%BA%D8%B3%D9%84-%D9%85%D9%86-%D8%A7%D9%84%D8%AC%D9%86%D8%A7%D8%A8%D8%A9-%D9%88%D8%BA%D9%8A%D8%B1%D9%87%D8%A7-%D9%87%D9%84-%D9%8A%D8%AC%D8%B2%D9%89-%D8%B9%D9%86-%D8%A7%D9%84%D9%88%D8%B6%D9%88%D8%A1', "added_from": 'fiqhi/18', "reason": "A ghusl for janabah counts for wudu when both are intended; soap and shampoo are fine."},
    {"id": '3814', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3814/%D8%AD%D9%83%D9%85-%D8%A7%D9%84%D8%BA%D8%B3%D9%84-%D9%85%D9%86-%D8%A7%D9%84%D8%A7%D8%AD%D8%AA%D9%84%D8%A7%D9%85-%D8%A7%D9%84%D8%B0%D9%8A-%D9%84%D8%A7-%D9%8A%D8%AC%D8%AF-%D9%84%D9%87-%D8%A7%D8%AB%D8%B1%D8%A7', "added_from": 'fiqhi/18', "reason": "Ghusl after a wet dream is required only when fluid is found; basic ghusl rule."},
    {"id": '3829', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3829/%D9%83%D9%8A%D9%81-%D9%8A%D8%AA%D9%8A%D9%85%D9%85-%D8%A7%D9%84%D9%85%D8%B1%D9%8A%D8%B6', "added_from": 'fiqhi/19', "reason": "How a sick person who cannot make wudu does tayammum, and that the prayer is still due; practical for illness."},
    {"id": '3859', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3859/%D9%85%D8%A7-%D9%8A%D9%84%D8%B2%D9%85-%D9%85%D9%86-%D9%83%D8%A7%D9%86%D8%AA-%D8%AD%D8%A7%D9%85%D9%84%D8%A7-%D9%81%D8%AA%D8%B1%D9%83%D8%AA-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9-%D8%A8%D8%B3%D8%A8%D8%A8-%D8%B3%D9%8A%D9%84%D8%A7%D9%86-%D8%A7%D9%84%D8%A8%D9%88%D9%84', "added_from": None, "reason": "A pregnant woman with continuous urine leakage still prays, making wudu for each prayer time; shows how prayer adapts to hardship."},
    {"id": '3958', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3958/%D8%AA%D8%A7%D8%AE%D9%8A%D8%B1-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9-%D8%B9%D9%86-%D9%88%D9%82%D8%AA%D9%87%D8%A7-%D8%A8%D8%B3%D8%A8%D8%A8-%D8%A7%D9%84%D8%B9%D9%85%D9%84', "added_from": 'fiqhi/27', "reason": "Workers may pray a little after the start of the time when needed, though the start is better; practical at work."},
    {"id": '3961', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/3961/%D8%A7%D9%84%D9%88%D9%82%D8%AA-%D8%A7%D9%84%D8%B6%D8%B1%D9%88%D8%B1%D9%8A-%D9%84%D8%B5%D9%84%D8%A7%D8%A9-%D8%A7%D9%84%D8%B8%D9%87%D8%B1-%D9%88%D8%A7%D9%84%D8%B9%D8%B5%D8%B1-%D9%88%D8%A7%D9%84%D9%85%D8%BA%D8%B1%D8%A8', "added_from": 'fiqhi/27', "reason": "The preferred and necessary times of Dhuhr, Asr, Maghrib and the other prayers; prayer-time basics."},
    {"id": '10220', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/10220/%D8%AD%D9%83%D9%85-%D9%85%D9%86-%D9%86%D9%88%D9%89-%D8%A7%D9%84%D8%B5%D9%8A%D8%A7%D9%85-%D9%88%D9%84%D9%85-%D9%8A%D8%AA%D8%B3%D8%AD%D8%B1', "added_from": 'fiqhi/88', "reason": "A fast is valid without suhoor when the intention is there; simple fasting basic."},
    {"id": '11287', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/11287/%D9%85%D8%A7-%D9%85%D8%B9%D9%86%D9%89-%D9%81%D9%8A-%D8%A7%D9%84%D8%AC%D9%86%D8%A9-%D8%A8%D8%A7%D8%A8-%D9%8A%D9%82%D8%A7%D9%84-%D9%84%D9%87-%D8%A7%D9%84%D8%B1%D9%8A%D8%A7%D9%86', "added_from": 'fiqhi/77', "reason": "Explains the gate of Ar-Rayyan for those who fast; a motivating introduction to fasting."},
    {"id": '18397', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/18397/%D9%83%D9%8A%D9%81%D9%8A%D8%A9-%D8%AA%D8%A8%D9%8A%D9%8A%D8%AA-%D8%A7%D9%84%D9%86%D9%8A%D8%A9-%D9%81%D9%8A-%D8%A7%D9%84%D8%B5%D9%8A%D8%A7%D9%85', "added_from": 'fiqhi/88', "reason": "How to make the night intention for the Ramadan fast; fasting basics."},
    {"id": '19825', "topic": 'worship', "url": 'https://binbaz.org.sa/fatwas/19825/%D8%AD%D9%83%D9%85-%D9%82%D8%B1%D8%A7%D8%A1%D8%A9-%D8%A7%D9%84%D9%82%D8%B1%D8%A7%D9%86-%D8%A7%D9%84%D9%83%D8%B1%D9%8A%D9%85-%D9%84%D9%85%D9%86-%D9%84%D8%A7-%D9%8A%D8%AC%D9%8A%D8%AF-%D9%82%D9%88%D8%A7%D8%B9%D8%AF-%D8%A7%D9%84%D9%84%D8%BA%D8%A9-%D8%A7%D9%84%D8%B9%D8%B1%D8%A8%D9%8A%D8%A9', "added_from": None, "reason": "User-provided example: someone who cannot read Arabic well keeps reading the Quran with a teacher; for beginners who cannot yet recite well."},
    {"id": '16', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/16/%D8%AD%D9%83%D9%85-%D9%82%D9%88%D9%84-%D8%A7%D9%84%D8%AA%D8%AE%D9%84%D9%82-%D8%A8%D8%A7%D8%B3%D9%85%D8%A7%D8%A1-%D8%A7%D9%84%D9%84%D9%87-%D9%88%D8%B5%D9%81%D8%A7%D8%AA%D9%87', "added_from": None, "reason": "Says the expression 'taking on the character of God's names' is not an appropriate phrase, then allows one qualified meaning: acquiring, within the limits of the Sharia, a share of qualities God loves in His servants (knowledge, mercy, forbearance, generosity, pardon), never the attributes that belong to God alone; best read with a teacher."},
    {"id": '854', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/854/%D8%AA%D8%BA%D9%8A%D9%8A%D8%B1-%D8%A7%D9%84%D8%A7%D8%B3%D9%85-%D8%A8%D8%B9%D8%AF-%D8%A7%D8%B9%D8%AA%D9%86%D8%A7%D9%82-%D8%A7%D9%84%D8%A7%D8%B3%D9%84%D8%A7%D9%85', "added_from": None, "reason": "A new Muslim need not change their name unless it means servitude to other than God; directly relevant to converts."},
    {"id": '931', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/931/%D8%AD%D9%83%D9%85-%D8%A7%D9%84%D9%82%D9%8A%D8%A7%D9%85-%D9%84%D9%84%D9%82%D8%A7%D8%AF%D9%85', "added_from": None, "reason": "Distinguishes kinds of standing: rising to meet, greet or shake hands with someone who arrives is good manners; standing over a seated person to venerate him is not allowed, and standing only to honour someone's entry without meeting him is at least disliked; everyday etiquette with clear limits."},
    {"id": '994', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/994/%D9%83%D9%8A%D9%81-%D8%AA%D9%83%D9%88%D9%86-%D8%B5%D9%84%D8%A9-%D8%A7%D9%84%D8%B1%D8%AD%D9%85-%D9%88%D9%85%D8%A7-%D9%87%D9%88-%D8%AD%D8%AF-%D8%A7%D9%84%D9%82%D8%B7%D9%8A%D8%B9%D8%A9', "added_from": None, "reason": "How to keep ties of kinship (kind words, greeting, helping) and that there is no fixed visiting limit."},
    {"id": '1061', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1061/%D9%87%D9%84-%D8%AA%D8%AD%D9%84-%D8%A7%D9%84%D8%B2%D9%83%D8%A7%D8%A9-%D8%B9%D9%84%D9%89-%D8%A7%D9%84%D9%88%D8%A7%D9%81%D8%AF%D9%8A%D9%86-%D9%84%D8%B6%D8%B9%D9%81-%D8%B1%D9%88%D8%A7%D8%AA%D8%A8%D9%87%D9%85', "added_from": None, "reason": "Zakat may go to Muslim workers whose wages do not cover their needs; a simple zakat case."},
    {"id": '1066', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1066/%D9%85%D8%A7-%D9%8A%D9%81%D8%B9%D9%84-%D9%85%D9%86-%D9%88%D8%AC%D8%AF-%D8%B6%D8%A7%D9%84%D8%A9-%D8%A7%D9%84%D8%BA%D9%86%D9%85', "added_from": None, "reason": "What to do with stray sheep one finds: announce them for a year; honesty with lost property."},
    {"id": '1241', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1241/%D8%AD%D9%83%D9%85-%D8%A7%D9%84%D8%A7%D8%AD%D8%AA%D8%AC%D8%A7%D9%85-%D9%84%D9%84%D8%B5%D8%A7%D9%89%D9%85', "added_from": None, "reason": "Explains the scholarly difference on cupping while fasting; a secondary fasting detail."},
    {"id": '1242', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1242/%D8%A7%D8%AC%D9%88%D8%A8%D8%A9-%D9%85%D9%81%D9%8A%D8%AF%D8%A9-%D8%AA%D8%AA%D8%B9%D9%84%D9%82-%D8%A8%D8%A7%D9%84%D8%B1%D9%88%D9%8A%D8%A7-%D9%88%D8%A7%D9%84%D8%B5%D9%88%D9%85-%D8%B9%D9%86-%D8%A7%D9%84%D9%85%D9%8A%D8%AA', "added_from": None, "reason": "Answers on disliked dreams and fasting on behalf of the deceased; practical family questions."},
    {"id": '1261', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1261/%D8%B7%D8%A7%D8%B9%D8%A9-%D8%A7%D9%84%D9%88%D8%A7%D9%84%D8%AF-%D8%A8%D8%A7%D9%84%D9%85%D8%B9%D8%B1%D9%88%D9%81', "added_from": None, "reason": "Obey a father in what is right and advise him gently when he errs."},
    {"id": '1265', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1265/%D9%88%D8%A7%D9%84%D8%AF%D8%AA%D9%87%D8%A7-%D8%AA%D8%B7%D9%84%D8%A8-%D9%85%D9%86%D9%87%D8%A7-%D8%AA%D8%B1%D9%83-%D8%A7%D9%84%D8%AD%D8%AC%D8%A7%D8%A8', "added_from": None, "reason": "A daughter keeps her hijab while staying kind to a mother who objects; relevant to converts with non-practising family."},
    {"id": '1283', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1283/%D8%A7%D9%84%D9%86%D9%81%D9%82%D8%A9-%D8%B9%D9%84%D9%89-%D8%A7%D9%84%D8%A7%D9%88%D9%84%D8%A7%D8%AF-%D8%A8%D8%B9%D8%AF-%D8%B7%D9%84%D8%A7%D9%82-%D8%A7%D9%85%D9%87%D9%85', "added_from": None, "reason": "Child maintenance after divorce is settled by agreement or the court; family case."},
    {"id": '1287', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1287/%D8%AD%D9%83%D9%85-%D8%AA%D8%B7%D9%84%D9%8A%D9%82-%D8%A7%D9%84%D8%B2%D9%88%D8%AC%D8%A9-%D8%A8%D8%B3%D8%A8%D8%A8-%D9%83%D8%B3%D9%84%D9%87%D8%A7', "added_from": None, "reason": "Advises patience and helping at home rather than divorcing a wife for some laziness."},
    {"id": '1313', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1313/%D9%87%D9%84-%D9%8A%D8%AC%D9%88%D8%B2-%D8%A7%D9%84%D8%B3%D9%84%D8%A7%D9%85-%D8%B9%D9%84%D9%89-%D8%A7%D9%84%D9%86%D8%B3%D8%A7%D8%A1', "added_from": None, "reason": "Greeting women with salam is permitted; short everyday etiquette."},
    {"id": '1338', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1338/%D8%AD%D9%83%D9%85-%D9%85%D9%86-%D8%B9%D8%AC%D8%B2-%D8%B9%D9%86-%D8%A7%D9%84%D9%88%D9%81%D8%A7%D8%A1-%D8%A8%D8%A7%D9%84%D9%86%D8%B0%D8%B1', "added_from": None, "reason": "What to do when unable to fulfil a vow to slaughter; keeping commitments."},
    {"id": '1342', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1342/%D8%A7%D9%84%D8%B0%D8%A8%D8%AD-%D8%B9%D9%86%D8%AF-%D8%A7%D9%86%D8%AA%D8%B5%D8%A7%D9%81-%D8%A7%D9%84%D8%A8%D9%86%D8%A7%D8%A1-%D8%A7%D9%88-%D8%A7%D9%83%D8%AA%D9%85%D8%A7%D9%84%D9%87', "added_from": None, "reason": "Slaughtering when building a house: fine as hospitality, forbidden if meant to ward off jinn; separates custom from shirk."},
    {"id": '1363', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1363/%D8%AD%D9%83%D9%85-%D8%B7%D8%A7%D8%B9%D8%A9-%D8%A7%D9%84%D9%88%D8%A7%D9%84%D8%AF-%D8%A7%D8%B0%D8%A7-%D8%A7%D9%85%D8%B1-%D9%88%D9%84%D8%AF%D9%87-%D8%A7%D9%84%D8%A7-%D9%8A%D8%B2%D9%88%D8%B1-%D8%A7%D8%AD%D8%AF-%D8%A7%D9%82%D8%A7%D8%B1%D8%A8%D9%87', "added_from": None, "reason": "Do not obey a father who orders cutting ties with an uncle over a worldly dispute."},
    {"id": '1391', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1391/%D9%85%D8%A7%D8%B0%D8%A7-%D9%8A%D9%82%D9%88%D9%84-%D9%85%D9%86-%D9%8A%D8%B1%D9%89-%D8%B1%D9%88%D9%8A%D8%A7-%D9%84%D8%A7-%D8%AA%D8%B3%D8%B1%D9%87', "added_from": None, "reason": "What to do after a bad dream: spit lightly to the left and seek refuge in God."},
    {"id": '1524', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1524/%D8%A8%D9%8A%D8%A7%D9%86-%D8%A7%D9%86-%D8%A7%D9%84%D8%B1%D9%88%D9%89-%D8%A7%D9%84%D9%85%D9%83%D8%B1%D9%88%D9%87%D8%A9-%D9%85%D9%86-%D8%A7%D9%84%D8%B4%D9%8A%D8%B7%D8%A7%D9%86', "added_from": None, "reason": "Disliked dreams come from Satan and should not be told; overlaps 1391 but adds what not to do."},
    {"id": '1533', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1533/%D8%AD%D9%83%D9%85-%D8%A7%D9%84%D9%85%D8%B9%D8%A7%D9%86%D9%82%D8%A9-%D9%81%D9%8A-%D8%A7%D9%84%D8%A7%D8%B9%D9%8A%D8%A7%D8%AF', "added_from": None, "reason": "Hugging on Eid is a custom; the sunnah is to pray for acceptance of each other's deeds."},
    {"id": '1587', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1587/%D8%AD%D9%83%D9%85-%D8%B7%D8%A7%D8%B9%D8%A9-%D8%A7%D9%84%D9%88%D8%A7%D9%84%D8%AF%D9%8A%D9%86-%D9%81%D9%8A-%D8%B9%D8%AF%D9%85-%D8%A7%D8%AF%D8%A7%D8%A1-%D8%A7%D9%84%D8%B9%D9%85%D8%B1%D8%A9', "added_from": None, "reason": "Parents are not obeyed in forbidding good companions and Umrah; the limits of obedience."},
    {"id": '1628', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1628/%D8%AD%D9%83%D9%85-%D8%A7%D9%84%D9%86%D8%B8%D8%B1-%D8%A7%D9%84%D9%89-%D8%A7%D9%84%D9%85%D8%AE%D8%B7%D9%88%D8%A8%D8%A9-%D9%88%D8%B6%D9%88%D8%A7%D8%A8%D8%B7-%D8%B0%D9%84%D9%83', "added_from": None, "reason": "A suitor may look at the woman he proposes to, without being alone with her."},
    {"id": '1665', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/1665/%D9%83%D9%8A%D9%81%D9%8A%D8%A9-%D8%B5%D9%88%D9%85-%D9%85%D9%86-%D9%84%D8%A7-%D9%8A%D8%B3%D8%AA%D8%B7%D9%8A%D8%B9-%D8%A7%D9%84%D9%86%D9%83%D8%A7%D8%AD', "added_from": None, "reason": "Explains the hadith advising young people to marry or else fast; guidance for youth."},
    {"id": '6816', "topic": 'conduct', "url": 'https://binbaz.org.sa/fatwas/6816/%D8%AD%D9%83%D9%85-%D8%A7%D9%84%D8%A7%D8%AE%D8%B0-%D9%85%D9%86-%D9%85%D8%A7%D9%84-%D8%A7%D9%84%D8%A7%D8%A8-%D8%A7%D9%88-%D8%A7%D9%84%D8%A7%D9%85-%D8%A8%D8%BA%D9%8A%D8%B1-%D8%A7%D8%B0%D9%86%D9%87%D9%85%D8%A7', "added_from": 'objective/370', "reason": "A child must return the change from a parent's money and not take it without permission; honesty within the family."},
]
REPLACED = [
    {"id": "binbaz-1215", "title": "مناصحة تاركي الصلاة المجاورين للمساجد", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/1215/%D9%85%D9%86%D8%A7%D8%B5%D8%AD%D8%A9-%D8%AA%D8%A7%D8%B1%D9%83%D9%8A-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9-%D8%A7%D9%84%D9%85%D8%AC%D8%A7%D9%88%D8%B1%D9%8A%D9%86-%D9%84%D9%84%D9%85%D8%B3%D8%A7%D8%AC%D8%AF', "reason": "Leaving-prayer cluster: urging imams and committees about absentees; not a beginner path."},
    {"id": "binbaz-1235", "title": "هل يجوز الأكل من ذبيحة تارك الصلاة؟", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/1235/%D9%87%D9%84-%D9%8A%D8%AC%D9%88%D8%B2-%D8%A7%D9%84%D8%A7%D9%83%D9%84-%D9%85%D9%86-%D8%B0%D8%A8%D9%8A%D8%AD%D8%A9-%D8%AA%D8%A7%D8%B1%D9%83-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9', "reason": "Leaving-prayer cluster: meat slaughtered by someone who does not pray; consequence ruling."},
    {"id": "binbaz-1403", "title": "حكم ترك الصلاة مع الإقرار بوجوبها", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/1403/%D8%AD%D9%83%D9%85-%D8%AA%D8%B1%D9%83-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9-%D9%85%D8%B9-%D8%A7%D9%84%D8%A7%D9%82%D8%B1%D8%A7%D8%B1-%D8%A8%D9%88%D8%AC%D9%88%D8%A8%D9%87%D8%A7', "reason": "Leaving-prayer cluster: eating and sitting with someone who does not pray; consequence ruling."},
    {"id": "binbaz-1522", "title": "كيف تكون النصيحة والمعاملة لتاركي الصلاة؟", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/1522/%D9%83%D9%8A%D9%81-%D8%AA%D9%83%D9%88%D9%86-%D8%A7%D9%84%D9%86%D8%B5%D9%8A%D8%AD%D8%A9-%D9%88%D8%A7%D9%84%D9%85%D8%B9%D8%A7%D9%85%D9%84%D8%A9-%D9%84%D8%AA%D8%A7%D8%B1%D9%83%D9%8A-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9', "reason": "Leaving-prayer cluster: public measures against those who abandon prayer; not beginner-facing."},
    {"id": "binbaz-2070", "title": "من لم يكفر الكافر فهو مثله", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/2070/%D9%85%D9%86-%D9%84%D9%85-%D9%8A%D9%83%D9%81%D8%B1-%D8%A7%D9%84%D9%83%D8%A7%D9%81%D8%B1-%D9%81%D9%87%D9%88-%D9%85%D8%AB%D9%84%D9%87', "reason": "Leaving-prayer cluster: judging those who do not declare the non-praying a disbeliever; advanced."},
    {"id": "binbaz-2187", "title": "حكم معايشة أشخاص لا يحافظون على الصلاة", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/2187/%D8%AD%D9%83%D9%85-%D9%85%D8%B9%D8%A7%D9%8A%D8%B4%D8%A9-%D8%A7%D8%B4%D8%AE%D8%A7%D8%B5-%D9%84%D8%A7-%D9%8A%D8%AD%D8%A7%D9%81%D8%B8%D9%88%D9%86-%D8%B9%D9%84%D9%89-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9', "reason": "Leaving-prayer cluster: leaving a family that does not pray; personal case, unsuitable as a default for new Muslims living with non-Muslim families."},
    {"id": "binbaz-2316", "title": "حكم صلة الصديق الذي لا يؤدي الصلاة ولا يصوم رمضان", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/2316/%D8%AD%D9%83%D9%85-%D8%B5%D9%84%D8%A9-%D8%A7%D9%84%D8%B5%D8%AF%D9%8A%D9%82-%D8%A7%D9%84%D8%B0%D9%8A-%D9%84%D8%A7-%D9%8A%D9%88%D8%AF%D9%8A-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9-%D9%88%D9%84%D8%A7-%D9%8A%D8%B5%D9%88%D9%85-%D8%B1%D9%85%D8%B6%D8%A7%D9%86', "reason": "Leaving-prayer cluster: boycotting a friend who does not pray; consequence ruling."},
    {"id": "binbaz-2471", "title": "حكم من ترك الصلاة تكاسلاً", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/2471/%D8%AD%D9%83%D9%85-%D9%85%D9%86-%D8%AA%D8%B1%D9%83-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9-%D8%AA%D9%83%D8%A7%D8%B3%D9%84%D8%A7', "reason": "Leaving-prayer cluster: repeats the ruling kept in 2778."},
    {"id": "binbaz-2497", "title": "حكـم صيـام مـن لا يصـلي إلا في رمضـان", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/2497/%D8%AD%D9%83%D9%80%D9%85-%D8%B5%D9%8A%D9%80%D8%A7%D9%85-%D9%85%D9%80%D9%86-%D9%84%D8%A7-%D9%8A%D8%B5%D9%80%D9%84%D9%8A-%D8%A7%D9%84%D8%A7-%D9%81%D9%8A-%D8%B1%D9%85%D8%B6%D9%80%D8%A7%D9%86', "reason": "Leaving-prayer cluster: the fast of someone who does not pray; consequence ruling."},
    {"id": "binbaz-2797", "title": "ما الواجب تجاه من لا يصلي؟", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/2797/%D9%85%D8%A7-%D8%A7%D9%84%D9%88%D8%A7%D8%AC%D8%A8-%D8%AA%D8%AC%D8%A7%D9%87-%D9%85%D9%86-%D9%84%D8%A7-%D9%8A%D8%B5%D9%84%D9%8A', "reason": "Leaving-prayer cluster: duty towards someone who does not pray; variant of the kept 2978."},
    {"id": "binbaz-3135", "title": "حكم الحاكم الذي لا يصلي", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/3135/%D8%AD%D9%83%D9%85-%D8%A7%D9%84%D8%AD%D8%A7%D9%83%D9%85-%D8%A7%D9%84%D8%B0%D9%8A-%D9%84%D8%A7-%D9%8A%D8%B5%D9%84%D9%8A', "reason": "Leaving-prayer cluster: a ruler who does not pray; political, not beginner-facing."},
    {"id": "binbaz-3190", "title": "حكم إجابة دعوة تارك الصلاة للوليمة", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/3190/%D8%AD%D9%83%D9%85-%D8%A7%D8%AC%D8%A7%D8%A8%D8%A9-%D8%AF%D8%B9%D9%88%D8%A9-%D8%AA%D8%A7%D8%B1%D9%83-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9-%D9%84%D9%84%D9%88%D9%84%D9%8A%D9%85%D8%A9', "reason": "Leaving-prayer cluster: accepting a non-praying person's invitation; consequence ruling."},
    {"id": "binbaz-3275", "title": "إهداء الثواب للميت إذا كان مقرًا بالتوحيد ولكنه لا يصلي", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/3275/%D8%A7%D9%87%D8%AF%D8%A7%D8%A1-%D8%A7%D9%84%D8%AB%D9%88%D8%A7%D8%A8-%D9%84%D9%84%D9%85%D9%8A%D8%AA-%D8%A7%D8%B0%D8%A7-%D9%83%D8%A7%D9%86-%D9%85%D9%82%D8%B1%D8%A7-%D8%A8%D8%A7%D9%84%D8%AA%D9%88%D8%AD%D9%8A%D8%AF-%D9%88%D9%84%D9%83%D9%86%D9%87-%D9%84%D8%A7-%D9%8A%D8%B5%D9%84%D9%8A', "reason": "Leaving-prayer cluster: gifting reward to a deceased mother who did not pray; personal case."},
    {"id": "binbaz-3302", "title": "حكم مجالسة أقارب لا يصلون ودعاء الموتى", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/3302/%D8%AD%D9%83%D9%85-%D9%85%D8%AC%D8%A7%D9%84%D8%B3%D8%A9-%D8%A7%D9%82%D8%A7%D8%B1%D8%A8-%D9%84%D8%A7-%D9%8A%D8%B5%D9%84%D9%88%D9%86-%D9%88%D8%AF%D8%B9%D8%A7%D8%A1-%D8%A7%D9%84%D9%85%D9%88%D8%AA%D9%89', "reason": "Leaving-prayer cluster: cutting off relatives who do not pray; personal case and harsh as a default path."},
    {"id": "binbaz-3866", "title": "تارك الصلاة هل يبطل عقد نكاحه؟", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/3866/%D8%AA%D8%A7%D8%B1%D9%83-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9-%D9%87%D9%84-%D9%8A%D8%A8%D8%B7%D9%84-%D8%B9%D9%82%D8%AF-%D9%86%D9%83%D8%A7%D8%AD%D9%87', "reason": "Leaving-prayer cluster: marriage contract of someone who does not pray; advanced personal-status case."},
    {"id": "binbaz-2615", "title": "حكم التهاون في الصلاة بحجة العمل", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/2615/%D8%AD%D9%83%D9%85-%D8%A7%D9%84%D8%AA%D9%87%D8%A7%D9%88%D9%86-%D9%81%D9%8A-%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9-%D8%A8%D8%AD%D8%AC%D8%A9-%D8%A7%D9%84%D8%B9%D9%85%D9%84', "reason": "Leaving-prayer cluster: work as an excuse to miss prayer; replaced by the practical 3958."},
    {"id": "binbaz-2354", "title": "معنى «تنقض عرى الإسلام عروة عروة»", "topic": 'worship', "source_url": 'https://binbaz.org.sa/fatwas/2354/%D9%85%D8%B9%D9%86%D9%89-%D8%AA%D9%86%D9%82%D8%B6-%D8%B9%D8%B1%D9%89-%D8%A7%D9%84%D8%A7%D8%B3%D9%84%D8%A7%D9%85-%D8%B9%D8%B1%D9%88%D8%A9-%D8%B9%D8%B1%D9%88%D8%A9', "reason": "Hadith commentary on the bonds of Islam being undone; advanced, not a beginner path."},
    {"id": "binbaz-6836", "title": "معنى الركن الأول من أركان الإسلام", "topic": 'understanding_islam', "source_url": 'https://binbaz.org.sa/fatwas/6836/%D9%85%D8%B9%D9%86%D9%89-%D8%A7%D9%84%D8%B1%D9%83%D9%86-%D8%A7%D9%84%D8%A7%D9%88%D9%84-%D9%85%D9%86-%D8%A7%D8%B1%D9%83%D8%A7%D9%86-%D8%A7%D9%84%D8%A7%D8%B3%D9%84%D8%A7%D9%85', "reason": "Same text as 1996 (meaning of the first pillar)."},
    {"id": "binbaz-6838", "title": "حكم مرتكب الكبيرة في الإسلام", "topic": 'understanding_islam', "source_url": 'https://binbaz.org.sa/fatwas/6838/%D8%AD%D9%83%D9%85-%D9%85%D8%B1%D8%AA%D9%83%D8%A8-%D8%A7%D9%84%D9%83%D8%A8%D9%8A%D8%B1%D8%A9-%D9%81%D9%8A-%D8%A7%D9%84%D8%A7%D8%B3%D9%84%D8%A7%D9%85', "reason": "Same text as 1157 (major sins and Islam)."},
    {"id": "binbaz-6839", "title": "حكم الاكتفاء بالنطق والاعتقاد في الشهادتين", "topic": 'understanding_islam', "source_url": 'https://binbaz.org.sa/fatwas/6839/%D8%AD%D9%83%D9%85-%D8%A7%D9%84%D8%A7%D9%83%D8%AA%D9%81%D8%A7%D8%A1-%D8%A8%D8%A7%D9%84%D9%86%D8%B7%D9%82-%D9%88%D8%A7%D9%84%D8%A7%D8%B9%D8%AA%D9%82%D8%A7%D8%AF-%D9%81%D9%8A-%D8%A7%D9%84%D8%B4%D9%87%D8%A7%D8%AF%D8%AA%D9%8A%D9%86', "reason": "Same text as 1998 (is the shahada enough)."},
    {"id": "binbaz-2350", "title": "التوحيـد أولًا", "topic": 'belief', "source_url": 'https://binbaz.org.sa/fatwas/2350/%D8%A7%D9%84%D8%AA%D9%88%D8%AD%D9%8A%D9%80%D8%AF-%D8%A7%D9%88%D9%84%D8%A7', "reason": "Same text as 1263 (what brings a person into Islam)."},
    {"id": "binbaz-6840", "title": "مظاهر مصداقية النطق بالشهادتين", "topic": 'belief', "source_url": 'https://binbaz.org.sa/fatwas/6840/%D9%85%D8%B8%D8%A7%D9%87%D8%B1-%D9%85%D8%B5%D8%AF%D8%A7%D9%82%D9%8A%D8%A9-%D8%A7%D9%84%D9%86%D8%B7%D9%82-%D8%A8%D8%A7%D9%84%D8%B4%D9%87%D8%A7%D8%AF%D8%AA%D9%8A%D9%86', "reason": "Same answer as 1158 (belief with the shahada)."},
    {"id": "binbaz-1659", "title": "لا إكراه في قبول الإسلام", "topic": 'understanding_islam', "source_url": 'https://binbaz.org.sa/fatwas/1659/%D9%84%D8%A7-%D8%A7%D9%83%D8%B1%D8%A7%D9%87-%D9%81%D9%8A-%D9%82%D8%A8%D9%88%D9%84-%D8%A7%D9%84%D8%A7%D8%B3%D9%84%D8%A7%D9%85', "reason": "Jizya and compulsion in religion; advanced political ruling, not a beginner path."},
    {"id": "binbaz-924", "title": "وجوب العدل بين العامل المسلم وغيره", "topic": 'conduct', "source_url": 'https://binbaz.org.sa/fatwas/924/%D9%88%D8%AC%D9%88%D8%A8-%D8%A7%D9%84%D8%B9%D8%AF%D9%84-%D8%A8%D9%8A%D9%86-%D8%A7%D9%84%D8%B9%D8%A7%D9%85%D9%84-%D8%A7%D9%84%D9%85%D8%B3%D9%84%D9%85-%D9%88%D8%BA%D9%8A%D8%B1%D9%87', "reason": "Preferring a Muslim worker and sending non-Muslims away; personal-case ruling unsuitable as a default for new Muslims."},
    {"id": "binbaz-987", "title": "حكم قيام الرجل لغيره", "topic": 'conduct', "source_url": 'https://binbaz.org.sa/fatwas/987/%D8%AD%D9%83%D9%85-%D9%82%D9%8A%D8%A7%D9%85-%D8%A7%D9%84%D8%B1%D8%AC%D9%84-%D9%84%D8%BA%D9%8A%D8%B1%D9%87', "reason": "Same question and answer as 931 (standing for someone who arrives)."},
    {"id": "binbaz-926", "title": "حكم تغيير الاسم بعد الإسلام", "topic": 'conduct', "source_url": 'https://binbaz.org.sa/fatwas/926/%D8%AD%D9%83%D9%85-%D8%AA%D8%BA%D9%8A%D9%8A%D8%B1-%D8%A7%D9%84%D8%A7%D8%B3%D9%85-%D8%A8%D8%B9%D8%AF-%D8%A7%D9%84%D8%A7%D8%B3%D9%84%D8%A7%D9%85', "reason": "Same issue as 854 (changing one's name after Islam)."},
]
CURATION_LISTINGS = ['https://binbaz.org.sa/categories/fiqhi/14/fatwa', 'https://binbaz.org.sa/categories/fiqhi/18/fatwa', 'https://binbaz.org.sa/categories/fiqhi/19/fatwa', 'https://binbaz.org.sa/categories/fiqhi/27/fatwa', 'https://binbaz.org.sa/categories/fiqhi/34/fatwa', 'https://binbaz.org.sa/categories/fiqhi/77/fatwa', 'https://binbaz.org.sa/categories/fiqhi/88/fatwa', 'https://binbaz.org.sa/categories/objective/370/fatwa']
LISTING_LINK = re.compile(r'<a\s+href="(https://binbaz\.org\.sa/fatwas/[1-9][0-9]*/[^"?#<>\s]+)"')
NOTICE = re.compile(r"جميع الحقوق محفوظة[^<]*")


class ImportFailure(Exception):
    pass


def listing_url(kind: str, cid: str, page: int) -> str:
    url = f"{BASE}/categories/{kind}/{cid}/fatwa"
    return url if page == 1 else f"{url}?page={page}"


def listing_links(doc: str) -> list[str]:
    links = []
    for start, end in _item_spans(doc):
        m = LISTING_LINK.search(doc, start, end)
        if m:
            links.append(m.group(1))
    return links


def _item_spans(doc: str) -> list[tuple[int, int]]:
    spans = []
    for m in fatwa._open_tags(doc, 0, len(doc)):
        if m.group(3).lower() == "article":
            classes = fatwa._attrs(m.group(4)).get("class", "").split()
            if "box__body__element" in classes and "fatwa" in classes:
                spans.append((m.end(), fatwa._close(doc, m, len(doc))[0]))
    return spans


def quotas_for(target: int) -> dict[str, int]:
    base, extra = divmod(target, len(fatwa.TOPICS))
    return {t: base + (1 if i < extra else 0) for i, t in enumerate(fatwa.TOPICS)}


def run(
    cache_dir: Path = CACHE_DIR,
    target_dir: Path = TARGET_DIR,
    *,
    offline: bool = False,
    target: int = 100,
    quotas: Optional[dict[str, int]] = None,
    categories: Optional[list[dict[str, str]]] = None,
    seeds: Optional[list[str]] = None,
    start_urls: Optional[list[str]] = None,
    max_pages: int = MAX_PAGES,
    transport: Optional[httpx.BaseTransport] = None,
    sleep: Callable[[float], None] = time.sleep,
    curated: Optional[list[dict[str, Any]]] = None,
    replaced: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    categories = CATEGORIES if categories is None else categories
    seeds = SEEDS if seeds is None else seeds
    start_urls = START_URLS if start_urls is None else start_urls
    if curated is not None:
        quotas = {t: sum(1 for c in curated if c["topic"] == t) for t in fatwa.TOPICS}
        target = len(curated) if target is None else target
    quotas = quotas_for(target) if quotas is None else dict(quotas)
    if sum(quotas.values()) != target:
        raise ImportFailure("topic quotas do not add up to the target")
    fetcher = Fetcher(Path(cache_dir), offline=offline, transport=transport, sleep=sleep)
    accepted: dict[str, dict[str, Any]] = {}
    raw: dict[str, str] = {}
    seen: set[str] = set()
    exclusions: list[dict[str, str]] = []
    counts = {t: 0 for t in fatwa.TOPICS}
    pages_log: list[dict[str, Any]] = []
    stats = {"cache_hits": 0, "fetched": 0, "duplicates_skipped": 0}
    notice: list[str] = []

    def get(url: str):
        item = fetcher.get(url)
        stats["cache_hits" if item.from_cache else "fetched"] += 1
        return item

    def consider(url: str, item: Any, topic: Optional[str]) -> None:
        number = fatwa.fatwa_id(url)
        if item.final_url != url and fatwa.fatwa_id(item.final_url) != number:
            exclusions.append({"url": url, "reason": f"redirected to a different record: {item.final_url[:160]}"})
            return
        try:
            doc = item.text()
            parsed = fatwa.parse_page(doc)
        except (UnicodeDecodeError, fatwa.SnapshotError) as e:
            exclusions.append({"url": url, "reason": f"page structure not recognised: {e}"})
            return
        if not notice:
            hit = NOTICE.search(doc)
            if hit:
                notice.append(" ".join(hit.group(0).split()))
        canonical = parsed["canonical"]
        if canonical and fatwa.fatwa_id(canonical) != number:
            exclusions.append({"url": url, "reason": "canonical link names a different fatwa"})
            return
        if topic is None:
            keys = [c["url"].split("/categories/", 1)[1] for c in parsed["categories"]]
            topic = next((SEED_TOPICS[k] for k in keys if k in SEED_TOPICS), None)
            if topic is None:
                exclusions.append({"url": url, "reason": "no mapped Balligh topic for its source categories"})
                return
        if counts[topic] >= quotas.get(topic, 0):
            return
        if not fatwa.has_body(parsed["question"], fatwa.QUESTION_LABEL):
            exclusions.append({"url": url, "reason": "the question block has no text beyond its label (no usable question on the page)"})
            return
        if not fatwa.has_body(parsed["answer"], fatwa.ANSWER_LABEL):
            exclusions.append({"url": url, "reason": "the answer block has no text beyond its label (audio/video-only page)"})
            return
        try:
            record = fatwa.build_record(parsed, url, item.retrieved_at, topic)
            fatwa.check_against_raw(record, parsed["article_html"])
            fatwa.validate_record(record)
        except fatwa.SnapshotError as e:
            exclusions.append({"url": url, "reason": f"completeness check failed: {e}"})
            return
        accepted[record["id"]] = record
        raw[record["id"]] = parsed["article_html"]
        counts[topic] += 1

    def candidates(urls: list[str]) -> list[str]:
        out = []
        for url in urls:
            number = fatwa.fatwa_id(url)
            if number is None:
                continue
            if number in seen:
                stats["duplicates_skipped"] += 1
                continue
            seen.add(number)
            out.append(url)
        return out

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            if curated is not None:
                for purl in CURATION_LISTINGS:
                    links = listing_links(get(purl).text())
                    pages_log.append({"url": purl, "links": len(links), "new": len(links)})
                picks = [(c["url"], c["topic"]) for c in curated]
                fresh = set(candidates([u for u, _ in picks]))
                picks = [p for p in picks if p[0] in fresh]
                for i in range(0, len(picks), 2):
                    batch = picks[i:i + 2]
                    for (url, topic), item in zip(batch, pool.map(get, [u for u, _ in batch])):
                        consider(url, item, topic)
                categories, seeds = [], []
            for url in candidates(list(seeds)):
                consider(url, get(url), None)
            for cat in categories:
                topic = cat["topic"]
                for page in range(1, max_pages + 1):
                    if counts[topic] >= quotas.get(topic, 0):
                        break
                    purl = listing_url(cat["kind"], cat["id"], page)
                    links = listing_links(get(purl).text())
                    fresh = candidates(links)
                    pages_log.append({"url": purl, "links": len(links), "new": len(fresh)})
                    if not links:
                        break
                    for i in range(0, len(fresh), 2):
                        if counts[topic] >= quotas.get(topic, 0):
                            break
                        batch = fresh[i:i + 2]
                        for url, item in zip(batch, pool.map(get, batch)):
                            consider(url, item, topic)
    except FetchError as e:
        fetcher.close()
        raise ImportFailure(f"fetch failed for {e.url[:200]}: {e}") from None
    fetcher.close()
    short = {t: quotas[t] - counts[t] for t in fatwa.TOPICS if counts[t] < quotas.get(t, 0)}
    if short or len(accepted) != target:
        raise ImportFailure(f"only {len(accepted)} of {target} fatwas passed the checks; short by topic: {short}")
    records = sorted(accepted.values(), key=lambda r: (fatwa.TOPICS.index(r["topic"]), int(r["source_record_id"])))
    selection = {
        "start_urls": list(start_urls),
        "seed_urls": list(seeds),
        "rationale": (
            "Beginner-relevant Ibn Baz fatwas: starting from the official category page 206 (الإسلام والإيمان), following official "
            "category links observed on binbaz.org.sa for belief, worship basics (prayer, wudu) and everyday conduct (manners, parents). "
            "Listing pages are read in site order; each fatwa is fetched from its full detail URL, deduplicated by numeric id, and kept only "
            "when the full question and answer pass the completeness checks. The two user-provided example fatwas are included as seeds."
        ),
        "categories": [{**c, "url": f"{BASE}/categories/{c['kind']}/{c['id']}"} for c in categories],
        "topic_map": {
            "rule": "listing records take the topic of the official category they were selected from; seed records take the topic of their first source category in seed_topics",
            "listing_categories": {f"{c['kind']}/{c['id']}": c["topic"] for c in categories},
            "seed_topics": dict(SEED_TOPICS),
        },
        "quotas": quotas,
        "listing_pages": pages_log,
        "failed_routes": FAILED_ROUTES,
    }
    reasons: dict[str, str] = {}
    if curated is not None:
        reasons = {f"binbaz-{c['id']}": c["reason"] for c in curated}
        selection.update({
            "start_urls": list(start_urls) + list(CURATION_LISTINGS),
            "rationale": (
                "Curated for a new Muslim or someone exploring Islam, and a teacher helping them (G4-A-P1 N10). The G4-A set was read "
                "record by record: the leaving-prayer consequence cluster was cut to three representative items, exact duplicates and "
                "advanced or personal-case rulings were replaced, and practical basics were added from official binbaz.org.sa category "
                "listings (wudu, ghusl, tayammum, prayer times, recitation in prayer, fasting intention, dutifulness to parents). Every "
                "record is fetched from its full detail URL and kept only when the full question, answer and notes pass the completeness "
                "checks; source text is never rewritten. Each index entry carries an English audience_reason."
            ),
            "mode": "curated",
            "curated_ids": [f"binbaz-{c['id']}" for c in curated],
            "added": [{"id": f"binbaz-{c['id']}", "from_category": c["added_from"]} for c in curated if c["added_from"]],
            "replaced": [dict(r) for r in (replaced or [])],
            "categories": selection["categories"] + [
                {"kind": u.split("/categories/")[1].split("/")[0], "id": u.split("/categories/")[1].split("/")[1], "url": u.rsplit("/fatwa", 1)[0]}
                for u in CURATION_LISTINGS
            ],
        })
    notices = [
        "Source: binbaz.org.sa (" + fatwa.PUBLISHER_NAME + "). Site footer notice: " + (notice[0] if notice else "not found on the fetched pages") + ".",
        "Reuse basis: user_confirmed_permission. The user reports email permission from the Ibn Baz website; it was not independently inspected by the importer. Attribution to the source page is required.",
        "Arabic only: the fatwa pages link no official translation of the same fatwa; translations are empty and nothing is machine-translated.",
        "Text is the page text: HTML entities decoded (U+00A0 kept), source-markup whitespace (newlines, tabs, indentation) collapsed to one space inside a paragraph and removed at paragraph edges, <br> stored as a newline. span.aaya -> quran, span.hadith -> hadith, strong/b -> strong; everything else is text. Scripts, styles, iframes, images, attributes and links are dropped.",
        "Footnotes: each item of the page's footnote list (section.footnotes li#footnote-N) is stored in notes as {id: N, runs} in source order, one note per item, never merged; an inline marker linked to an existing note (a[rel=footnote][href=#footnote-N]) is a noteref run whose text is the marker exactly as shown (for example [1]); a marker without a note stays plain text and is reported by the validator; a note without a marker is kept unreferenced. The audio player is ignored.",
        "Some pages draw honorifics with private-use characters (for example U+F055, U+F049, U+F074, U+F079 inside span.arabisque) that need the site's own icon font; they are kept unchanged as source text.",
        "review_status source_preserved: ingestion checks only, no human, scholarly or language review by Balligh.",
    ]
    files = fatwa.build_files(records, exclusions, selection, notices, reasons)
    summary = snapshot.publish(Path(target_dir), files, lambda p: fatwa.validate_fatwa_dir(p, raw=raw))
    return {
        **summary,
        "target": target,
        "network_requests": fetcher.network_requests,
        "fetched": stats["fetched"],
        "cache_hits": stats["cache_hits"],
        "duplicates_skipped": stats["duplicates_skipped"],
        "fetch_failures": fetcher.failures,
        "exclusion_list": exclusions,
        "listing_pages": pages_log,
        "index_sha256": snapshot.bytes_hash(files["index.json"]),
        "offline": offline,
    }


def refused_out(out: Path) -> Optional[str]:
    if snapshot.overlaps(out, LIVE_ROOT):
        return "refusing --out that is, contains or is inside content/library; import to staging and promote with the transaction tool"
    return None


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Import Ibn Baz fatwas into a staging collection")
    parser.add_argument("--out", type=Path, default=TARGET_DIR)
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args(argv)
    refusal = refused_out(args.out)
    if refusal:
        print(json.dumps({"ok": False, "error": refusal, "out": str(args.out)}, ensure_ascii=False, indent=1))
        return 2
    try:
        summary = run(CACHE_DIR, args.out, offline=args.offline, target=100, curated=CURATED, replaced=REPLACED)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False, indent=1))
        return 1
    if summary.get("count") != 100:
        print(json.dumps({"ok": False, "error": "published collection is not exactly 100 records"}, ensure_ascii=False, indent=1))
        return 1
    print(json.dumps({"ok": True, "out": str(Path(args.out).resolve()), **summary}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
