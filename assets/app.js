/* 勞動檢查違規查詢 — 前端 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const ARTICLES = window.LSA_ARTICLES || {};
  const PAGE_SIZE = 30;
  const ALL = "__all__";
  const OTHERS = "__others__";

  const state = {
    index: null,
    years: {},          // 西元年 → 解開後的紀錄陣列（快取）
    base: [],           // 符合地區、期間、產業、關鍵字的紀錄
    lawFilter: "",      // 條文篩選（如 "24"）
    entityFilter: "",   // 事業單位篩選
    industryPick: "",   // 由產業排行點選
    sort: { key: "date", dir: "desc" },
    page: 1,
  };

  /* ── 工具 ───────────────────────────── */
  const fmt = new Intl.NumberFormat("zh-TW");
  const roc = (ymd) => {
    const y = Math.floor(ymd / 10000), m = Math.floor(ymd / 100) % 100, d = ymd % 100;
    return `${y - 1911}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}`;
  };
  const money = (n) => {
    if (n >= 1e8) return `${(n / 1e8).toFixed(2)}<small>億元</small>`;
    if (n >= 1e4) return `${fmt.format(Math.round(n / 1e3) / 10)}<small>萬元</small>`;
    return `${fmt.format(n)}<small>元</small>`;
  };
  const moneyText = (n) => (n >= 1e4 ? `${fmt.format(Math.round(n / 1e3) / 10)} 萬元` : `${fmt.format(n)} 元`);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** 取出條文代碼：「勞動基準法第30條之1第1項」→ "30-1" */
  function articleKeys(lawStr) {
    const out = [];
    const re = /第\s*(\d+)\s*條(?:\s*之\s*(\d+))?/g;
    let m;
    while ((m = re.exec(lawStr))) out.push(m[2] ? `${m[1]}-${m[2]}` : m[1]);
    return out;
  }
  const articleLabel = (k) => `第 ${k.replace("-", " 條之 ")}${k.includes("-") ? "" : " 條"}`;

  /** 將名稱歸併為事業單位（去除負責人等附註） */
  function entityKey(name) {
    let s = name.replace(/\s/g, "").replace(/台/g, "臺");
    const m = s.match(/^(.*?(?:股份有限公司|有限公司|有限合夥))/);
    if (m) return m[1];
    s = s.replace(/_.*$/, "");
    const j = s.indexOf("即");
    if (j >= 0) s = s.slice(j + 1);
    s = s.replace(/[（(][^()（）]*[)）]?$/, "").replace(/[()（）]/g, "");
    return s || name;
  }

  /* ── 資料 ───────────────────────────── */
  async function loadJSON(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${url} 讀取失敗（${res.status}）`);
    return res.json();
  }

  async function loadYear(year) {
    if (state.years[year]) return state.years[year];
    const d = await loadJSON(`data/records/${year}.json`);
    const idx = state.index;
    const recs = d.rows.map((r) => {
      const laws = r[5].map((i) => d.laws[i]);
      const arts = [...new Set(laws.flatMap(articleKeys))];
      return {
        authority: idx.authorities[r[0]],
        date: r[1], announce: r[2], doc: r[3], name: r[4],
        laws, arts,
        texts: r[6].map((i) => d.texts[i]),
        amount: r[7], note: r[8],
        industry: r[9], org: r[10],
        entity: entityKey(r[4]),
      };
    });
    state.years[year] = recs;
    return recs;
  }

  /* ── 表單 ───────────────────────────── */
  function buildForm() {
    const idx = state.index;
    const county = $("county");
    const opt = (v, t) => `<option value="${esc(v)}">${esc(t)}</option>`;
    const others = idx.authorities.filter((a) => !idx.municipalities.includes(a) && !idx.counties.includes(a));
    county.innerHTML =
      opt(ALL, "全國（全部主管機關）") +
      `<optgroup label="直轄市">${idx.municipalities.map((a) => opt(a, a + "政府")).join("")}</optgroup>` +
      `<optgroup label="縣市">${idx.counties.map((a) => opt(a, a + "政府")).join("")}</optgroup>` +
      `<optgroup label="其他主管機關">${opt(OTHERS, "其他機關（全部）")}${others.map((a) => opt(a, a)).join("")}</optgroup>`;

    $("industry").innerHTML = opt("", "全部產業") + idx.industries.map((n, i) => opt(i, n)).join("");

    const years = Object.keys(idx.years).map(Number).sort();
    const yOpts = years.map((y) => opt(y, y - 1911)).join("");
    const mOpts = Array.from({ length: 12 }, (_, i) => opt(i + 1, i + 1)).join("");
    for (const id of ["fromY", "toY"]) $(id).innerHTML = yOpts;
    for (const id of ["fromM", "toM"]) $(id).innerHTML = mOpts;
    setDefaultRange();
  }

  function latestYM() {
    const years = Object.values(state.index.years);
    const max = Math.max(...years.map((y) => y.maxDate));
    return Math.floor(max / 100);
  }

  function setDefaultRange() {
    const to = latestYM();
    let fy = Math.floor(to / 100), fm = (to % 100) - 11;
    if (fm < 1) { fm += 12; fy -= 1; }
    const years = Object.keys(state.index.years).map(Number);
    if (fy < Math.min(...years)) { fy = Math.min(...years); fm = 1; }
    setYM("from", fy * 100 + fm);
    setYM("to", to);
  }

  const getYM = (p) => Number($(p + "Y").value) * 100 + Number($(p + "M").value);
  function setYM(p, ym) {
    $(p + "Y").value = String(Math.floor(ym / 100));
    $(p + "M").value = String(ym % 100);
  }

  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    const rocYM = (v) => {
      const m = /^(\d{2,3})(\d{2})$/.exec(v || "");
      return m ? (Number(m[1]) + 1911) * 100 + Number(m[2]) : 0;
    };
    if (h.get("c")) $("county").value = h.get("c");
    if (!$("county").value) $("county").value = ALL;
    if (rocYM(h.get("f")) && $("fromY").querySelector(`option[value="${Math.floor(rocYM(h.get("f")) / 100)}"]`)) setYM("from", rocYM(h.get("f")));
    if (rocYM(h.get("t")) && $("toY").querySelector(`option[value="${Math.floor(rocYM(h.get("t")) / 100)}"]`)) setYM("to", rocYM(h.get("t")));
    $("industry").value = h.get("i") || "";
    $("keyword").value = h.get("q") || "";
    state.lawFilter = h.get("law") || "";
    state.entityFilter = h.get("e") || "";
    return h.toString().length > 0;
  }

  function writeHash() {
    const toRoc = (ym) => `${Math.floor(ym / 100) - 1911}${String(ym % 100).padStart(2, "0")}`;
    const h = new URLSearchParams();
    h.set("c", $("county").value);
    h.set("f", toRoc(getYM("from")));
    h.set("t", toRoc(getYM("to")));
    if ($("industry").value !== "") h.set("i", $("industry").value);
    if ($("keyword").value.trim()) h.set("q", $("keyword").value.trim());
    if (state.lawFilter) h.set("law", state.lawFilter);
    if (state.entityFilter) h.set("e", state.entityFilter);
    history.replaceState(null, "", "#" + h.toString());
  }

  /* ── 查詢 ───────────────────────────── */
  async function runQuery() {
    const status = $("status");
    let from = getYM("from"), to = getYM("to");
    if (from > to) { [from, to] = [to, from]; setYM("from", from); setYM("to", to); }
    status.className = "status";
    status.textContent = "查詢中…";
    try {
      const years = [];
      for (let y = Math.floor(from / 100); y <= Math.floor(to / 100); y++) if (state.index.years[y]) years.push(y);
      const chunks = await Promise.all(years.map(loadYear));
      const county = $("county").value;
      const idx = state.index;
      const inCounty =
        county === ALL ? () => true
        : county === OTHERS ? (r) => !idx.municipalities.includes(r.authority) && !idx.counties.includes(r.authority)
        : (r) => r.authority === county;
      const ind = $("industry").value;
      const kw = $("keyword").value.trim().replace(/台/g, "臺");
      const lo = from * 100 + 1, hi = to * 100 + 31;
      state.base = chunks.flat().filter((r) =>
        r.date >= lo && r.date <= hi && inCounty(r) &&
        (ind === "" || r.industry === Number(ind)) &&
        (!kw || r.name.replace(/台/g, "臺").includes(kw)));
      state.page = 1;
      writeHash();
      render();
      status.textContent = "";
    } catch (err) {
      status.className = "status error";
      status.textContent = "資料讀取失敗：" + err.message;
    }
  }

  function filtered() {
    return state.base.filter((r) =>
      (!state.lawFilter || r.arts.includes(state.lawFilter)) &&
      (!state.entityFilter || r.entity === state.entityFilter) &&
      (state.industryPick === "" || r.industry === Number(state.industryPick)));
  }

  /* ── 呈現 ───────────────────────────── */
  function render() {
    $("results").hidden = false;
    const rows = filtered();

    // 概要
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const entities = new Set(rows.map((r) => r.entity)).size;
    $("tCount").innerHTML = `${fmt.format(rows.length)}<small>件</small>`;
    $("tEntities").innerHTML = `${fmt.format(entities)}<small>家</small>`;
    $("tAmount").innerHTML = money(total);
    $("tAvg").innerHTML = rows.length ? money(Math.round(total / rows.length)) : "—";
    const countyText = $("county").selectedOptions[0].textContent;
    const toRoc = (ym) => `民國 ${Math.floor(ym / 100) - 1911} 年 ${ym % 100} 月`;
    $("summarySub").textContent = `${countyText}｜${toRoc(getYM("from"))} 至 ${toRoc(getYM("to"))}（依處分日期）`;

    renderChips();
    renderIndustryRank();
    renderLawRank();
    renderRepeat(rows);
    renderDetail(rows);
  }

  function renderChips() {
    const chips = [];
    if (state.industryPick !== "") chips.push(["industryPick", "產業：" + state.index.industries[state.industryPick]]);
    if (state.lawFilter) chips.push(["lawFilter", "條文：" + articleLabel(state.lawFilter)]);
    if (state.entityFilter) chips.push(["entityFilter", "事業單位：" + state.entityFilter]);
    $("chips").innerHTML = chips.map(([k, t]) => `<button type="button" class="chip" data-k="${k}" title="移除此篩選">${esc(t)}</button>`).join("");
  }

  function rankItem({ key, title, desc, count, amount, max, active }) {
    const pct = max ? Math.max(1, (count / max) * 100) : 0;
    return `<li tabindex="0" role="button" data-key="${esc(key)}" class="${active ? "active" : ""}"
      aria-pressed="${active}" title="${esc(title)}：${fmt.format(count)} 件，罰鍰 ${moneyText(amount)}">
      <span class="name"><b>${esc(title)}</b>${desc ? `<span class="desc">${esc(desc)}</span>` : ""}</span>
      <span class="num"><span class="cnt">${fmt.format(count)}</span> 件<span class="amt">${moneyText(amount)}</span></span>
      <span class="bar" aria-hidden="true"><i style="width:${pct}%"></i></span></li>`;
  }

  function renderIndustryRank() {
    // 產業排行不受「產業點選」本身影響，其餘篩選照常
    const src = state.base.filter((r) =>
      (!state.lawFilter || r.arts.includes(state.lawFilter)) &&
      (!state.entityFilter || r.entity === state.entityFilter));
    const m = new Map();
    for (const r of src) {
      const e = m.get(r.industry) || { count: 0, amount: 0 };
      e.count++; e.amount += r.amount; m.set(r.industry, e);
    }
    // 「其他／無法判別」固定排最後，讓可辨識的產業排在前面
    const unknown = state.index.industries.length - 1;
    const list = [...m.entries()].sort((a, b) => (a[0] === unknown) - (b[0] === unknown) || b[1].count - a[1].count);
    const max = Math.max(0, ...list.map(([, v]) => v.count));
    const total = src.length || 1;
    $("industryRank").innerHTML = list.length
      ? list.map(([k, v]) => rankItem({
          key: k, title: state.index.industries[k],
          desc: `占 ${((v.count / total) * 100).toFixed(1)}%`,
          count: v.count, amount: v.amount, max,
          active: String(k) === String(state.industryPick),
        })).join("")
      : `<li class="empty">查無資料</li>`;
  }

  function renderLawRank() {
    const src = state.base.filter((r) =>
      (!state.entityFilter || r.entity === state.entityFilter) &&
      (state.industryPick === "" || r.industry === Number(state.industryPick)));
    const m = new Map();
    for (const r of src) for (const a of r.arts) {
      const e = m.get(a) || { count: 0, amount: 0 };
      e.count++; e.amount += r.amount; m.set(a, e);
    }
    const list = [...m.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 15);
    const max = list.length ? list[0][1].count : 0;
    $("lawRank").innerHTML = list.length
      ? list.map(([k, v]) => rankItem({
          key: k, title: articleLabel(k), desc: ARTICLES[k] || "",
          count: v.count, amount: v.amount, max, active: k === state.lawFilter,
        })).join("")
      : `<li class="empty">查無資料</li>`;
  }

  function renderRepeat(rows) {
    const m = new Map();
    for (const r of rows) {
      const e = m.get(r.entity) || { count: 0, amount: 0, last: 0, authorities: new Set(), industry: r.industry };
      e.count++; e.amount += r.amount; e.last = Math.max(e.last, r.date); e.authorities.add(r.authority);
      m.set(r.entity, e);
    }
    const list = [...m.entries()].filter(([, v]) => v.count >= 2)
      .sort((a, b) => b[1].count - a[1].count || b[1].amount - a[1].amount).slice(0, 30);
    $("repeatBody").innerHTML = list.length
      ? list.map(([k, v], i) => `<tr>
          <td data-label="#">${i + 1}</td>
          <td data-label="事業單位"><button type="button" class="company-btn" data-entity="${esc(k)}">${esc(k)}</button></td>
          <td data-label="地區">${esc([...v.authorities].join("、"))}</td>
          <td data-label="產業別"><span class="tag">${esc(state.index.industries[v.industry])}</span></td>
          <td data-label="次數" class="num"><span class="times">${v.count}</span></td>
          <td data-label="罰鍰合計" class="num money">${fmt.format(v.amount)}</td>
          <td data-label="最近處分" class="date">${roc(v.last)}</td></tr>`).join("")
      : `<tr><td colspan="7" class="empty">查詢期間內沒有重複違規的事業單位</td></tr>`;
  }

  function renderDetail(rows) {
    const { key, dir } = state.sort;
    const sgn = dir === "asc" ? 1 : -1;
    rows = rows.slice().sort((a, b) => sgn * (a[key] - b[key]) || b.date - a.date);
    document.querySelectorAll("th.sortable").forEach((th) => {
      th.classList.toggle("sort-asc", th.dataset.sort === key && dir === "asc");
      th.classList.toggle("sort-desc", th.dataset.sort === key && dir === "desc");
    });
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
    const slice = rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    $("detailSub").textContent = `共 ${fmt.format(rows.length)} 件，每頁 ${PAGE_SIZE} 件`;
    $("detailBody").innerHTML = slice.length
      ? slice.map((r) => `<tr>
          <td data-label="處分日期" class="date">${roc(r.date)}</td>
          <td data-label="地區">${esc(r.authority)}</td>
          <td data-label="事業單位"><span class="company">${esc(r.name)}</span><span class="doc">${esc(r.doc)}${r.note ? "｜" + esc(r.note) : ""}</span></td>
          <td data-label="產業別"><span class="tag">${esc(state.index.industries[r.industry])}</span></td>
          <td data-label="違反條文">${r.arts.map((a) => `<span class="law" title="${esc(ARTICLES[a] || "")}">${esc(articleLabel(a))}</span>`).join("")}
            <span class="text" title="${esc(r.texts.join("；"))}">${esc(r.texts.join("；"))}</span></td>
          <td data-label="罰鍰" class="num money">${fmt.format(r.amount)}</td></tr>`).join("")
      : `<tr><td colspan="6" class="empty">查無符合條件的裁罰紀錄</td></tr>`;

    $("pager").innerHTML = pages > 1
      ? `<button type="button" data-page="1" ${state.page === 1 ? "disabled" : ""} aria-label="第一頁">«</button>
         <button type="button" data-page="${state.page - 1}" ${state.page === 1 ? "disabled" : ""} aria-label="上一頁">‹</button>
         <span>${state.page} / ${pages}</span>
         <button type="button" data-page="${state.page + 1}" ${state.page === pages ? "disabled" : ""} aria-label="下一頁">›</button>
         <button type="button" data-page="${pages}" ${state.page === pages ? "disabled" : ""} aria-label="最後一頁">»</button>`
      : "";
  }

  function downloadCSV() {
    const rows = filtered().slice().sort((a, b) => b.date - a.date);
    const head = ["處分日期(民國)", "公告日期(民國)", "主管機關", "事業單位名稱或負責人", "產業別(推估)", "違反條文", "違反內容", "罰鍰金額", "處分字號", "備註"];
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [head.map(q).join(",")].concat(rows.map((r) => [
      roc(r.date), r.announce ? roc(r.announce) : "", r.authority, r.name, state.index.industries[r.industry],
      r.laws.join("；"), r.texts.join("；"), r.amount, r.doc, r.note,
    ].map(q).join(",")));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `勞基法裁罰_${$("county").selectedOptions[0].textContent}_${getYM("from") - 191100}-${getYM("to") - 191100}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ── 事件 ───────────────────────────── */
  function bind() {
    $("searchForm").addEventListener("submit", (e) => {
      e.preventDefault();
      state.lawFilter = ""; state.entityFilter = ""; state.industryPick = "";
      runQuery();
    });
    $("resetBtn").addEventListener("click", () => {
      $("county").value = ALL; $("industry").value = ""; $("keyword").value = "";
      state.lawFilter = ""; state.entityFilter = ""; state.industryPick = "";
      setDefaultRange(); runQuery();
    });
    $("chips").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      state[b.dataset.k] = ""; state.page = 1; writeHash(); render();
    });
    const rankHandler = (field) => (e) => {
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      const li = e.target.closest("li[data-key]"); if (!li) return;
      e.preventDefault();
      state[field] = String(state[field]) === li.dataset.key ? "" : li.dataset.key;
      state.page = 1; writeHash(); render();
    };
    for (const [id, field] of [["industryRank", "industryPick"], ["lawRank", "lawFilter"]]) {
      $(id).addEventListener("click", rankHandler(field));
      $(id).addEventListener("keydown", rankHandler(field));
    }
    $("repeatBody").addEventListener("click", (e) => {
      const b = e.target.closest("[data-entity]"); if (!b) return;
      state.entityFilter = b.dataset.entity; state.page = 1; writeHash(); render();
      $("h-detail").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("pager").addEventListener("click", (e) => {
      const b = e.target.closest("[data-page]"); if (!b || b.disabled) return;
      state.page = Number(b.dataset.page); renderDetail(filtered());
      $("h-detail").scrollIntoView({ block: "start" });
    });
    document.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.sort;
      state.sort = { key: k, dir: state.sort.key === k && state.sort.dir === "desc" ? "asc" : "desc" };
      renderDetail(filtered());
    }));
    $("csvBtn").addEventListener("click", downloadCSV);

    const root = document.documentElement;
    const tbtn = $("themeToggle");
    const isDark = () => root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const syncLabel = () => { tbtn.textContent = isDark() ? "淺色" : "深色"; };
    try { const t = localStorage.getItem("theme"); if (t) root.dataset.theme = t; } catch (_) { /* 無法使用 localStorage */ }
    syncLabel();
    tbtn.addEventListener("click", () => {
      root.dataset.theme = isDark() ? "light" : "dark";
      try { localStorage.setItem("theme", root.dataset.theme); } catch (_) { /* ignore */ }
      syncLabel();
    });
  }

  async function init() {
    bind();
    try {
      state.index = await loadJSON("data/index.json");
    } catch (err) {
      $("metaLine").textContent = "索引檔讀取失敗：" + err.message + "（請透過網頁伺服器開啟，而非直接開啟檔案）";
      return;
    }
    const idx = state.index;
    const last = latestYM();
    $("metaLine").textContent =
      `收錄 ${fmt.format(idx.total)} 筆勞基法裁罰紀錄｜處分日期至民國 ${Math.floor(last / 100) - 1911} 年 ${last % 100} 月｜資料更新：${idx.updatedAt}`;
    buildForm();
    readHash();
    await runQuery();
  }

  init();
})();
